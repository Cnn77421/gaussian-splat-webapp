"""Retry HTTP and input retention regressions; isolated data, no GPU execution."""
import importlib.util
import contextlib
import io
import http.client
import json
from pathlib import Path
import shutil
import signal
import tempfile
import threading
import unittest
from unittest import mock


class RetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="splat-retry-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        isolated = self.root / "server.py"
        shutil.copyfile(Path(__file__).resolve().parents[1] / "server.py", isolated)
        spec = importlib.util.spec_from_file_location("retry_server", isolated)
        self.s = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.s)
        self.http = self.s.SplatHTTPServer(("127.0.0.1", 0), self.s.Handler)
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.http.server_address[1], timeout=3)
        try:
            conn.request(method, path, body=body, headers={"X-Filename": "clip.mp4"})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def failed(self, images=False, missing=False):
        job = self.s.new_job("frames.zip" if images else "clip.mp4", "high")
        job.update(status="failed", percent=96.1, error="device lost", log=["previous error"])
        if not missing:
            base = self.s.UPLOAD_DIR / job["id"]
            base.mkdir()
            source = base / ("images" if images else "clip.mp4")
            if images:
                source.mkdir()
                (source / "1.png").write_bytes(b"frame 1")
                (source / "2.jpg").write_bytes(b"frame 2")
            else:
                source.write_bytes(b"original video")
            job["inputPath"] = str(source)
        self.s._save_jobs()
        return job

    def test_reuse_creates_new_queued_attempt_and_prevents_duplicates(self):
        parent = self.failed()
        with mock.patch.object(self.s, "start_job") as start:
            code, job = self.request("POST", "/api/jobs/retry?id=" + parent["id"])
            self.assertEqual(code, 202)
            self.assertEqual(job["retryOf"], parent["id"])
            self.assertEqual(job["quality"], "high")
            self.assertEqual(job["percent"], 0)
            self.assertEqual(Path(job["inputPath"]).read_bytes(), b"original video")
            self.assertEqual(parent["status"], "failed")
            self.assertEqual(parent["log"], ["previous error"])
            code, duplicate = self.request("POST", "/api/jobs/retry?id=" + parent["id"])
            self.assertEqual(code, 409)
            self.assertEqual(duplicate["retryJobId"], job["id"])
            start.assert_called_once()
        # Deleting the failed parent must not delete the new attempt's input.
        self.s.delete_job(parent["id"])
        self.assertEqual(Path(job["inputPath"]).read_bytes(), b"original video")

    def test_image_directory_retry_keeps_all_frames(self):
        parent = self.failed(images=True)
        with mock.patch.object(self.s, "start_job"):
            code, job = self.request("POST", "/api/jobs/retry?id=" + parent["id"])
        self.assertEqual(code, 202)
        self.assertEqual(sorted(p.name for p in Path(job["inputPath"]).iterdir()), ["1.png", "2.jpg"])

    def test_missing_source_is_explicit_and_accepts_replacement(self):
        parent = self.failed(missing=True)
        count = len(self.s.list_jobs())
        code, missing = self.request("POST", "/api/jobs/retry?id=" + parent["id"])
        self.assertEqual(code, 409)
        self.assertTrue(missing["sourceMissing"])
        self.assertEqual(len(self.s.list_jobs()), count)
        with mock.patch.object(self.s, "start_job"):
            code, job = self.request("POST", "/api/jobs/retry?id=" + parent["id"] + "&quality=fast", b"replacement")
        self.assertEqual(code, 202)
        self.assertEqual(job["quality"], "high")
        self.assertEqual(job["retryOf"], parent["id"])
        self.assertEqual(Path(job["inputPath"]).read_bytes(), b"replacement")

    def test_unfinished_or_done_jobs_cannot_retry(self):
        job = self.failed()
        for status in ("queued", "running", "done"):
            job["status"] = status
            self.assertEqual(self.request("POST", "/api/jobs/retry?id=" + job["id"])[0], 409)
        self.assertEqual(self.request("POST", "/api/jobs/retry?id=missing")[0], 404)

    def test_retention_survives_failure_reconciliation_and_reload(self):
        job = self.failed()
        source = Path(job["inputPath"])
        project = self.s.PROJECTS_DIR / "fixture"
        (project / "work").mkdir(parents=True)
        (project / "source").mkdir()
        (project / "final.ply").write_bytes(b"incomplete")
        job["projectPath"] = str(project)
        self.s._purge_artifacts(job, keep_input=True)
        self.s._reconcile_uploads()
        self.assertTrue(source.is_file())
        self.assertFalse((project / "work").exists())
        self.assertFalse((project / "final.ply").exists())
        job["status"] = "running"
        self.s._save_jobs()
        self.s._jobs.clear()
        self.s._load_jobs()
        self.assertTrue(self.s.job_snapshot(self.s.get_job(job["id"]))["retryAvailable"])
        self.s._reconcile_uploads()
        self.assertTrue(source.exists())
        self.s.delete_job(job["id"])
        self.assertFalse(source.exists())

    def test_pipeline_failure_keeps_complete_input(self):
        job = self.failed()
        source = Path(job["inputPath"])
        process = mock.Mock(stdout=iter(["Error: device lost\n"]), returncode=1)
        with mock.patch.object(self.s.subprocess, "Popen", return_value=process):
            self.s._run_pipeline(job, source, self.s.WORK_DIR / (job["id"] + ".log"))
        self.assertTrue(source.exists())
        self.assertTrue(self.s.job_snapshot(job)["retryAvailable"])

    def test_outside_or_symlinked_input_is_never_reused(self):
        job = self.failed(missing=True)
        external = self.root / "private.mp4"
        external.write_bytes(b"private")
        job["inputPath"] = str(external)
        self.assertIsNone(self.s._retry_input(job))
        base = self.s.UPLOAD_DIR / job["id"]
        base.mkdir()
        link = base / "clip.mp4"
        link.symlink_to(external)
        job["inputPath"] = str(link)
        self.assertIsNone(self.s._retry_input(job))

    def test_shutdown_diagnostic_records_signal_and_active_job(self):
        job = self.s.new_job("clip.mp4", "fast")
        job.update(status="running", percent=62)
        output = io.StringIO()
        with mock.patch.object(self.s.threading, "Thread") as thread, contextlib.redirect_stderr(output):
            srv = mock.Mock()
            self.s._request_shutdown(srv, signal.SIGTERM)
        record = json.loads(output.getvalue())
        self.assertEqual(record["event"], "shutdown_requested")
        self.assertEqual(record["signal"], "SIGTERM")
        self.assertEqual(record["activeJobs"][0]["id"], job["id"])
        self.assertEqual(record["activeJobs"][0]["percent"], 62)
        self.assertTrue(self.s._SERVER_SHUTTING_DOWN.is_set())
        thread.assert_called_once_with(target=srv.shutdown, daemon=True)

    def test_health_exposes_process_identity_and_connection_count(self):
        code, health = self.request("GET", "/api/health")
        self.assertEqual(code, 200)
        self.assertEqual(health["process"]["instanceId"], self.s._INSTANCE_ID)
        self.assertGreaterEqual(health["process"]["connections"], 1)
        self.assertEqual(health["process"]["maxConnections"], self.s.MAX_CONNECTIONS)


if __name__ == "__main__":
    unittest.main()

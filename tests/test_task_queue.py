"""Scheduling regressions with isolated data and fake engines; no GPU work."""
import fcntl
import http.client
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "server.py"


class TaskQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="splat-queue-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = self.load_server("one")
        self.addCleanup(self.server._shutdown_cleanup)

    def load_server(self, name):
        path = self.root / name / "server.py"
        path.parent.mkdir()
        shutil.copyfile(SOURCE, path)
        spec = importlib.util.spec_from_file_location("queue_server_" + name, path)
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        return server

    def wait_for(self, predicate, seconds=3):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.01)
        self.fail("queue did not reach expected state")

    def test_progress_diagnostic_cannot_reset_measured_percentage(self):
        s = self.server
        job = s.new_job("progress.mp4", "fast")
        s._append_log(job, "54.17% Reconstructing: 正在注册第177张图像")
        s._append_log(job, "45.00% Reconstructing: Bundle adjustment report")
        self.assertEqual(job["percent"], 54.17)
        self.assertEqual(job["message"], "正在注册第177张图像")
        self.assertEqual(len(job["log"]), 2)
        s._append_log(job, "70.88% TrainingSplats: Brush训练中")
        self.assertEqual(job["percent"], 70.88)
        self.assertEqual(job["stage"], "TrainingSplats")

    def test_fifo_single_active_and_failure_does_not_block_next(self):
        s = self.server
        jobs = [s.new_job(f"{i}.mp4", "fast") for i in range(3)]
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        order = []
        counters = {"active": 0, "peak": 0}

        def pipeline(job, *_):
            order.append(job["id"])
            counters["active"] += 1
            counters["peak"] = max(counters["peak"], counters["active"])
            try:
                if job is jobs[0]:
                    entered.set()
                    release.wait(3)
                if job is jobs[1]:
                    raise RuntimeError("engine failed")
                job["status"] = "done"
                if job is jobs[2]:
                    finished.set()
            finally:
                counters["active"] -= 1

        with mock.patch.object(s, "_run_pipeline", pipeline):
            s.start_job(jobs[0], self.root / "0.mp4")
            self.assertTrue(entered.wait(3))
            s.start_job(jobs[1], self.root / "1.mp4")
            s.start_job(jobs[2], self.root / "2.mp4")
            s.start_job(jobs[2], self.root / "2.mp4")  # no duplicate dispatch
            self.assertEqual(s.queue_snapshot(), {"maxConcurrent": 1, "waiting": 2, "running": 1})
            self.assertEqual(s.job_snapshot(jobs[1])["queuePosition"], 1)
            self.assertEqual(s.job_snapshot(jobs[2])["queuePosition"], 2)
            self.assertIsNone(jobs[1]["startedAt"])
            self.assertNotIn("log", s.job_snapshot(jobs[1], include_log=False))
            release.set()
            self.assertTrue(finished.wait(3))
            self.wait_for(lambda: s._queue_current is None)
        self.assertEqual(order, [j["id"] for j in jobs])
        self.assertEqual(counters["peak"], 1)
        self.assertEqual(jobs[1]["status"], "failed")
        self.assertIn("engine failed", jobs[1]["error"])
        self.assertEqual(s.queue_snapshot()["waiting"], 0)
        self.assertIsNone(s.job_snapshot(jobs[2])["queuePosition"])

    def test_other_process_holds_slot_and_uploads_are_not_queue_entries(self):
        s = self.server
        job = s.new_job("one.mp4", "fast")
        self.assertIsNone(s.job_snapshot(job)["queuePosition"])
        self.assertEqual(s.queue_snapshot()["waiting"], 0)
        script = ("import fcntl,sys; f=open(sys.argv[1],'a'); "
                  "fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()")
        proc = subprocess.Popen([sys.executable, "-c", script, str(s.PIPELINE_LOCK_FILE)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        entered = threading.Event()
        try:
            self.assertEqual(proc.stdout.readline().strip(), "locked")
            with mock.patch.object(s, "_run_pipeline", lambda j, *_: (j.update(status="done"), entered.set())):
                s.start_job(job, self.root / "one.mp4")
                self.wait_for(lambda: "另一个入口" in job["message"])
                self.assertFalse(entered.is_set())
                self.assertEqual(job["status"], "queued")
                self.assertIsNone(job["startedAt"])
                self.assertEqual(s.job_snapshot(job)["queuePosition"], 1)
                proc.communicate(timeout=3)
                self.assertTrue(entered.wait(3))
                self.wait_for(lambda: s._queue_current is None)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate(timeout=3)

    def test_two_server_instances_share_the_slot(self):
        s, other = self.server, self.load_server("two")
        self.addCleanup(other._shutdown_cleanup)
        other.PIPELINE_LOCK_FILE = s.PIPELINE_LOCK_FILE
        release, first_started, second_started = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        first, second = s.new_job("a.mp4", "fast"), other.new_job("b.mp4", "fast")

        def pipeline(job, *_):
            first_started.set()
            release.wait(3)
            job["status"] = "done"

        with mock.patch.object(s, "_run_pipeline", pipeline), mock.patch.object(
                other, "_run_pipeline", lambda j, *_: (j.update(status="done"), second_started.set())):
            s.start_job(first, self.root / "a.mp4")
            self.assertTrue(first_started.wait(3))
            other.start_job(second, self.root / "b.mp4")
            self.wait_for(lambda: "另一个入口" in second["message"])
            self.assertFalse(second_started.is_set())
            release.set()
            self.assertTrue(second_started.wait(3))
            self.wait_for(lambda: s._queue_current is None and other._queue_current is None)

    def test_shutdown_does_not_launch_waiting_jobs_or_accept_new_jobs(self):
        s = self.server
        entered = threading.Event()
        jobs = [s.new_job(f"{i}.mp4", "fast") for i in range(2)]
        order = []

        def pipeline(job, *_):
            order.append(job["id"])
            entered.set()
            s._SERVER_SHUTTING_DOWN.wait(3)
            job.update(status="failed", error="stopped")

        with mock.patch.object(s, "_run_pipeline", pipeline):
            s.start_job(jobs[0], self.root / "0.mp4")
            self.assertTrue(entered.wait(3))
            s.start_job(jobs[1], self.root / "1.mp4")
            s._shutdown_cleanup()
        self.assertEqual(order, [jobs[0]["id"]])
        self.assertFalse(s._queue_worker.is_alive())
        self.assertEqual(jobs[1]["status"], "failed")
        self.assertIsNone(jobs[1]["startedAt"])
        self.assertEqual(s.queue_snapshot()["waiting"], 0)
        with self.assertRaises(RuntimeError):
            s.start_job(jobs[1], self.root / "1.mp4")
        saved = json.loads(s.JOBS_FILE.read_text())
        self.assertTrue(all(j["status"] == "failed" for j in saved))
        with s.PIPELINE_LOCK_FILE.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_shutdown_while_waiting_for_other_process_releases_queue(self):
        s = self.server
        with s.PIPELINE_LOCK_FILE.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            job = s.new_job("waiting.mp4", "fast")
            with mock.patch.object(s, "_run_pipeline") as pipeline:
                s.start_job(job, self.root / "waiting.mp4")
                self.wait_for(lambda: "另一个入口" in job["message"])
                s._shutdown_cleanup()
                pipeline.assert_not_called()
        self.assertEqual(job["status"], "failed")
        self.assertIsNone(job["startedAt"])

    def test_http_uploads_report_queue_and_release_next_job(self):
        s = self.server
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        http_server = s.SplatHTTPServer(("127.0.0.1", 0), s.Handler)
        self.addCleanup(http_server.server_close)
        self.addCleanup(http_server.shutdown)
        threading.Thread(target=http_server.serve_forever, daemon=True).start()

        def request(method, path, body=None):
            conn = http.client.HTTPConnection("127.0.0.1", http_server.server_address[1], timeout=3)
            try:
                conn.request(method, path, body=body, headers={"X-Filename": "test.mp4"})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally:
                conn.close()

        def pipeline(job, *_):
            entered.set()
            release.wait(3)
            job["status"] = "done"

        with mock.patch.object(s, "_run_pipeline", pipeline):
            code, first = request("POST", "/api/jobs?quality=fast", b"fake video")
            self.assertEqual(code, 202)
            self.assertTrue(entered.wait(3))
            code, second = request("POST", "/api/jobs?quality=high", b"second fake video")
            self.assertEqual(code, 202)
            self.assertEqual(second["status"], "queued")
            self.assertEqual(second["queuePosition"], 1)
            self.assertIsNone(second["startedAt"])
            self.assertEqual(request("GET", "/api/health")[1]["queue"],
                             {"maxConcurrent": 1, "running": 1, "waiting": 1})
            detail = request("GET", "/api/job?id=" + second["id"])[1]
            self.assertEqual(detail["queuePosition"], 1)
            self.assertIn("log", detail)
            listed = request("GET", "/api/jobs")[1]["jobs"]
            self.assertFalse(any("log" in j for j in listed))
            self.assertEqual(request("DELETE", "/api/jobs?id=" + second["id"])[0], 409)
            release.set()
            self.wait_for(lambda: s._queue_current is None)
            self.assertEqual(request("GET", "/api/job?id=" + second["id"])[1]["status"], "done")


if __name__ == "__main__":
    unittest.main()

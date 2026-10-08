"""CPU-only regressions; all backend data and subprocesses are isolated."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "server.py"


class ReviewFixTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="splat-review-test-")
        self.addCleanup(self.temp.cleanup)
        isolated = Path(self.temp.name) / "server.py"
        shutil.copyfile(SOURCE, isolated)
        spec = importlib.util.spec_from_file_location("isolated_splat_server", isolated)
        self.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.server)

    def test_deleted_job_stays_deleted_after_reload(self):
        s = self.server
        job = s.new_job("sample.mp4", "fast")
        job["status"] = "done"
        s._save_jobs()
        self.assertTrue(s.delete_job(job["id"]))
        s._jobs.clear()
        s._load_jobs()
        self.assertIsNone(s.get_job(job["id"]))

    def test_running_job_cannot_be_deleted(self):
        s = self.server
        job = s.new_job("sample.mp4", "fast")
        job["status"] = "running"
        self.assertFalse(s.delete_job(job["id"]))
        self.assertIsNotNone(s.get_job(job["id"]))

    def test_concurrent_saves_serialize_the_complete_write(self):
        s = self.server
        s.new_job("sample.mp4", "fast")
        original = Path.write_text
        counters = {"active": 0, "peak": 0}
        lock = threading.Lock()
        barrier = threading.Barrier(8)

        def slow_write(path, *args, **kwargs):
            if path != s.JOBS_FILE.with_suffix(".tmp"):
                return original(path, *args, **kwargs)
            with lock:
                counters["active"] += 1
                counters["peak"] = max(counters["peak"], counters["active"])
            try:
                time.sleep(.01)
                return original(path, *args, **kwargs)
            finally:
                with lock:
                    counters["active"] -= 1

        def save():
            barrier.wait()
            s._save_jobs()

        with mock.patch.object(Path, "write_text", slow_write):
            workers = [threading.Thread(target=save) for _ in range(8)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive())
        self.assertEqual(counters["peak"], 1)
        self.assertEqual(len(json.loads(s.JOBS_FILE.read_text())), 1)

    def test_save_failure_is_visible_and_preserves_previous_file(self):
        s = self.server
        s.new_job("sample.mp4", "fast")
        previous = s.JOBS_FILE.read_bytes()
        output = io.StringIO()
        with mock.patch.object(Path, "write_text", side_effect=OSError("disk full")):
            with contextlib.redirect_stderr(output), contextlib.redirect_stdout(output):
                s._save_jobs()
        self.assertIn("disk full", output.getvalue())
        self.assertEqual(s.JOBS_FILE.read_bytes(), previous)

    def run_failure(self, lines):
        s = self.server
        job = s.new_job("junk.mp4", "fast")
        process = mock.Mock(stdout=iter(line + "\n" for line in lines), returncode=1)
        with mock.patch.object(s.subprocess, "Popen", return_value=process):
            s._run_pipeline(job, Path(self.temp.name) / "junk.mp4", s.WORK_DIR / (job["id"] + ".log"))
        self.assertEqual(job["status"], "failed")
        return job["error"]

    def test_failure_uses_decode_error_instead_of_gpu_fallback(self):
        error = self.run_failure([
            "  0.00% Created: 内置 COLMAP 未检测到完整 CUDA 运行时，已使用 CPU",
            "视频无效：FFprobe 无法解码这个文件",
        ])
        self.assertIn("FFprobe", error)
        self.assertNotIn("已使用 CPU", error)

    def test_failure_preserves_english_engine_diagnostic(self):
        error = self.run_failure([
            "62.00% TrainingSplats: Brush 训练中",
            "Error: Vulkan device lost",
            "warning: cleanup finished",
        ])
        self.assertIn("Vulkan device lost", error)

    def test_failure_without_diagnostic_uses_exit_code(self):
        error = self.run_failure(["0.00% Created: 已使用 CPU"])
        self.assertIn("退出码 1", error)
        self.assertNotIn("已使用 CPU", error)


if __name__ == "__main__":
    unittest.main()

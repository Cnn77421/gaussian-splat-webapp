"""HTTP 层加固回归：走私、截断上传、越界静态路径、zip 炸弹、blob 回收。

所有用例都在临时目录里跑独立副本的 server.py，并自带一个真实 HTTP 服务，
不碰后端实例的数据。
"""
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import shutil
import socket
import tempfile
import threading
import unittest
import zipfile


SOURCE = Path(__file__).resolve().parents[1] / "server.py"


class HTTPHardeningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="splat-hardening-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        isolated = self.root / "server.py"
        shutil.copyfile(SOURCE, isolated)
        spec = importlib.util.spec_from_file_location("isolated_splat_server_http",
                                                      isolated)
        self.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.server)
        s = self.server
        (s.WEB_DIR / "index.html").write_text("<html>ok</html>", encoding="utf-8")
        (s.WEB_DIR / "app.js").write_text("//x", encoding="utf-8")
        self.srv = s.SplatHTTPServer(("127.0.0.1", 0), s.Handler)
        self.port = self.srv.server_address[1]
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    # ---- 工具 ----
    def request(self, method, path, body=None, headers=None, timeout=10):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            conn.close()

    def raw(self, payload, wait=5.0):
        sock = socket.create_connection(("127.0.0.1", self.port), 5)
        try:
            sock.settimeout(wait)
            sock.sendall(payload)
            out = b""
            try:
                while True:
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    out += chunk
            except socket.timeout:
                out += b"<TIMEOUT>"
            return out
        finally:
            sock.close()

    def make_done_job(self, payload=b"ply\n" + b"K" * 4096):
        s = self.server
        proj = s.PROJECTS_DIR / "20260101-000000_fixture"
        proj.mkdir(parents=True, exist_ok=True)
        ply = proj / "final.ply"
        ply.write_bytes(payload)
        job = s.new_job("clip.mp4", "fast")
        job.update(status="done", finalPly=str(ply), projectPath=str(proj))
        s._save_jobs()
        return job, ply

    # ---- HEAD / 静态路径 ----
    def test_head_download_sends_headers_without_body(self):
        job, ply = self.make_done_job()
        status, headers, body = self.request("HEAD", f"/api/download?id={job['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(headers["Content-Length"], str(ply.stat().st_size))

    def test_artifact_range_stays_open_ended(self):
        job, ply = self.make_done_job()
        status, headers, body = self.request(
            "GET", f"/api/artifact?id={job['id']}", headers={"Range": "bytes=10-19"})
        self.assertEqual(status, 206)
        self.assertEqual(len(body), 10)
        self.assertTrue(headers["Content-Range"].startswith("bytes 10-19/"))

    def test_static_traversal_outside_web_dir_is_forbidden(self):
        (self.root / "secret.txt").write_text("top-secret", encoding="utf-8")
        for path in ("/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 403)

    def test_static_assets_still_served_with_revalidation(self):
        status, headers, body = self.request("GET", "/app.js")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"//x")
        self.assertEqual(headers["Cache-Control"], "no-cache")

    def test_cors_preflight_advertises_x_filename(self):
        status, headers, _ = self.request("OPTIONS", "/api/jobs")
        self.assertEqual(status, 204)
        allowed = {h.strip().lower()
                   for h in headers["Access-Control-Allow-Headers"].split(",")}
        self.assertIn("x-filename", allowed)

    # ---- 请求体处理 ----
    def test_invalid_content_length_is_rejected(self):
        out = self.raw(b"POST /api/jobs HTTP/1.1\r\nHost: x\r\n"
                       b"Content-Length: abc\r\nConnection: close\r\n\r\n")
        self.assertIn(b"HTTP/1.1 400", out)

    def test_oversized_content_length_is_rejected(self):
        out = self.raw(b"POST /api/jobs HTTP/1.1\r\nHost: x\r\n"
                       b"Content-Length: 5000000000\r\nConnection: close\r\n\r\n")
        self.assertIn(b"HTTP/1.1 413", out)

    def test_truncated_upload_fails_and_clears_staging(self):
        payload = (b"POST /api/jobs HTTP/1.1\r\nHost: x\r\nX-Filename: t.mp4\r\n"
                   b"Content-Length: 1000\r\nConnection: close\r\n\r\n" + b"A" * 10)
        sock = socket.create_connection(("127.0.0.1", self.port), 5)
        try:
            sock.settimeout(5)
            sock.sendall(payload)
            sock.shutdown(socket.SHUT_WR)
            out = b""
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                out += chunk
        finally:
            sock.close()
        self.assertIn(b"HTTP/1.1 400", out)
        self.assertIn("上传中断".encode(), out)
        staging = self.server.UPLOAD_DIR / "staging"
        self.assertEqual(list(staging.iterdir()), [])

    def test_unconsumed_body_is_drained_before_next_request(self):
        out = self.raw(b"POST /nope HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n"
                       b"Connection: keep-alive\r\n\r\nAAAA"
                       b"GET /api/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        self.assertIn(b"HTTP/1.1 404", out)
        # 第二个请求必须被正确解析，而不是被残留的 AAAA 打乱
        self.assertIn(b"HTTP/1.1 200", out)
        self.assertNotIn(b"<TIMEOUT>", out)

    def test_connection_cap_returns_503(self):
        original = self.server.MAX_CONNECTIONS
        self.server.MAX_CONNECTIONS = 0
        self.addCleanup(setattr, self.server, "MAX_CONNECTIONS", original)
        status, _, _ = self.request("GET", "/api/health")
        self.assertEqual(status, 503)

    def test_discard_request_body_bounds_length_and_detects_truncation(self):
        s = self.server
        self.assertFalse(s._discard_request_body(io.BytesIO(b"x" * 16), 16, limit=8),
                         "超过上限的 body 只能关连接")
        self.assertTrue(s._discard_request_body(io.BytesIO(b"x" * 8), 8, limit=8))
        self.assertFalse(s._discard_request_body(io.BytesIO(b"x" * 4), 10, limit=8),
                         "实收不足声明的 body 必须判定为不可复用")
        self.assertTrue(s._discard_request_body(io.BytesIO(b""), 0, limit=8))

    # ---- zip 防线 ----
    def zip_bytes(self, entries):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for name, data in entries:
                zf.writestr(name, data)
        return buf.getvalue()

    def test_zip_rejects_non_image_content(self):
        src = self.root / "plain.zip"
        src.write_bytes(self.zip_bytes([("readme.txt", b"hi")]))
        with self.assertRaises(self.server.UploadError) as ctx:
            self.server._extract_zip(src, self.root / "out1")
        self.assertIn("没有图片", str(ctx.exception))

    def test_zip_rejects_too_many_entries(self):
        s = self.server
        original = s.MAX_ZIP_ENTRIES
        s.MAX_ZIP_ENTRIES = 2
        self.addCleanup(setattr, s, "MAX_ZIP_ENTRIES", original)
        src = self.root / "many.zip"
        src.write_bytes(self.zip_bytes([(f"{i}.png", b"x") for i in range(3)]))
        with self.assertRaises(s.UploadError) as ctx:
            s._extract_zip(src, self.root / "out2")
        self.assertIn("图片过多", str(ctx.exception))

    def test_zip_rejects_declared_amplification(self):
        s = self.server
        original = s.MAX_ZIP_TOTAL_BYTES
        s.MAX_ZIP_TOTAL_BYTES = 4096
        self.addCleanup(setattr, s, "MAX_ZIP_TOTAL_BYTES", original)
        src = self.root / "bomb.zip"
        src.write_bytes(self.zip_bytes([("big.png", b"\0" * 100000)]))
        with self.assertRaises(s.UploadError) as ctx:
            s._extract_zip(src, self.root / "out3")
        self.assertIn("体积过大", str(ctx.exception))

    def test_zip_extracts_images_and_ignores_subdirectories(self):
        s = self.server
        src = self.root / "scene.zip"
        src.write_bytes(self.zip_bytes([("nested/deep/frame.png", b"PNGDATA"),
                                        ("notes.txt", b"skip")]))
        frames = s._extract_zip(src, self.root / "out4")
        self.assertEqual([p.name for p in frames.iterdir()], ["frame.png"])

    # ---- blob 回收 / 去重 ----
    def test_gc_blobs_keeps_referenced_blob_and_drops_orphans(self):
        s = self.server
        data = b"shared-frame-bytes" * 10
        digest = hashlib.sha256(data).hexdigest()
        blob = s._blob_path(digest, ".mp4")
        blob.parent.mkdir(parents=True, exist_ok=True)
        blob.write_bytes(data)
        proj = s.PROJECTS_DIR / "20260101-111111_ref"
        (proj / "source").mkdir(parents=True)
        (proj / "source" / "clip.mp4").hardlink_to(blob)
        orphan = s._blob_path(hashlib.sha256(b"nobody").hexdigest(), ".mp4")
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_bytes(b"nobody")

        s._gc_blobs()

        self.assertTrue(blob.exists(), "仍被项目引用的 blob 不能被删")
        self.assertFalse(orphan.exists(), "无引用的 blob 应被删除")

    def test_dedup_sources_collapses_duplicate_copies(self):
        s = self.server
        payload = b"duplicate-input" * 64
        digest = hashlib.sha256(payload).hexdigest()
        blob = s._blob_path(digest, ".mp4")
        blob.parent.mkdir(parents=True, exist_ok=True)
        blob.write_bytes(payload)
        for name in ("20260101-120000_a", "20260101-120001_b"):
            d = s.PROJECTS_DIR / name / "source"
            d.mkdir(parents=True)
            shutil.copyfile(blob, d / "clip.mp4")
        before = (s.PROJECTS_DIR / "20260101-120001_b" / "source"
                  / "clip.mp4").stat().st_ino

        s._dedup_sources()

        ref = s.PROJECTS_DIR / "20260101-120000_a" / "source" / "clip.mp4"
        dup = s.PROJECTS_DIR / "20260101-120001_b" / "source" / "clip.mp4"
        self.assertEqual(ref.stat().st_ino, blob.stat().st_ino)
        self.assertEqual(dup.stat().st_ino, blob.stat().st_ino)
        self.assertNotEqual(before, blob.stat().st_ino)
        blobs = [p for p in s.BLOB_DIR.rglob("*") if p.is_file()]
        self.assertEqual(len(blobs), 1)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SplatApp 后端 —— 把 ooosplat 的 splatstudio CLI 包成 HTTP API。

设计目标：黑客松最快可用。后端只做四件事：
  1. 接收上传的素材（视频 / zip 图片集），按内容哈希去重后落到 data/uploads/<job_id>/
  2. 后台调用 splatstudio generate，实时解析进度行
  3. 把进度、产物（final.ply）暴露给前端
  4. 回收派生数据：失败任务自动清理，完成后按策略剪掉 work/，并按配额淘汰旧任务

前端是可替换的：所有能力都通过 /api/* 暴露，任何前端（含你后期自己的）只要按此契约调用即可。

磁盘占用策略（实现见“清理与配额”一节）：
  - 相同内容的素材只保留一份物理拷贝（data/blobs/ 内容寻址 + 硬链接）。
  - 任务成功后删除 projects/<id>/work/（COLMAP / Brush 中间数据），--keep-work 可保留。
  - 失败或中断时回收派生数据，保留完整上传输入以便重试；不完整的上传仍会清理。
  - 超过 --max-jobs / --max-data-gb 时，从最旧的已完成任务开始淘汰。

启动：python3 server.py [--port 8848] [--keep-work] [--prune-source]
"""

from __future__ import annotations

import argparse
from collections import deque
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import struct
import sys
import threading
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

# ---------------------------------------------------------------- 配置

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DATA_DIR = Path(os.environ.get("SPLAT_DATA_DIR") or ROOT / "data").expanduser().resolve()
UPLOAD_DIR = DATA_DIR / "uploads"
PROJECTS_DIR = DATA_DIR / "projects"
WORK_DIR = Path(os.environ.get("SPLAT_WORK_DIR") or ROOT / "work").expanduser().resolve()
# Shared by the CPU and GPU web entry points: Brush uses the same physical GPU.
PIPELINE_LOCK_FILE = ROOT / ".gpu-pipeline.lock"
RUN_OOO = ROOT.parent / "ooosplat-test" / "run-ooo.sh"

QUALITIES = {"fast", "balanced", "high"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _env_int(name: str, default: int) -> int:
    try:
        return int((os.environ.get(name) or "").strip() or default)
    except ValueError:
        return default


def _env_flag(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes", "on")


MAX_UPLOAD = 4 * 1024 * 1024 * 1024  # 4 GiB
# zip 解包防线：条目数、单条解压上限与整包解压总量（防 zip 炸弹放大）
MAX_ZIP_ENTRIES = _env_int("SPLAT_MAX_ZIP_ENTRIES", 2000)
MAX_ZIP_ENTRY_BYTES = _env_int("SPLAT_MAX_ZIP_ENTRY_BYTES", 256 * 1024 ** 2)
MAX_ZIP_TOTAL_BYTES = _env_int("SPLAT_MAX_ZIP_TOTAL_BYTES", 2 * 1024 ** 3)
# 连接上限与读超时：半开连接（声明巨大 Content-Length 后不发数据）会占满线程
MAX_CONNECTIONS = _env_int("SPLAT_MAX_CONNECTIONS", 32)
SOCKET_TIMEOUT = _env_int("SPLAT_SOCKET_TIMEOUT", 60)
UPLOAD_TIMEOUT = _env_int("SPLAT_UPLOAD_TIMEOUT", 600)   # 单次上传的墙钟上限（秒）


BLOB_DIR = DATA_DIR / "blobs"
# 配额：任务数上限与 data/ 字节上限，超出后从最旧的任务开始淘汰
MAX_JOBS = _env_int("SPLAT_MAX_JOBS", 20)
MAX_DATA_BYTES = _env_int("SPLAT_MAX_DATA_BYTES", 50 * 1024 ** 3)
# 保留策略：默认剪掉中间产物 work/；source/ 需显式开启剪除
KEEP_WORK = _env_flag("SPLAT_KEEP_WORK")
PRUNE_SOURCE = _env_flag("SPLAT_PRUNE_SOURCE")

for d in (WEB_DIR, UPLOAD_DIR, PROJECTS_DIR, WORK_DIR, BLOB_DIR):
    d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- 任务状态

_progress_re = re.compile(r"^\s*([\d.]+)%\s+([A-Za-z]+):\s*(.*)$")

STAGE_LABELS = {
    "Created": "创建任务",
    "ProbingVideo": "读取素材",
    "PlanningFrames": "规划抽帧",
    "ExtractingFrames": "抽取画面",
    "ExtractingFeatures": "特征提取",
    "Matching": "特征匹配",
    "Reconstructing": "相机重建",
    "ValidatingReconstruction": "校验重建",
    "BridgeBackfill": "桥接补帧",
    "TrainingSplats": "高斯训练",
    "Exporting": "导出模型",
    "Completed": "全部完成",
}

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_jobs_save_lock = threading.Lock()
_CONN_LOCK = threading.Lock()
_blob_lock = threading.Lock()
_retry_lock = threading.RLock()
_INSTANCE_ID = uuid.uuid4().hex[:12]
_SERVER_STARTED_AT = time.time()



JOBS_FILE = DATA_DIR / "jobs.json"


def _now() -> float:
    return time.time()


def _diagnostic(event: str, **details) -> None:
    """Lifecycle and failed request evidence must survive buffered stdout."""
    record = {"event": event, "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "pid": os.getpid(), "parentPid": os.getppid(), "instanceId": _INSTANCE_ID,
              "uptimeSeconds": round(_now() - _SERVER_STARTED_AT, 2), **details}
    print(json.dumps(record, ensure_ascii=False), file=sys.stderr, flush=True)


def _request_shutdown(srv, signum: int) -> None:
    _diagnostic("shutdown_requested", signal=signal.Signals(signum).name,
                activeJobs=[{"id": j["id"], "status": j["status"], "percent": j.get("percent")}
                            for j in list_jobs() if j["status"] in ("running", "queued")])
    _SERVER_SHUTTING_DOWN.set()
    threading.Thread(target=srv.shutdown, daemon=True).start()


def new_job(filename: str, quality: str) -> dict:
    jid = uuid.uuid4().hex[:12]
    job = {
        "id": jid,
        "filename": filename,
        "quality": quality,
        "status": "queued",          # queued|running|done|failed
        "stage": None,
        "stageLabel": None,
        "percent": 0.0,
        "message": "",
        "log": [],
        "createdAt": _now(),
        "startedAt": None,
        "finishedAt": None,
        "projectId": None,
        "projectPath": None,
        "inputPath": None,
        "finalPly": None,
        "returncode": None,
        "stats": None,
        "error": None,
    }
    with _jobs_lock:
        _jobs[jid] = job
    _save_jobs()
    return job


def get_job(jid: str) -> dict | None:
    with _jobs_lock:
        return _jobs.get(jid)


def list_jobs() -> list[dict]:
    with _jobs_lock:
        return sorted(_jobs.values(), key=lambda j: j["createdAt"], reverse=True)


def _save_jobs() -> None:
    """把内存中的任务快照落盘，服务重启后可恢复（含已完成产物）。"""
    # 序列化整个写入过程，避免不同线程覆盖/替换同一个临时文件。
    with _jobs_save_lock:
        try:
            tmp = JOBS_FILE.with_suffix(".tmp")
            with _jobs_lock:
                data = json.dumps(list(_jobs.values()), ensure_ascii=False)
            tmp.write_text(data, encoding="utf-8")
            tmp.replace(JOBS_FILE)
        except Exception as exc:                         # noqa: BLE001
            print(f"任务记录保存失败: {exc}", file=sys.stderr, flush=True)


def _load_jobs() -> None:
    if not JOBS_FILE.is_file():
        return
    try:
        jobs = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
    except Exception:                                    # noqa: BLE001
        return
    for job in jobs:
        # 重启后不可能还有进程在跑：把 running/queued 标为失败，避免前端永远等待
        if job.get("status") in ("running", "queued"):
            job["status"] = "failed"
            job["error"] = "服务重启，任务已中断"
            _purge_artifacts(job, keep_input=True)
        _jobs[job["id"]] = job


def _append_log(job: dict, line: str) -> None:
    if os.environ.get("SPLAT_COLMAP_GPU") == "1":
        # The opt-in adapter overrides the old engine's CPU decision. Keep the
        # progress honest about a request; completion is recorded by the adapter.
        line = line.replace("CPU 特征提取完成", "特征提取完成（GPU 请求，实际后端见运行报告）")
        line = line.replace("CPU 特征提取", "GPU 特征提取请求")
        line = line.replace("CPU 顺序匹配", "GPU 顺序匹配请求")
        line = line.replace("CPU 穷举匹配", "GPU 穷举匹配请求")
    with _jobs_lock:
        job["log"].append(line)
        if len(job["log"]) > 400:
            del job["log"][:200]
        m = _progress_re.match(line)
        if m:
            pct, stage, msg = float(m.group(1)), m.group(2), m.group(3).strip()
            # Ordinary engine diagnostics carry the start percentage of a stage.
            # Preserve them in the log without resetting measured progress.
            if math.isfinite(pct) and pct >= job.get("percent", 0):
                job["percent"] = min(100.0, pct)
                job["stage"] = stage
                job["stageLabel"] = STAGE_LABELS.get(stage, stage)
                if msg:
                    job["message"] = msg


def _pipeline_error(job: dict, returncode: int) -> str:
    """选择引擎诊断，而非把最后一条正常进度提示当作失败原因。"""
    for raw in reversed(job.get("log", [])):
        line = raw.strip()
        if not line or _progress_re.match(line) or re.match(r"^(?:warning\b|警告)", line, re.I):
            continue
        if re.search(r"错误|失败|无效|无法|异常|\b(?:error|fatal|failed|invalid|exception|panic)\b", line, re.I):
            return line[:1000]
    return f"splatstudio 退出码 {returncode}，详情见任务日志"

_PROCS: dict[str, subprocess.Popen] = {}
_PROCS_LOCK = threading.Lock()
_SERVER_SHUTTING_DOWN = threading.Event()
_queue_condition = threading.Condition()
_pending_jobs: deque[tuple[dict, Path]] = deque()
_queue_current: dict | None = None
_queue_worker: threading.Thread | None = None


def job_snapshot(job: dict, include_log: bool = True) -> dict:
    """Expose a live queue position, without persisting stale positions."""
    with _queue_condition:
        waiting = ([_queue_current] if _queue_current and
                   _queue_current.get("status") == "queued" else [])
        waiting += [item[0] for item in _pending_jobs]
        position = next((i + 1 for i, item in enumerate(waiting)
                         if item["id"] == job["id"]), None)
        with _jobs_lock:
            result = {k: v for k, v in job.items() if include_log or k != "log"}
            if include_log:
                result["log"] = list(job.get("log", []))
        result["queuePosition"] = position if result["status"] == "queued" else None
        if result["status"] == "failed":
            result["retryAvailable"] = _retry_input(job) is not None
            active = _active_retry(job["id"])
            result["retryJobId"] = active["id"] if active else None
        return result


def queue_snapshot() -> dict:
    with _queue_condition:
        waiting = len(_pending_jobs) + int(bool(_queue_current and
                                               _queue_current.get("status") == "queued"))
        return {"maxConcurrent": 1, "waiting": waiting,
                "running": int(bool(_queue_current and
                                    _queue_current.get("status") == "running"))}


@contextmanager
def _pipeline_slot(job: dict):
    """Serialize whole pipelines across local server processes, including cleanup.

    Keep the lock file in place: unlinking it would allow a second inode/lock.
    A crashed server releases its flock automatically.
    """
    with PIPELINE_LOCK_FILE.open("a") as lock:
        while not _SERVER_SHUTTING_DOWN.is_set():
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                job["message"] = "等待显卡空闲，另一个入口正在处理任务"
                _SERVER_SHUTTING_DOWN.wait(0.2)
        else:
            raise RuntimeError("服务停止，任务未开始")
        try:
            if _SERVER_SHUTTING_DOWN.is_set():
                raise RuntimeError("服务停止，任务未开始")
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _queue_loop() -> None:
    global _queue_current
    while True:
        with _queue_condition:
            _queue_condition.wait_for(lambda: _pending_jobs or _SERVER_SHUTTING_DOWN.is_set())
            if _SERVER_SHUTTING_DOWN.is_set():
                return
            job, input_path = _pending_jobs.popleft()
            _queue_current = job
        try:
            with _pipeline_slot(job):
                with _queue_condition:
                    job["status"] = "running"
                    job["startedAt"] = _now()
                    job["stageLabel"] = "准备生成"
                    job["message"] = "开始处理素材"
                _save_jobs()
                _run_pipeline(job, input_path, WORK_DIR / f"{job['id']}.log")
        except Exception as exc:  # An unexpected failure must not strand the queue.
            job["status"] = "failed"
            job["error"] = str(exc) if _SERVER_SHUTTING_DOWN.is_set() else f"任务调度失败：{exc}"
            job["finishedAt"] = _now()
            try:
                _purge_artifacts(job, keep_input=True)
                _save_jobs()
                _gc_blobs()
            except Exception as cleanup_error:
                print(f"排队任务清理失败: {cleanup_error}", file=sys.stderr, flush=True)
        finally:
            with _queue_condition:
                _queue_current = None
                _queue_condition.notify_all()


def _register_proc(jid: str, proc: subprocess.Popen) -> None:
    with _PROCS_LOCK:
        _PROCS[jid] = proc
        stopping = _SERVER_SHUTTING_DOWN.is_set()
    if stopping:
        _terminate(proc)


def _unregister_proc(jid: str, proc: subprocess.Popen | None) -> None:
    with _PROCS_LOCK:
        if _PROCS.get(jid) is proc:
            _PROCS.pop(jid, None)


def _signal_group(proc: subprocess.Popen, sig: int) -> None:
    """给整个进程组发信号：splatstudio 会 fork colmap/brush 等孙进程。"""
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except OSError:
        try:
            proc.send_signal(sig)
        except OSError:
            pass


def _terminate(proc: subprocess.Popen | None, grace: float = 5.0) -> None:
    """先 SIGTERM 整个进程组，宽限期后 SIGKILL。"""
    if proc is None or proc.poll() is not None:
        return
    _signal_group(proc, signal.SIGTERM)
    try:
        proc.wait(timeout=grace)
        return
    except subprocess.TimeoutExpired:
        pass
    _signal_group(proc, signal.SIGKILL)
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        pass


def _terminate_running() -> None:
    with _PROCS_LOCK:
        procs = list(_PROCS.values())
    for p in procs:
        _terminate(p)

def _run_pipeline(job: dict, input_path: Path, log_path: Path) -> None:
    """后台线程：调用 splatstudio generate，实时解析进度。"""
    job["status"] = "running"
    job["startedAt"] = _now()
    created_before = _projects_snapshot()                # 用于认领本次新建的项目目录
    cmd = [
        str(RUN_OOO), "generate", str(input_path),
        "--projects-root", str(PROJECTS_DIR),
        "--quality", job["quality"],
    ]
    proc: subprocess.Popen | None = None
    try:
        with open(log_path, "w", encoding="utf-8") as logf:
            if _SERVER_SHUTTING_DOWN.is_set():
                raise RuntimeError("服务停止，任务已中断")
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, cwd=str(ROOT.parent),
                start_new_session=True,                  # 独立进程组，退出时可整组回收
            )
            _register_proc(job["id"], proc)
            json_lines: list[str] = []
            in_json = False
            for raw in proc.stdout:                      # type: ignore[union-attr]
                line = raw.rstrip("\n")
                logf.write(line + "\n")
                logf.flush()
                _append_log(job, line)
                # 末端的 JSON 结果块：从第一个以 { 开头的行开始收集
                if not in_json and line.strip() == "{":
                    in_json = True
                if in_json:
                    json_lines.append(line)
            proc.wait()
            job["returncode"] = proc.returncode
        assert proc is not None

        # 解析结果 JSON
        if json_lines:
            try:
                stats = json.loads("\n".join(json_lines))
                job["stats"] = stats
                job["projectId"] = stats.get("projectId")
                job["projectPath"] = stats.get("projectPath")
                job["finalPly"] = stats.get("finalPly")
                _attach_quality_report(job)
            except json.JSONDecodeError as exc:
                job["error"] = f"解析结果 JSON 失败: {exc}"

        if proc.returncode == 0 and job.get("finalPly"):
            _attach_source_view(job)
            job["status"] = "done"
            job["percent"] = 100.0
            job["stage"] = "Completed"
            job["stageLabel"] = STAGE_LABELS["Completed"]
            job["message"] = "全部处理完成"
        else:
            job["status"] = "failed"
            if not job["error"]:
                job["error"] = _pipeline_error(job, proc.returncode)
    except Exception as exc:                             # noqa: BLE001
        job["status"] = "failed"
        job["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if _SERVER_SHUTTING_DOWN.is_set():
            job["status"] = "failed"
            job["error"] = "服务停止，任务已中断"
        _unregister_proc(job["id"], proc)
        job["finishedAt"] = _now()
        if not job.get("projectPath"):
            _adopt_project(job, input_path, created_before)
        if job["status"] == "done":
            _prune_project(job)
        else:
            _purge_artifacts(job, keep_input=True)       # 保留原输入供重试，清理训练派生数据
        _save_jobs()
        evicted = _enforce_quota()
        if evicted:
            print(f"已按配额淘汰 {len(evicted)} 个旧任务: {', '.join(evicted)}")
        _gc_blobs()


def start_job(job: dict, input_path: Path) -> None:
    global _queue_worker
    with _queue_condition:
        if _SERVER_SHUTTING_DOWN.is_set():
            raise RuntimeError("服务正在停止，请稍后重新提交")
        if (_queue_current and _queue_current["id"] == job["id"] or
                any(item[0]["id"] == job["id"] for item in _pending_jobs)):
            return
        job["status"] = "queued"
        job["queuedAt"] = _now()
        job["stageLabel"] = "排队中"
        job["message"] = "等待前面的任务完成"
        _pending_jobs.append((job, input_path))
        _save_jobs()
        if _queue_worker is None or not _queue_worker.is_alive():
            _queue_worker = threading.Thread(target=_queue_loop, name="splat-pipeline-queue", daemon=True)
            _queue_worker.start()
        _queue_condition.notify_all()


def _retry_input(job: dict) -> Path | None:
    """Only reuse the complete, managed upload originally assigned to this job."""
    raw = job.get("inputPath")
    if not raw:
        return None
    try:
        path = Path(raw).resolve()
        root = (UPLOAD_DIR / job["id"]).resolve()
        root.relative_to(UPLOAD_DIR.resolve())
        path.relative_to(root)
        if path.is_file() and path.suffix.lower() in VIDEO_EXT | IMAGE_EXT and path.stat().st_size > 0:
            return path
        if path.is_dir():
            files = list(path.iterdir())
            if files and all(f.is_file() and f.suffix.lower() in IMAGE_EXT and
                             f.stat().st_size > 0 and not f.is_symlink() and
                             path in f.resolve().parents for f in files):
                return path
    except (OSError, ValueError):
        pass
    return None


def _active_retry(jid: str) -> dict | None:
    return next((job for job in list_jobs() if job.get("retryOf") == jid and
                 job["status"] in ("queued", "running")), None)


def _copy_retry_input(parent: dict, job: dict) -> Path:
    source = _retry_input(parent)
    if source is None:
        raise FileNotFoundError("原素材已被清理，请重新选择素材")
    target = UPLOAD_DIR / job["id"] / source.name
    target.parent.mkdir(parents=True, exist_ok=True)
    with _blob_lock:
        if source.is_dir():
            shutil.copytree(source, target, copy_function=lambda src, dst: _link_or_copy(Path(src), Path(dst)))
        else:
            _link_or_copy(source, target)
    return target


def _attach_quality_report(job: dict) -> None:
    """Expose actual adapter parameters, which can differ from native state.json."""
    raw = job.get("projectPath")
    if not raw:
        return
    project = Path(raw).resolve()
    if PROJECTS_DIR.resolve() not in project.parents:
        return
    report = {}
    for name in ("training", "reconstruction", "colmap"):
        path = project / "logs" / f"quality-{name}.json"
        try:
            value = json.loads(path.read_text())
            if isinstance(value, dict):
                report[name] = value
        except (OSError, ValueError):
            continue
    if report:
        job["qualityReport"] = report

# ---------------------------------------------------------------- 清理与配额

def _source_camera(model: Path) -> dict | None:
    """Read the first registered shooting pose from the actual training model.

    COLMAP stores world-to-camera R,t: C=-R^T t, forward=R^T Z,
    up=R^T(-Y). Brush PLY stays in this coordinate space; the browser applies
    its PLY display rotation once. No camera/path binary is sent to clients.
    """
    counts = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12,
              7: 5, 8: 4, 9: 5, 10: 12, 11: 16}
    cameras = {}
    def unpack(file, fmt):
        return struct.unpack(fmt, file.read(struct.calcsize(fmt)))
    with (model / "cameras.bin").open("rb") as f:
        n, = unpack(f, "<Q")
        if n > 100000:
            raise ValueError("invalid camera count")
        for _ in range(n):
            cid, kind, width, height = unpack(f, "<iiQQ")
            params = unpack(f, "<" + "d" * counts[kind])
            fy = params[0] if kind in (0, 2, 3, 8, 9) else params[1]
            if math.isfinite(fy) and fy > 0 and height > 0:
                cameras[cid] = math.degrees(2 * math.atan(height / (2 * fy)))
    poses = []
    with (model / "images.bin").open("rb") as f:
        n, = unpack(f, "<Q")
        if n > 100000:
            raise ValueError("invalid image count")
        size = (model / "images.bin").stat().st_size
        for _ in range(n):
            iid, *values = unpack(f, "<i7di")
            name = bytearray()
            while True:
                char = f.read(1)
                if not char or len(name) > 4096:
                    raise ValueError("invalid image name")
                if char == b"\0":
                    break
                name.extend(char)
            points, = unpack(f, "<Q")
            if f.tell() + points * 24 > size:
                raise ValueError("truncated image observations")
            f.seek(points * 24, 1)
            q, t, cid = values[:4], values[4:7], values[7]
            length = math.hypot(*q)
            if cid not in cameras or not all(math.isfinite(v) for v in q + t) or length < 1e-8:
                continue
            w, x, y, z = (v / length for v in q)
            r = [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                 [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                 [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]
            pose = {"coordinateSpace": "colmap", "position": [-sum(r[k][j]*t[k] for k in range(3)) for j in range(3)],
                    "forward": r[2], "up": [-v for v in r[1]], "fov": cameras[cid],
                    "image": Path(name.decode("utf-8", errors="replace")).name}
            poses.append((bytes(name), iid, pose))
    return min(poses, key=lambda item: item[:2])[2] if poses else None


def _attach_source_view(job: dict) -> bool:
    """Keep a tiny pose sidecar before work cleanup, including older jobs."""
    if job.get("sourceView"):
        return False
    raw = job.get("projectPath")
    if not raw:
        return False
    project = Path(raw).resolve()
    if PROJECTS_DIR.resolve() not in project.parents:
        return False
    sidecar = project / "source-view.json"
    try:
        pose = json.loads(sidecar.read_text())
        if pose.get("coordinateSpace") == "colmap":
            job["sourceView"] = pose
            return True
    except (OSError, ValueError, AttributeError):
        pass
    # Use the dataset actually passed to Brush, not a stale undistorted cache.
    corrected = False
    try:
        corrected = json.loads((project / "logs/quality-training.json").read_text()).get("lensDistortionCorrected") is True
    except (OSError, ValueError, AttributeError):
        pass
    candidates = [project / ("work/brush/dataset-undistorted/sparse" if corrected else "work/brush/dataset/sparse/0")]
    for model in candidates:
        try:
            pose = _source_camera(model)
            if pose:
                sidecar.with_suffix(".tmp").write_text(json.dumps(pose, ensure_ascii=False))
                sidecar.with_suffix(".tmp").replace(sidecar)
                job["sourceView"] = pose
                return True
        except (OSError, ValueError, KeyError, struct.error):
            continue
    return False

def _rm(path: Path) -> None:
    """删除文件或目录，失败不抛异常。"""
    try:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _link_or_copy(src: Path, dst: Path) -> None:
    """优先硬链接（同内容零拷贝共享），跨设备时退回复制。"""
    dst.unlink(missing_ok=True)
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _relink_source(proj: Path) -> None:
    """把 splatstudio 复制进 source/ 的素材换回 blob 硬链接。

    splatstudio 会把输入原样复制到 projects/<id>/source/，同一段视频反复提交
    就会留下多份完整副本。这里按内容哈希找到对应 blob（内容寻址，无需额外记账），
    校验通过后改回硬链接，让重复素材真正只占一份磁盘。
    """
    src_dir = proj / "source"
    try:
        if not src_dir.is_dir():
            return
        for cand in src_dir.rglob("*"):
            if not cand.is_file() or cand.stat().st_nlink > 1:
                continue                                  # 已是硬链接，无需处理
            blob = _blob_path(_sha256_file(cand), cand.suffix.lower())
            if blob.is_file():
                _link_or_copy(blob, cand)
    except OSError:
        return


def _blob_path(digest: str, suffix: str) -> Path:
    return BLOB_DIR / digest[:2] / f"{digest}{suffix}"


def _blob_refs() -> set[Path]:
    """data/ 里当前仍然存在的 blob 硬链接路径集合。

    素材以硬链接形式出现在 projects/<id>/source/、uploads/<jid>/ 之下：
    链接数大于 1 的文件必然指向某个 blob，只需把它们的「blob 侧路径」算出来。
    不能只看 st_nlink：blob 与链接一旦分居两次扫描之间，
    或某个链接被复制（copy2 会新建 inode）后，链接数就不再可靠。
    """
    refs: set[Path] = set()
    for root in (PROJECTS_DIR, UPLOAD_DIR):
        try:
            entries = list(root.iterdir())
        except OSError:
            continue
        for sub in entries:
            if not sub.is_dir():
                continue
            try:
                files = [
                    p for p in sub.rglob("*")
                    if p.is_file() and p.stat().st_nlink > 1
                ]
            except OSError:
                continue
            for f in files:
                digest = _sha256_file(f)
                refs.add(_blob_path(digest, f.suffix.lower()))
    return refs


def _gc_blobs() -> None:
    """回收已无任务引用的 blob。

    以「当前实际存在的硬链接」为引用依据，而不是 st_nlink <= 1：
    blob 与引用它的项目目录都只剩一个链接时（例如项目被 prune 掉 source/
    之后 blob 仍是唯一副本），旧实现会永久留着一份谁也拿不到的孤儿副本。
    .tmp 是迁移中间态，一律回收。
    """
    if not BLOB_DIR.is_dir():
        return
    with _blob_lock:
        refs = _blob_refs()
        for sub in BLOB_DIR.iterdir():
            if not sub.is_dir():
                continue
            for blob in sub.iterdir():
                try:
                    if not blob.is_file():
                        continue
                    if blob.name.endswith(".tmp") or blob not in refs:
                        blob.unlink(missing_ok=True)
                except OSError:
                    pass
            try:
                sub.rmdir()                              # 空目录顺手清掉
            except OSError:
                pass


def _dedup_sources() -> tuple[int, int]:
    """启动时把重复素材折叠回 blob 硬链接，返回 (去重组数, 处理文件数)。

    splatstudio 每次都把输入原样复制进 projects/<id>/source/。旧版 _gc_blobs
    只看 st_nlink，一旦副本被复制（copy2 新建 inode）或 blob 先被删掉，同一段
    视频留下的多份完整副本就永远不会自愈（实测 299 MB 无法回收）。这里按内容
    哈希重新分组：先按 inode 去重，每个不同内容只哈希一次，再重建缺失的 blob
    并把所有副本回链过去。
    """
    roots: list[Path] = []
    for proj in _projects_snapshot():
        src = proj / "source"
        if src.is_dir():
            roots.append(src)
    try:
        roots.extend(d for d in UPLOAD_DIR.iterdir() if d.is_dir())
    except OSError:
        pass

    seen_inode: dict[tuple[int, int], Path] = {}
    for root in roots:
        for cand in root.rglob("*"):
            try:
                if not cand.is_file():
                    continue
                st = cand.stat()
            except OSError:
                continue
            seen_inode.setdefault((st.st_dev, st.st_ino), cand)

    groups: dict[tuple[str, str], list[Path]] = {}
    for rep in seen_inode.values():
        try:
            digest = _sha256_file(rep)
        except OSError:
            continue
        groups.setdefault((digest, rep.suffix.lower()), []).append(rep)

    merged_groups = 0
    relinked = 0
    with _blob_lock:
        for (digest, suffix), members in groups.items():
            blob = _blob_path(digest, suffix)
            if len(members) < 2 and not blob.is_file():
                continue                                  # 孤本且无 blob，不值得动
            if not blob.is_file():
                blob.parent.mkdir(parents=True, exist_ok=True)
                _link_or_copy(members[0], blob)
            for cand in members:
                _link_or_copy(blob, cand)
                relinked += 1
            if len(members) > 1:
                merged_groups += 1
    return merged_groups, relinked


def _purge_artifacts(job: dict, keep_input: bool = False) -> bool:
    """回收任务的派生数据；keep_input 保留完整上传输入供失败任务重试。

    保留 project.json / state.json / logs/，失败任务的历史仍能在前端查看；
    返回是否真的清理了项目内容。
    """
    jid = job.get("id")
    if not jid:
        return False
    if not keep_input:
        _rm(UPLOAD_DIR / jid)
    _rm(WORK_DIR / f"{jid}.log")
    purged = False
    raw = job.get("projectPath")
    if raw:
        proj = Path(raw).resolve()
        root = PROJECTS_DIR.resolve()
        # 只清理 projects/ 之下的目录，且不能是 projects/ 本身
        if proj != root and root in proj.parents and proj.is_dir():
            _rm(proj / "work")
            _rm(proj / "source")
            _rm(proj / "final.ply")
            purged = True
    return purged


def _prune_project(job: dict) -> None:
    """任务成功后释放派生数据。"""
    raw = job.get("projectPath")
    proj = Path(raw) if raw else None
    if not (proj and proj.is_dir()):
        return
    _attach_source_view(job)
    if not KEEP_WORK:
        _rm(proj / "work")
    src_dir = proj / "source"
    if src_dir.is_dir():
        if PRUNE_SOURCE:
            _rm(src_dir)
        else:
            # splatstudio 把素材复制进了 source/，换回 blob 硬链接，
            # 否则重复提交同一素材仍会各占一份磁盘。
            _relink_source(proj)
        # 输入副本（或硬链接）已在项目内，uploads 中转目录可以安全回收
        _rm(UPLOAD_DIR / job["id"])



def _projects_snapshot() -> set[Path]:
    """记录 PROJECTS_DIR 当前的子目录，用于识别本次运行新建的项目目录。"""
    try:
        return {d for d in PROJECTS_DIR.iterdir() if d.is_dir()}
    except OSError:
        return set()


def _adopt_project(job: dict, input_path: Path, before: set[Path]) -> None:
    """把本次运行新建的项目目录认领给任务。

    splatstudio 只在结尾的结果 JSON 里给出 projectPath；中途被杀或崩溃时
    该字段拿不到，派生数据（work/ 可达数百 MB）就会失去归属。这里按目录名的
    输入主名后缀匹配，让失败路径也能回收。
    """
    stem = input_path.name if input_path.is_dir() else input_path.stem
    with _jobs_lock:
        taken = {
            str(Path(j["projectPath"]))
            for j in _jobs.values()
            if j.get("projectPath") and j["id"] != job["id"]
        }
    best: Path | None = None
    for cand in _projects_snapshot() - before:
        if str(cand) in taken or not cand.name.endswith(f"_{stem}"):
            continue
        if best is None or cand.stat().st_mtime > best.stat().st_mtime:
            best = cand
    if best is not None:
        job["projectPath"] = str(best)


def _reconcile_projects() -> int:
    """启动时回收「没有任何任务引用」的项目目录里的派生数据。

    正常情况下失败任务已由 _purge_artifacts 处理；这里兜底的是上个进程被强杀、
    任务没来得及记录 projectPath 而遗留的目录。只清 work/source/final.ply，
    project.json/state.json/logs 保留以便事后排查。
    """
    with _jobs_lock:
        referenced: set[Path] = set()
        for job in _jobs.values():
            raw = job.get("projectPath")
            if raw:
                try:
                    referenced.add(Path(raw).resolve())
                except OSError:
                    pass
    purged = 0
    for proj in sorted(_projects_snapshot()):
        try:
            if proj.resolve() in referenced:
                continue
        except OSError:
            continue
        if (proj / "work").is_dir() or (proj / "source").is_dir() or (proj / "final.ply").is_file():
            _rm(proj / "work")
            _rm(proj / "source")
            _rm(proj / "final.ply")
            purged += 1
    return purged

def _reconcile_uploads() -> int:
    """启动时回收终态任务的 uploads/ 中转目录。

    uploads/ 只是上传中转：任务成功后素材已在 projects/<id>/source/，
    失败任务的完整输入保留供重试，部分上传或无效路径仍清理。
    只有确认项目内留有素材副本时才动，避免误删唯一副本。
    """
    with _jobs_lock:
        terminal = {
            j["id"]: j
            for j in _jobs.values()
            if j.get("status") in ("done", "failed")
        }
    purged = 0
    for jid, job in terminal.items():
        if job["status"] == "failed" and _retry_input(job) is not None:
            continue                                     # 保留失败任务的完整输入供重试
        d = UPLOAD_DIR / jid
        if not d.is_dir():
            continue
        raw = job.get("projectPath")
        if job["status"] == "done" and not (raw and (Path(raw) / "source").is_dir()):
            continue                                      # 唯一副本，不能删
        _rm(d)
        purged += 1
    return purged


def _reconcile_work() -> int:
    """启动时按保留策略清理终态任务的中间数据。

    保留策略对既有任务同样生效：`work/`（colmap/brush 中间产物）在导出完成后
    没有复用价值，默认回收；`--keep-work` 可关闭该行为。
    """
    changed = False
    for job in list_jobs():
        if job.get("status") == "done":
            changed = _attach_source_view(job) or changed
    if changed:
        _save_jobs()
    if KEEP_WORK:
        return 0
    with _jobs_lock:
        projs = [
            Path(j["projectPath"])
            for j in _jobs.values()
            if j.get("status") in ("done", "failed") and j.get("projectPath")
        ]
    purged = 0
    for proj in projs:
        if (proj / "work").is_dir():
            _rm(proj / "work")
            purged += 1
    return purged


def delete_job(jid: str) -> bool:
    """删除任务记录及其全部派生数据。运行中的任务拒绝删除。"""
    with _retry_lock:
        return _delete_job(jid)


def _delete_job(jid: str) -> bool:
    job = get_job(jid)
    if not job or job.get("status") in ("running", "queued"):
        return False
    _purge_artifacts(job)
    raw = job.get("projectPath")
    if raw:
        proj = Path(raw).resolve()
        root = PROJECTS_DIR.resolve()
        # 任务记录都没了，项目目录整体清除
        if proj != root and root in proj.parents:
            _rm(proj)
    with _jobs_lock:
        _jobs.pop(jid, None)
    _save_jobs()
    _gc_blobs()
    return True


def _shutdown_cleanup() -> None:
    """进程退出前回收运行中任务的派生数据并落盘状态。

    splatstudio 在独立进程组里运行（start_new_session），不会随父进程退出；
    必须先整组终止，再收尾，否则项目目录里的 work/ 会永久遗留。
    """
    _SERVER_SHUTTING_DOWN.set()
    with _queue_condition:
        _queue_condition.notify_all()
    _terminate_running()
    if _queue_worker is not None:
        # Wait for the worker's cleanup before touching its files or releasing
        # the shared slot. Registration also terminates processes raced by stop.
        _queue_worker.join()
    with _queue_condition:
        _pending_jobs.clear()
    for job in list_jobs():
        if job.get("status") not in ("running", "queued"):
            continue
        job["status"] = "failed"
        job["error"] = "服务停止，任务已中断"
        job["finishedAt"] = _now()
        _purge_artifacts(job, keep_input=True)
    _save_jobs()
    _gc_blobs()


def _data_usage() -> int:
    """data/ 实际占用字节数；同一 inode 的硬链接只计一次。"""
    total = 0
    seen: set[tuple[int, int]] = set()
    for root in (PROJECTS_DIR, UPLOAD_DIR, BLOB_DIR):
        if not root.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                try:
                    st = os.stat(os.path.join(dirpath, name))
                except OSError:
                    continue
                key = (st.st_dev, st.st_ino)
                if key in seen:
                    continue
                seen.add(key)
                total += st.st_size
    return total


def _enforce_quota() -> list[str]:
    """任务数与磁盘用量双重上限，从最旧的已完成/失败任务开始淘汰。"""
    evicted: list[str] = []

    def evict_one() -> bool:
        with _jobs_lock:
            if len(_jobs) <= 1:
                return False
        victim = next(
            (j for j in reversed(list_jobs())
             if j.get("status") not in ("running", "queued")),
            None,
        )
        if not victim or not delete_job(victim["id"]):
            return False
        evicted.append(victim["id"])
        return True

    with _jobs_lock:
        over = len(_jobs) > MAX_JOBS
    while over and evict_one():
        with _jobs_lock:
            over = len(_jobs) > MAX_JOBS

    if MAX_DATA_BYTES > 0:
        guard = 0
        while _data_usage() > MAX_DATA_BYTES and guard < 200 and evict_one():
            guard += 1
    return evicted



# ---------------------------------------------------------------- 上传处理

class UploadError(Exception):
    """上传内容不合法或超限，对应 4xx 响应。"""


def _extract_zip(src: Path, dest_dir: Path) -> Path:
    """把 zip 内的图片流式解包到 dest_dir/images。

    校验条目数、单条与整包解压体积：zip 炸弹（几 MB 压缩包解出上百 GB）
    会让磁盘瞬间打满。目录头里的 file_size 不可信，写盘时再累计一次。
    """
    frames = dest_dir / "images"
    frames.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src) as zf:
        members = [
            info for info in zf.infolist()
            if not info.is_dir() and Path(info.filename).suffix.lower() in IMAGE_EXT
        ]
        if not members:
            raise UploadError("zip 内没有图片")
        if len(members) > MAX_ZIP_ENTRIES:
            raise UploadError(f"zip 内图片过多：{len(members)} > {MAX_ZIP_ENTRIES}")
        declared = sum(info.file_size for info in members)
        if declared > MAX_ZIP_TOTAL_BYTES:
            raise UploadError(f"zip 解压后体积过大：{declared} 字节")
        written = 0
        for info in members:
            if info.file_size > MAX_ZIP_ENTRY_BYTES:
                raise UploadError(f"zip 内单张图片过大：{info.filename}")
            safe = Path(info.filename).name              # 防目录穿越
            if not safe:
                continue
            with zf.open(info) as fsrc, open(frames / safe, "wb") as fdst:
                while True:
                    chunk = fsrc.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_ZIP_TOTAL_BYTES:
                        raise UploadError("zip 解压后体积超过上限")
                    fdst.write(chunk)
    return frames


def save_upload(job: dict, src: Path, digest: str) -> Path:
    """把已落盘的上传体归档；zip 自动解包为图片目录。返回传给 splatstudio 的路径。

    视频与单图走内容寻址：相同字节只保留一份 blob，任务目录用硬链接引用，
    重复提交同一素材不再重复占用磁盘。src 由 HTTP 层流式写入，调用方负责清掉。
    """
    dest_dir = UPLOAD_DIR / job["id"]
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = Path(job["filename"]).name or "upload.bin"
    suffix = Path(name).suffix.lower()

    if suffix == ".zip":
        return _extract_zip(src, dest_dir)

    blob = _blob_path(digest, suffix)
    # 建 blob 与引用它的硬链接要在同一临界区里完成，否则 _gc_blobs 会把
    # 「刚落盘、还没被任何项目引用」的 blob 当成孤儿回收掉。
    with _blob_lock:
        if blob.exists():
            src.unlink(missing_ok=True)
        else:
            blob.parent.mkdir(parents=True, exist_ok=True)
            tmp = blob.with_name(blob.name + ".tmp")
            try:
                os.replace(src, tmp)                     # 同盘零拷贝挪进池子
            except OSError:
                shutil.copyfile(src, tmp)
                _rm(src)
            tmp.replace(blob)

        if suffix in VIDEO_EXT:
            target = dest_dir / name
            _link_or_copy(blob, target)
            return target

        # 单张图片：包一层目录（splatstudio 期望图片目录）
        single = dest_dir / "images"
        single.mkdir(exist_ok=True)
        _link_or_copy(blob, single / name)
        return single


def _fail_upload(job: dict, exc: Exception) -> None:
    """上传落盘失败：标记任务失败并清掉已解包的中转数据。

    zip 解包是边校验边写盘的，中途报错会在 uploads/<id>/images 留下
    半套图片；不清理就会一直占着磁盘，且任务记录还引用不到它。
    """
    _purge_artifacts(job)
    job["status"] = "failed"
    job["error"] = f"保存上传失败: {exc}"
    _save_jobs()


# ---------------------------------------------------------------- HTTP

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
}


class _CountingReader:
    """包装 rfile，记录已交出的字节数，用来算请求体消费了多少。

    http.server 不追踪 body 消费量，未读完的字节会留在连接里被当成
    下一个请求解析（请求走私）。其余属性透传给底层 reader。
    """

    __slots__ = ("raw", "count")

    def __init__(self, raw):
        self.raw = raw
        self.count = 0

    def read(self, n: int = -1) -> bytes:
        data = self.raw.read(n)
        self.count += len(data)
        return data

    def readline(self, n: int = -1) -> bytes:
        data = self.raw.readline(n)
        self.count += len(data)
        return data

    def __getattr__(self, name):
        return getattr(self.raw, name)



class SplatHTTPServer(ThreadingHTTPServer):
    """多线程 HTTP 服务：线程随主进程退出，客户端断开不刷栈。"""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def handle_error(self, request, client_address):
        # 超时、对端重置等都由 socket 层抛出，属于正常现象；
        # 默认实现会打印完整 traceback，把真正的错误淹没。
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)):
            return
        _diagnostic("request_exception", errorType=type(exc).__name__, error=str(exc))
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = "SplatApp/1.0"
    protocol_version = "HTTP/1.1"
    _connections = 0

    def parse_request(self) -> bool:
        # 超过并发上限时直接回 503 并关连接，而不是让请求排队到超时：
        # 排队超时既浪费调用方时间，也不告诉它服务已过载。
        ok = super().parse_request()
        self._request_started = time.monotonic()
        self._body_start = self._reader.count
        if ok and type(self)._connections > MAX_CONNECTIONS:
            self.close_connection = True
            self._err(503, "服务繁忙，请稍后重试", close=True)
            return False
        return ok

    def handle_one_request(self) -> None:
        super().handle_one_request()
        # 任何未被处理函数读走的请求体都必须排空，否则 keep-alive 连接上
        # 残留字节会被当成下一个请求解析（请求走私 / 管道错位）。
        if self.close_connection or self.command is None:
            return
        try:
            declared = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            self.close_connection = True
            return
        consumed = self._reader.count - self._body_start
        remaining = declared - consumed
        if remaining <= 0:
            return
        if self.command not in ("POST", "PUT", "PATCH"):
            # GET/HEAD/DELETE 语义上没有请求体：声明了 Content-Length 却
            # 不发数据，等它就是白白占住线程，直接关连接更安全。
            self.close_connection = True
            return
        if not _discard_request_body(self.rfile, remaining):
            self.close_connection = True


    def log_message(self, fmt, *args):  # 静默，避免刷屏
        pass

    def setup(self):
        super().setup()
        # 半开连接（声明巨大 Content-Length 后不发数据）会永久占住一个线程
        try:
            self.connection.settimeout(SOCKET_TIMEOUT)
        except OSError:
            pass
        self._reader = _CountingReader(self.rfile)
        self.rfile = self._reader
        self._body_start = 0
        with _CONN_LOCK:
            type(self)._connections += 1

    def finish(self):
        with _CONN_LOCK:
            type(self)._connections -= 1
        super().finish()


    # ---- 工具 ----
    def _send(self, code: int, body: bytes, ctype: str,
              extra_headers: dict[str, str] | None = None) -> None:
        duration_ms = round((time.monotonic() - getattr(self, "_request_started", time.monotonic())) * 1000, 1)
        path = urlparse(self.path).path
        if code >= 500 or (self.command in ("GET", "HEAD") and path.startswith("/api/") and duration_ms > 2000):
            _diagnostic("http_response", status=code, method=self.command, path=path,
                        durationMs=duration_ms, connections=type(self)._connections)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        extra = extra_headers or {}
        for name, value in extra.items():
            self.send_header(name, value)
        self.end_headers()
        if extra.get("Connection", "").lower() == "close":
            self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_static(self, target: Path, ctype: str) -> None:
        """静态资源：内容随文件变化，缓存必须每次向服务端确认。

        热重载会原地改写 web/ 下的 JS/CSS，浏览器若沿用旧缓存就会新旧混杂。
        """
        self._range_file(target, ctype, extra_headers={"Cache-Control": "no-cache"})

    def _json(self, obj, code: int = 200, close: bool = False) -> None:
        headers = {"Connection": "close"} if close else None
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8", headers)

    def _err(self, code: int, msg: str, close: bool = False) -> None:
        self._json({"error": msg}, code, close)

    def _content_length(self) -> int:
        """解析 Content-Length；缺失按 0，非法值抛 UploadError（调用方回 400）。"""
        raw = self.headers.get("Content-Length")
        if raw is None:
            return 0
        try:
            length = int(raw.strip())
        except (TypeError, ValueError):
            raise UploadError(f"Content-Length 非法: {raw!r}") from None
        return max(0, length)

    def _range_file(self, path: Path, ctype: str,
                    extra_headers: dict[str, str] | None = None) -> None:
        """支持 Range 的静态文件服务（PLY 体积大，浏览器/渲染库可能需要分段拉取）。"""
        size = path.stat().st_size
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        code = 200
        if rng and rng.startswith("bytes="):
            spec = rng[6:].split("-")
            try:
                if spec[0]:
                    start = int(spec[0]); end = int(spec[1]) if spec[1] else size - 1
                else:
                    start = max(0, size - int(spec[1])); end = size - 1
            except (ValueError, IndexError):
                start, end = 0, size - 1
            start = max(0, min(start, size - 1))
            end = max(start, min(end, size - 1))
            code = 206
        length = end - start + 1
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        headers = {"Cache-Control": "no-store"}
        headers.update(extra_headers or {})
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            chunk = 1024 * 512
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(data)

    # ---- 路由 ----
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,HEAD,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)

        if path == "/api/health":
            return self._json({
                "ok": True,
                "process": {"pid": os.getpid(), "instanceId": _INSTANCE_ID,
                            "startedAt": _SERVER_STARTED_AT, "connections": type(self)._connections,
                            "maxConnections": MAX_CONNECTIONS,
                            "shuttingDown": _SERVER_SHUTTING_DOWN.is_set()},
                "runOoo": RUN_OOO.exists(),
                "runOooPath": str(RUN_OOO),
                "keepWork": KEEP_WORK,
                "pruneSource": PRUNE_SOURCE,
                "maxJobs": MAX_JOBS,
                "maxDataBytes": MAX_DATA_BYTES,
                "dataBytes": _data_usage(),
                "queue": queue_snapshot(),
                "colmapRuntime": {
                    "engine": os.environ.get("SPLAT_COLMAP_REAL"),
                    "gpuRequested": os.environ.get("SPLAT_COLMAP_GPU") == "1",
                },
            })
        if path == "/api/jobs":
            jobs = [job_snapshot(j, include_log=False) for j in list_jobs()]
            return self._json({"jobs": jobs})
        if path == "/api/job":
            jid = (qs.get("id") or [""])[0]
            job = get_job(jid)
            if not job:
                return self._err(404, "任务不存在")
            return self._json(job_snapshot(job))
        if path == "/api/artifact":
            jid = (qs.get("id") or [""])[0]
            job = get_job(jid)
            if not job or not job.get("finalPly"):
                return self._err(404, "产物不存在")
            ply = Path(job["finalPly"])
            if not ply.is_file():
                return self._err(404, "PLY 文件已丢失")
            return self._range_file(ply, "application/octet-stream")
        if path == "/api/download":
            jid = (qs.get("id") or [""])[0]
            job = get_job(jid)
            if not job or not job.get("finalPly"):
                return self._err(404, "产物不存在")
            ply = Path(job["finalPly"])
            if not ply.is_file():
                return self._err(404, "PLY 文件已丢失")
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(ply.stat().st_size))
            self.send_header("Content-Disposition", f'attachment; filename="{ply.name}"')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if self.command == "HEAD":
                return
            with open(ply, "rb") as f:
                shutil.copyfileobj(f, self.wfile, 1024 * 512)
            return

        # 静态文件：按路径段做包含判断，只允许 web/ 目录内的真实文件
        rel = unquote(path.lstrip("/")) or "index.html"
        try:
            target = (WEB_DIR / rel).resolve()
            target.relative_to(WEB_DIR.resolve())
        except (ValueError, OSError):
            return self._err(403, "禁止访问")
        if target.is_dir():
            target = target / "index.html"
        if target.is_file():
            ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
            return self._serve_static(target, ctype)
        return self._err(404, "未找到")

    def do_POST(self):
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)
        try:
            declared = self._content_length()
        except UploadError as exc:
            return self._err(400, str(exc), close=True)
        return self._dispatch_post(path, qs, declared)

    def _dispatch_post(self, path: str, qs: dict, declared: int, retry_parent: dict | None = None) -> None:
        if path == "/api/jobs/retry":
            with _retry_lock:
                return self._retry_post(qs, declared)
        if path == "/api/jobs":
            quality = (qs.get("quality") or ["fast"])[0]
            if quality not in QUALITIES:
                return self._err(400, f"quality 必须是 {sorted(QUALITIES)}")
            filename = unquote(self.headers.get("X-Filename", "upload.mp4"))
            if declared <= 0:
                return self._err(400, "空上传")
            # 超过 MAX_UPLOAD 时不能读 body，直接关连接（handle_one_request 也会兜底）
            if declared > MAX_UPLOAD:
                return self._err(413, "文件过大", close=True)
            job = new_job(filename, quality)
            if retry_parent:
                job["retryOf"] = retry_parent["id"]
            src = UPLOAD_DIR / "staging" / f"{job['id']}.part"
            src.parent.mkdir(parents=True, exist_ok=True)
            try:
                digest = _stream_request_body(self.rfile, src, declared, UPLOAD_TIMEOUT)
                input_path = save_upload(job, src, digest)
            except UploadError as exc:
                _fail_upload(job, exc)
                return self._json(job, 400, close=True)
            except Exception as exc:                      # noqa: BLE001
                _fail_upload(job, exc)
                return self._json(job, 500, close=True)
            finally:
                _rm(src)
            job["inputPath"] = str(input_path)
            try:
                start_job(job, input_path)
            except RuntimeError as exc:
                _fail_upload(job, exc)
                return self._json(job_snapshot(job), 503, close=True)
            out = job_snapshot(job, include_log=False)
            return self._json(out, 202)

        return self._err(404, "未找到")

    def _retry_post(self, qs: dict, declared: int) -> None:
        parent = get_job((qs.get("id") or [""])[0])
        if not parent:
            return self._err(404, "任务不存在")
        if parent["status"] != "failed":
            return self._err(409, "仅失败或中断的任务可以重试")
        active = _active_retry(parent["id"])
        if active:
            return self._json({"error": "重试任务已在队列中", "retryJobId": active["id"]}, 409)
        if declared > 0:
            return self._dispatch_post("/api/jobs", {"quality": [parent["quality"]]}, declared, parent)
        if _retry_input(parent) is None:
            return self._json({"error": "原素材已被清理，请重新选择素材", "sourceMissing": True}, 409)
        job = new_job(parent["filename"], parent["quality"])
        job["retryOf"] = parent["id"]
        try:
            input_path = _copy_retry_input(parent, job)
            job["inputPath"] = str(input_path)
            start_job(job, input_path)
        except Exception as exc:
            _fail_upload(job, exc)
            return self._json({"error": str(exc), "sourceMissing": isinstance(exc, FileNotFoundError)},
                              409 if isinstance(exc, FileNotFoundError) else 503)
        return self._json(job_snapshot(job, include_log=False), 202)

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path != "/api/jobs":
            return self._err(404, "未找到")
        jid = (parse_qs(u.query).get("id") or [""])[0]
        job = get_job(jid)
        if not job:
            return self._err(404, "任务不存在")
        if job.get("status") in ("running", "queued"):
            return self._err(409, "任务正在运行，无法删除")
        delete_job(jid)
        return self._json({"ok": True, "deleted": jid})


def _stream_request_body(rfile, dest: Path, length: int, timeout: float) -> str:
    """从 rfile 读取 length 字节写入 dest，返回内容的 sha256。

    不再把整个 body 读进内存：400 MiB 上传曾让常驻内存瞬时抬高 400 MiB。
    短读、墙钟超时、读超时一律抛 UploadError，由调用方清掉半成品。
    """
    digest = hashlib.sha256()
    written = 0
    deadline = time.monotonic() + timeout
    with open(dest, "wb") as f:
        while written < length:
            if time.monotonic() > deadline:
                raise UploadError("上传超时")
            try:
                chunk = rfile.read(min(1024 * 1024, length - written))
            except (socket.timeout, TimeoutError):
                raise UploadError("上传中断：读超时") from None
            except OSError as exc:
                raise UploadError(f"上传中断：{exc}") from None
            if not chunk:
                raise UploadError(f"上传中断：只收到 {written}/{length} 字节")
            f.write(chunk)
            digest.update(chunk)
            written += len(chunk)
    return digest.hexdigest()


def _discard_request_body(rfile, length: int, limit: int = 8 * 1024 * 1024) -> bool:
    """读掉未处理的请求体；返回连接是否可以复用（False 表示必须关闭）。

    直接返回 4xx 而不排空 body，keep-alive 连接上残留的字节会被当成
    下一个请求解析（请求走私）。超限的 body 只能关连接。
    """
    if length <= 0:
        return True
    if length > limit:
        return False
    remaining = length
    try:
        while remaining > 0:
            chunk = rfile.read(min(65536, remaining))
            if not chunk:
                return False
            remaining -= len(chunk)
    except OSError:
        return False
    return True


def main() -> None:
    global KEEP_WORK, PRUNE_SOURCE, MAX_JOBS, MAX_DATA_BYTES
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8848)
    ap.add_argument("--host", default="127.0.0.1",
                    help="监听地址；默认仅本机，需要局域网访问时显式传 0.0.0.0")
    ap.add_argument("--keep-work", action="store_true",
                    help="保留 projects/<id>/work/ 中间数据（默认完成后删除）")
    ap.add_argument("--prune-source", action="store_true",
                    help="项目完成后连 source/ 素材副本一并删除")
    ap.add_argument("--max-jobs", type=int, default=MAX_JOBS,
                    help="保留的任务数上限，超出后淘汰最旧的已完成任务")
    ap.add_argument("--max-data-gb", type=float, default=MAX_DATA_BYTES / 1024 ** 3,
                    help="data/ 目录用量上限（GB），0 表示不限制")
    args = ap.parse_args()
    KEEP_WORK = KEEP_WORK or args.keep_work
    PRUNE_SOURCE = PRUNE_SOURCE or args.prune_source
    MAX_JOBS = args.max_jobs
    MAX_DATA_BYTES = int(args.max_data_gb * 1024 ** 3)
    _load_jobs()
    orphaned = _reconcile_projects()
    if orphaned:
        print(f"  启动清理：回收 {orphaned} 个无主项目目录的派生数据")
    stray_uploads = _reconcile_uploads()
    if stray_uploads:
        print(f"  启动清理：回收 {stray_uploads} 个终态任务的 uploads 中转目录")
    stray_work = _reconcile_work()
    if stray_work:
        print(f"  启动清理：按保留策略回收 {stray_work} 个任务的 work/ 中间数据")
    merged, relinked = _dedup_sources()
    if merged or relinked:
        print(f"  启动清理：素材去重合并 {merged} 组，重新链接 {relinked} 个文件")
    _gc_blobs()
    evicted = _enforce_quota()
    if evicted:
        print(f"  启动清理：按配额淘汰 {len(evicted)} 个旧任务")
    srv = SplatHTTPServer((args.host, args.port), Handler)

    def _handle_signal(signum, _frame):
        # 信号处理里只置位并让另一个线程关服务，避免阻塞主线程。
        _request_shutdown(srv, signum)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    _diagnostic("server_started", host=args.host, port=args.port)
    print(f"SplatApp 后端已启动: http://{args.host}:{args.port}")
    print(f"  前端目录: {WEB_DIR}")
    print(f"  splatstudio 启动器: {RUN_OOO}  (存在={RUN_OOO.exists()})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        _diagnostic("shutdown_requested", signal="KeyboardInterrupt")
    print("\n正在停止：回收运行中任务的派生数据…")
    _shutdown_cleanup()
    _diagnostic("server_stopped")
    print("已停止")


if __name__ == "__main__":
    main()

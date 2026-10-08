#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SPLAT_COLMAP_REAL="${SPLAT_COLMAP_REAL:-$APP_DIR/../gpu-build/colmap-install/bin/colmap}"
if [[ ! -x "$SPLAT_COLMAP_REAL" ]]; then
  echo "找不到 CUDA 版 COLMAP: $SPLAT_COLMAP_REAL" >&2
  exit 1
fi
export SPLAT_COLMAP_GPU=1
export SPLAT_DATA_DIR="${SPLAT_DATA_DIR:-$APP_DIR/data-gpu}"
export SPLAT_WORK_DIR="${SPLAT_WORK_DIR:-$APP_DIR/work-gpu}"
echo "GPU 重建试用入口：COLMAP=$SPLAT_COLMAP_REAL"
echo "任务目录：$SPLAT_DATA_DIR"
echo "引擎旧 health 可能仍显示 CPU；实际 GPU 使用以任务中的 SIFT GPU 日志为准。"
exec python3 "$APP_DIR/server.py" --port 8850 "$@"

#!/usr/bin/env bash
# Run independently of the invoking terminal, without restarting a busy backend.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-cpu}" in
  cpu) SERVICE_UNIT=splat-app-web; SERVICE_PORT=8848; SERVICE_CMD=(/usr/bin/python3 -u "$APP_DIR/server.py" --port 8848) ;;
  gpu) SERVICE_UNIT=splat-app-gpu; SERVICE_PORT=8850; SERVICE_CMD=("$APP_DIR/start-gpu.sh") ;;
  *) echo "用法：bash start-service.sh [cpu|gpu]" >&2; exit 2 ;;
esac
SERVICE_URL="http://127.0.0.1:$SERVICE_PORT"
if systemctl --user is-active --quiet "$SERVICE_UNIT.service" || curl -fsS --max-time 2 "$SERVICE_URL/api/health" >/dev/null 2>&1; then
  echo "服务已运行：$SERVICE_URL"
  exit 0
fi
if [[ "$(systemctl --user show "$SERVICE_UNIT.service" -p LoadState --value 2>/dev/null)" == loaded ]]; then
  systemctl --user start "$SERVICE_UNIT.service"
else
  systemd-run --user --unit="$SERVICE_UNIT" --description="SplatApp local $SERVICE_UNIT backend" \
    --property="WorkingDirectory=$APP_DIR" --property=Restart=always --property=RestartSec=3s --setenv=PYTHONUNBUFFERED=1 \
    --property=KillMode=mixed --property=TimeoutStopSec=180s "${SERVICE_CMD[@]}"
fi
echo "服务已启动：$SERVICE_URL"

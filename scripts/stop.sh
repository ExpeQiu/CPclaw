#!/bin/bash
# 停止本工程拥有的 Mock 健康进程。不清理端口上的无关进程。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

usage() {
  cat <<'EOF'
用法: bash scripts/stop.sh

读取数据目录里的 dev-host.pid。命令行不是 scripts/dev-host.mjs 时拒绝停止。
没有本工程进程时返回 0。
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "未知参数: $1" >&2
  exit 1
fi

cpclaw_load_dotenv "$ROOT/.env"
cpclaw_require_runtime

if ! CONFIG_ENV="$(cd "$ROOT" && node scripts/resolve-config.mjs --target=local)"; then
  exit 1
fi
CPCLAW_DATA_DIR="$(printf "%s\n" "$CONFIG_ENV" | awk -F= '/^CPCLAW_DATA_DIR=/{print substr($0, index($0, "=")+1)}')"
CPCLAW_DEV_HOST_PORT="$(printf "%s\n" "$CONFIG_ENV" | awk -F= '/^CPCLAW_DEV_HOST_PORT=/{print substr($0, index($0, "=")+1)}')"
CPCLAW_DATA_DIR="${CPCLAW_DATA_DIR//\'/}"
CPCLAW_DEV_HOST_PORT="${CPCLAW_DEV_HOST_PORT//\'/}"

PID_FILE="$CPCLAW_DATA_DIR/dev-host.pid"
if [[ ! -f "$PID_FILE" ]]; then
  echo "没有本工程健康进程"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if ! cpclaw_pid_is_ours "$PID"; then
  echo "pid=${PID} 不是本工程的 dev-host，未停止" >&2
  exit 1
fi

kill "$PID" >/dev/null 2>&1 || true
waited=0
while [[ "$waited" -lt 25 ]]; do
  if ! kill -0 "$PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
  waited=$((waited + 1))
done

if kill -0 "$PID" >/dev/null 2>&1; then
  kill -9 "$PID" >/dev/null 2>&1 || true
  sleep 0.2
fi

if kill -0 "$PID" >/dev/null 2>&1; then
  echo "进程 ${PID} 未能退出" >&2
  exit 1
fi

rm -f "$PID_FILE"
if lsof -nP -iTCP:"${CPCLAW_DEV_HOST_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${CPCLAW_DEV_HOST_PORT} 仍在监听，且已不属于已停止的 pid" >&2
  exit 1
fi

echo "已停止 pid=${PID}"

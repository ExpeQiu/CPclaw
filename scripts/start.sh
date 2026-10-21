#!/bin/bash
# P0-02.a：启动本机 Mock 健康进程。健康检查通过才返回 0。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

TARGET="local"
usage() {
  cat <<'EOF'
用法: bash scripts/start.sh [--target local|docker|cloud]

local   启动 127.0.0.1 上的 Mock 健康进程。AI_MOCK_MODE 必须是精确的 true。
docker  本增量未实现，返回非零。
cloud   本增量未实现，返回非零。

已导出的环境变量优先于 .env。不会启动桌面或 Harness。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        echo "缺少 --target 的值" >&2
        exit 1
      fi
      TARGET="$2"
      shift 2
      ;;
    --target=*)
      TARGET="${1#*=}"
      shift
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cpclaw_load_dotenv "$ROOT/.env"
cpclaw_require_runtime
cpclaw_build "$ROOT"

if ! CONFIG_ENV="$(cd "$ROOT" && node scripts/resolve-config.mjs "--target=${TARGET}")"; then
  exit 1
fi
AI_MOCK_MODE="$(printf "%s\n" "$CONFIG_ENV" | awk -F= '/^AI_MOCK_MODE=/{print substr($0, index($0, "=")+1)}')"
CPCLAW_DATA_DIR="$(printf "%s\n" "$CONFIG_ENV" | awk -F= '/^CPCLAW_DATA_DIR=/{print substr($0, index($0, "=")+1)}')"
CPCLAW_DEV_HOST_PORT="$(printf "%s\n" "$CONFIG_ENV" | awk -F= '/^CPCLAW_DEV_HOST_PORT=/{print substr($0, index($0, "=")+1)}')"
AI_MOCK_MODE="${AI_MOCK_MODE//\'/}"
CPCLAW_DATA_DIR="${CPCLAW_DATA_DIR//\'/}"
CPCLAW_DEV_HOST_PORT="${CPCLAW_DEV_HOST_PORT//\'/}"
if [[ -z "$AI_MOCK_MODE" || -z "$CPCLAW_DATA_DIR" || -z "$CPCLAW_DEV_HOST_PORT" ]]; then
  echo "配置输出不完整" >&2
  exit 1
fi
export AI_MOCK_MODE CPCLAW_DATA_DIR CPCLAW_DEV_HOST_PORT

PID_FILE="$CPCLAW_DATA_DIR/dev-host.pid"
mkdir -p "$CPCLAW_DATA_DIR/logs"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE")"
  if cpclaw_pid_is_ours "$OLD_PID"; then
    if curl -fsS --max-time 3 "http://127.0.0.1:${CPCLAW_DEV_HOST_PORT}/health" | node "$ROOT/scripts/check-health.mjs" >/dev/null; then
      echo "健康进程已在运行 pid=${OLD_PID} port=${CPCLAW_DEV_HOST_PORT}"
      exit 0
    fi
    echo "已有进程但健康检查未通过 pid=${OLD_PID}" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

if lsof -nP -iTCP:"${CPCLAW_DEV_HOST_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${CPCLAW_DEV_HOST_PORT} 已被其他进程占用" >&2
  exit 1
fi

env -i \
  PATH="$PATH" \
  HOME="$HOME" \
  AI_MOCK_MODE="$AI_MOCK_MODE" \
  CPCLAW_DATA_DIR="$CPCLAW_DATA_DIR" \
  CPCLAW_DEV_HOST_PORT="$CPCLAW_DEV_HOST_PORT" \
  node "$ROOT/scripts/dev-host.mjs" >>"$CPCLAW_DATA_DIR/logs/dev-host.stderr.log" 2>&1 &
STARTED_PID=$!
printf "%s\n" "$STARTED_PID" >"$PID_FILE"

cleanup_failed_start() {
  if [[ -n "${STARTED_PID:-}" ]] && cpclaw_pid_is_ours "$STARTED_PID"; then
    kill "$STARTED_PID" >/dev/null 2>&1 || true
    local waited=0
    while [[ "$waited" -lt 10 ]]; do
      if ! kill -0 "$STARTED_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
      waited=$((waited + 1))
    done
  fi
  rm -f "$PID_FILE" "$CPCLAW_DATA_DIR/health-body.json"
}

waited=0
until curl -fsS --max-time 2 "http://127.0.0.1:${CPCLAW_DEV_HOST_PORT}/health" >"$CPCLAW_DATA_DIR/health-body.json" 2>/dev/null; do
  if ! kill -0 "$STARTED_PID" >/dev/null 2>&1; then
    echo "健康进程已退出。日志: $CPCLAW_DATA_DIR/logs/dev-host.stderr.log" >&2
    cleanup_failed_start
    exit 1
  fi
  if [[ "$waited" -ge 50 ]]; then
    echo "健康检查超时。日志: $CPCLAW_DATA_DIR/logs/dev-host.stderr.log" >&2
    cleanup_failed_start
    exit 1
  fi
  sleep 0.2
  waited=$((waited + 1))
done

if ! node "$ROOT/scripts/check-health.mjs" <"$CPCLAW_DATA_DIR/health-body.json"; then
  echo "健康响应不符合契约" >&2
  cleanup_failed_start
  exit 1
fi
rm -f "$CPCLAW_DATA_DIR/health-body.json"

echo "已启动 pid=${STARTED_PID} port=${CPCLAW_DEV_HOST_PORT} mode=mock"

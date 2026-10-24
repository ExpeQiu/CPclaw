#!/bin/bash
# 启动本机平台进程。健康检查通过才返回 0。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

usage() {
  cat <<'EOF'
用法: bash scripts/start-platform.sh

在 127.0.0.1 启动平台进程。AI_MOCK_MODE 必须是精确的 true。
空库需要 CPCLAW_PLATFORM_SEED=fixture，或 CPCLAW_BOOTSTRAP_FILE。
fixture 只用于验证，口令是仓库里的合成值。真实报告网关密钥仅由平台进程读取。
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
cpclaw_build "$ROOT"

if ! CONFIG_ENV="$(cd "$ROOT" && CPCLAW_MODEL_ENV_FILE="$ROOT/.env" node scripts/resolve-platform.mjs)"; then
  exit 1
fi

read_config() {
  local key="$1"
  local value
  value="$(printf "%s\n" "$CONFIG_ENV" | awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }')"
  value="${value//\'/}"
  printf "%s" "$value"
}

AI_MOCK_MODE="$(read_config AI_MOCK_MODE)"
CPCLAW_DATA_DIR="$(read_config CPCLAW_DATA_DIR)"
CPCLAW_PLATFORM_PORT="$(read_config CPCLAW_PLATFORM_PORT)"
CPCLAW_LISTEN_HOST="$(read_config CPCLAW_LISTEN_HOST)"
CPCLAW_SESSION_SECRET="$(read_config CPCLAW_SESSION_SECRET)"
CPCLAW_PLATFORM_SEED="$(read_config CPCLAW_PLATFORM_SEED)"
CPCLAW_BOOTSTRAP_FILE="$(read_config CPCLAW_BOOTSTRAP_FILE)"
CPCLAW_ACCESS_TTL_SEC="$(read_config CPCLAW_ACCESS_TTL_SEC)"
CPCLAW_REFRESH_TTL_SEC="$(read_config CPCLAW_REFRESH_TTL_SEC)"

if [[ -z "$AI_MOCK_MODE" || -z "$CPCLAW_DATA_DIR" || -z "$CPCLAW_PLATFORM_PORT" || -z "$CPCLAW_LISTEN_HOST" || -z "$CPCLAW_SESSION_SECRET" ]]; then
  echo "平台配置输出不完整" >&2
  exit 1
fi
export AI_MOCK_MODE CPCLAW_DATA_DIR CPCLAW_PLATFORM_PORT CPCLAW_LISTEN_HOST CPCLAW_SESSION_SECRET
export CPCLAW_ACCESS_TTL_SEC CPCLAW_REFRESH_TTL_SEC
if [[ -n "$CPCLAW_PLATFORM_SEED" ]]; then
  export CPCLAW_PLATFORM_SEED
fi
if [[ -n "$CPCLAW_BOOTSTRAP_FILE" ]]; then
  export CPCLAW_BOOTSTRAP_FILE
fi

PID_FILE="$CPCLAW_DATA_DIR/platform.pid"
mkdir -p "$CPCLAW_DATA_DIR/logs"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE")"
  if cpclaw_pid_is_platform "$OLD_PID"; then
    if curl -fsS --max-time 3 "http://127.0.0.1:${CPCLAW_PLATFORM_PORT}/health" | node "$ROOT/scripts/check-platform-health.mjs" >/dev/null; then
      echo "平台进程已在运行 pid=${OLD_PID} port=${CPCLAW_PLATFORM_PORT}"
      exit 0
    fi
    echo "已有平台进程但健康检查未通过 pid=${OLD_PID}" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

if lsof -nP -iTCP:"${CPCLAW_PLATFORM_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${CPCLAW_PLATFORM_PORT} 已被其他进程占用" >&2
  exit 1
fi

PLATFORM_ENV=(
  "CPCLAW_MODEL_ENV_FILE=$ROOT/.env"
  "PATH=$PATH"
  "HOME=$HOME"
  "AI_MOCK_MODE=$AI_MOCK_MODE"
  "CPCLAW_DATA_DIR=$CPCLAW_DATA_DIR"
  "CPCLAW_PLATFORM_PORT=$CPCLAW_PLATFORM_PORT"
  "CPCLAW_LISTEN_HOST=$CPCLAW_LISTEN_HOST"
  "CPCLAW_SESSION_SECRET=$CPCLAW_SESSION_SECRET"
  "CPCLAW_ACCESS_TTL_SEC=$CPCLAW_ACCESS_TTL_SEC"
  "CPCLAW_REFRESH_TTL_SEC=$CPCLAW_REFRESH_TTL_SEC"
)
if [[ -n "${CPCLAW_PLATFORM_SEED:-}" ]]; then
  PLATFORM_ENV+=("CPCLAW_PLATFORM_SEED=$CPCLAW_PLATFORM_SEED")
fi
if [[ -n "${CPCLAW_BOOTSTRAP_FILE:-}" ]]; then
  PLATFORM_ENV+=("CPCLAW_BOOTSTRAP_FILE=$CPCLAW_BOOTSTRAP_FILE")
fi
env -i "${PLATFORM_ENV[@]}" \
  node "$ROOT/scripts/platform-host.mjs" >>"$CPCLAW_DATA_DIR/logs/platform.stderr.log" 2>&1 &
STARTED_PID=$!
printf "%s\n" "$STARTED_PID" >"$PID_FILE"

cleanup_failed_start() {
  if [[ -n "${STARTED_PID:-}" ]] && cpclaw_pid_is_platform "$STARTED_PID"; then
    kill "$STARTED_PID" >/dev/null 2>&1 || true
    local waited=0
    while [[ "$waited" -lt 20 ]]; do
      if ! kill -0 "$STARTED_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
      waited=$((waited + 1))
    done
  fi
  rm -f "$PID_FILE"
}

waited=0
until curl -fsS --max-time 2 "http://127.0.0.1:${CPCLAW_PLATFORM_PORT}/health" >"$CPCLAW_DATA_DIR/platform-health.json" 2>/dev/null; do
  if ! kill -0 "$STARTED_PID" >/dev/null 2>&1; then
    echo "平台进程已退出。日志: $CPCLAW_DATA_DIR/logs/platform.stderr.log" >&2
    cleanup_failed_start
    exit 1
  fi
  if [[ "$waited" -ge 50 ]]; then
    echo "平台健康检查超时。日志: $CPCLAW_DATA_DIR/logs/platform.stderr.log" >&2
    cleanup_failed_start
    exit 1
  fi
  sleep 0.2
  waited=$((waited + 1))
done

if ! node "$ROOT/scripts/check-platform-health.mjs" <"$CPCLAW_DATA_DIR/platform-health.json"; then
  echo "平台健康响应不符合约定" >&2
  cleanup_failed_start
  exit 1
fi
rm -f "$CPCLAW_DATA_DIR/platform-health.json"
echo "平台已启动 pid=${STARTED_PID} port=${CPCLAW_PLATFORM_PORT} mode=mock"

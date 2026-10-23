#!/bin/bash
# 启动本机 Electron 工作台。须在图形会话中运行（不要只靠 Agent 后台 nohup）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: bash scripts/start-desktop.sh"
  exit 0
fi

cpclaw_load_dotenv "$ROOT/.env"
cpclaw_require_runtime

DATA_DIR="${CPCLAW_DATA_DIR:-${HOME}/Library/Application Support/CPclaw}"
if [[ -z "${DATA_DIR}" || "${DATA_DIR}" != /* ]]; then
  echo "CPCLAW_DATA_DIR 必须是绝对路径" >&2
  exit 1
fi
mkdir -p "$DATA_DIR/logs"

ELECTRON_BIN="$ROOT/apps/desktop/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "未找到 electron，请先在仓库根执行 pnpm install" >&2
  exit 1
fi

export AI_MOCK_MODE="${AI_MOCK_MODE:-true}"
export CPCLAW_DATA_DIR="$DATA_DIR"
if [[ -n "${CPCLAW_PLATFORM_URL:-}" ]]; then
  export CPCLAW_PLATFORM_URL
fi

PID_FILE="$DATA_DIR/desktop.pid"
if [[ -f "$PID_FILE" ]]; then
  OLD="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD" ]] && kill -0 "$OLD" 2>/dev/null; then
    echo "桌面已在运行 pid=${OLD}"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# 通过 open 启动 Electron.app，归属用户图形会话，避免 Agent 回收后台进程。
ELECTRON_APP="$ROOT/apps/desktop/node_modules/electron/dist/Electron.app"
if [[ ! -d "$ELECTRON_APP" ]]; then
  echo "缺少 Electron.app: $ELECTRON_APP" >&2
  exit 1
fi

open -n -a "$ELECTRON_APP" --args "$ROOT/apps/desktop" >>"$DATA_DIR/logs/desktop.stdout.log" 2>>"$DATA_DIR/logs/desktop.stderr.log"

# open 异步拉起；稍等后找进程
slept=0
FOUND=""
while [[ "$slept" -lt 30 ]]; do
  FOUND="$(pgrep -f "${ROOT}/apps/desktop" | head -1 || true)"
  if [[ -n "$FOUND" ]]; then
    break
  fi
  sleep 0.2
  slept=$((slept + 1))
done

if [[ -z "$FOUND" ]]; then
  echo "桌面未能启动。日志: $DATA_DIR/logs/desktop.stderr.log" >&2
  tail -40 "$DATA_DIR/logs/desktop.stderr.log" >&2 || true
  exit 1
fi

printf "%s\n" "$FOUND" >"$PID_FILE"
echo "桌面已启动 pid=${FOUND}"
echo "数据目录: $DATA_DIR"
if [[ -n "${CPCLAW_PLATFORM_URL:-}" ]]; then
  echo "平台: $CPCLAW_PLATFORM_URL"
fi
echo "若仍看不到窗口：看 Dock 里 Electron / CPclaw，或 Mission Control。"

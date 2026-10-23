#!/bin/bash
# P1 平台检查。有 CPCLAW_PLATFORM_URL 时打远程，不启本机平台。真实 MiniMax 与外部身份不在本次。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: bash scripts/verify-p1.sh"
  echo "远程: CPCLAW_PLATFORM_URL=http://host:3928 bash scripts/verify-p1.sh"
  exit 0
fi

cpclaw_load_dotenv "$ROOT/.env"

EVIDENCE_DIR="${HOME}/Library/Application Support/CPclaw/evidence"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/p1-last.json"
LOG_DIR="${HOME}/Library/Application Support/CPclaw/logs"
mkdir -p "$LOG_DIR"
VERIFY_LOG="$LOG_DIR/verify-p1.log"

REMOTE_MODE="false"
if [[ -n "${CPCLAW_PLATFORM_URL+x}" ]]; then
  if [[ "${CPCLAW_PLATFORM_URL}" == "" ]]; then
    echo "CPCLAW_PLATFORM_URL 为空字符串，不会回落到本机平台" >&2
    exit 1
  fi
  REMOTE_MODE="true"
fi

pass="false"
write_evidence() {
  local status="$1"
  local mode_label="$2"
  CPCLAW_EVIDENCE_PASSED="$status" CPCLAW_EVIDENCE_FILE="$EVIDENCE_FILE" CPCLAW_EVIDENCE_MODE="$mode_label" node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const file = process.env.CPCLAW_EVIDENCE_FILE;
    if (file === undefined || file === "") process.exit(1);
    const remote = process.env.CPCLAW_EVIDENCE_MODE === "mock-remote";
    const body = {
      workPackage: "P1-01/02/03/04",
      passed: process.env.CPCLAW_EVIDENCE_PASSED === "true",
      mode: process.env.CPCLAW_EVIDENCE_MODE,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      skipped: ["外部 OIDC", "真实模型 MiniMax-M3", ...(remote ? [] : ["内网或云上部署"])],
      included: ["登录续期退出", "撤销与停用", "两名员工隔离", "额度预留与未知用量", "管理接口与备份", ...(remote ? ["远程平台 HTTP"] : [])],
      finishedAt: new Date().toISOString()
    };
    writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  '
}

on_exit() {
  local code=$?
  trap - EXIT
  if [[ "$code" -eq 0 ]]; then
    pass="true"
  fi
  local mode_label="mock"
  if [[ "$REMOTE_MODE" == "true" ]]; then
    mode_label="mock-remote"
  fi
  write_evidence "$pass" "$mode_label" || true
  if [[ "$pass" != "true" ]]; then
    echo "P1 未通过。日志: $VERIFY_LOG" >&2
    exit "$code"
  fi
  if [[ "$REMOTE_MODE" == "true" ]]; then
    echo "P1 远程 Mock 检查通过。未执行: 外部 OIDC、真实 MiniMax-M3。P1 不能宣布通过。"
  else
    echo "P1 本机 Mock 检查通过。未执行: 外部 OIDC、真实 MiniMax-M3、内网或云上部署。P1 不能宣布通过。"
  fi
  echo "证据: $EVIDENCE_FILE"
}
trap on_exit EXIT

{
  cleanup_runtime() {
    if [[ "$REMOTE_MODE" == "true" ]]; then
      return 0
    fi
    if [[ -n "${WORK_DIR:-}" && -f "${WORK_DIR}/platform.pid" ]]; then
      AI_MOCK_MODE=true CPCLAW_DATA_DIR="$WORK_DIR" CPCLAW_PLATFORM_PORT="${PORT:-3928}" \
        CPCLAW_SESSION_SECRET="${CPCLAW_SESSION_SECRET:-}" CPCLAW_PLATFORM_SEED=fixture \
        bash "$ROOT/scripts/stop-platform.sh" || true
    fi
    if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then
      rm -rf "$WORK_DIR"
    fi
  }
  trap cleanup_runtime EXIT

  echo "---- $(date -u +"%Y-%m-%dT%H:%M:%SZ") verify P1 ----"
  cpclaw_require_runtime
  cpclaw_build "$ROOT"
  (cd "$ROOT" && pnpm --filter @cpclaw/platform test)
  (cd "$ROOT" && pnpm --filter @cpclaw/desktop-host test)

  if [[ "$REMOTE_MODE" == "true" ]]; then
    URL_ENV="$(cd "$ROOT" && node scripts/resolve-platform-url.mjs)"
    read_url() {
      local key="$1"
      local value
      value="$(printf "%s\n" "$URL_ENV" | awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }')"
      value="${value//\'/}"
      printf "%s" "$value"
    }
    BASE="$(read_url CPCLAW_PLATFORM_BASE)"
    MODE="$(read_url CPCLAW_PLATFORM_MODE)"
    if [[ "$MODE" != "remote" ]]; then
      echo "远程模式解析失败 mode=${MODE}" >&2
      exit 1
    fi
    echo "正例: 远程平台检查 base=${BASE}"
    curl -fsS --max-time 5 "${BASE}/health" | node "$ROOT/scripts/check-platform-health.mjs"
    node "$ROOT/scripts/check-platform.mjs" "$BASE"
  else
    WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cpclaw-p1.XXXXXX")"
    PORT="$(node "$ROOT/scripts/free-port.mjs")"
    CPCLAW_SESSION_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    export AI_MOCK_MODE=true
    export CPCLAW_DATA_DIR="$WORK_DIR"
    export CPCLAW_PLATFORM_PORT="$PORT"
    export CPCLAW_SESSION_SECRET
    export CPCLAW_PLATFORM_SEED=fixture

    echo "正例: 启动平台并检查登录、撤销、员工隔离 port=${PORT}"
    bash "$ROOT/scripts/start-platform.sh"
    node "$ROOT/scripts/check-platform.mjs" "http://127.0.0.1:${PORT}"
    bash "$ROOT/scripts/stop-platform.sh"
    if [[ -f "$WORK_DIR/platform.pid" ]]; then
      echo "停止后仍有平台 pid 文件" >&2
      exit 1
    fi
    bash "$ROOT/scripts/stop-platform.sh"
  fi
} 2>&1 | tee -a "$VERIFY_LOG"

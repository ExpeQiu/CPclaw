#!/bin/bash
# 本机对远程平台做健康与登录冒烟。不启本机平台进程。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: CPCLAW_PLATFORM_URL=http://47.113.225.93:3928 bash scripts/verify-platform-remote.sh"
  exit 0
fi

cpclaw_load_dotenv "$ROOT/.env"

if [[ -z "${CPCLAW_PLATFORM_URL:-}" ]]; then
  CPCLAW_PLATFORM_URL="http://${CPCLAW_REMOTE_HOST:-47.113.225.93}:3928"
  export CPCLAW_PLATFORM_URL
fi

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
  echo "verify-platform-remote 需要远程 CPCLAW_PLATFORM_URL，当前 mode=${MODE}" >&2
  exit 1
fi

EVIDENCE_DIR="${HOME}/Library/Application Support/CPclaw/evidence"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/platform-remote-last.json"

echo "远程健康检查 ${BASE}"
curl -fsS --max-time 5 "${BASE}/health" | node "$ROOT/scripts/check-platform-health.mjs"
node "$ROOT/scripts/check-platform.mjs" "$BASE"

CPCLAW_EVIDENCE_FILE="$EVIDENCE_FILE" CPCLAW_PLATFORM_BASE="$BASE" node --input-type=module -e '
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CPCLAW_EVIDENCE_FILE, JSON.stringify({
  workPackage: "platform-remote-smoke",
  passed: true,
  mode: "mock-remote",
  base: process.env.CPCLAW_PLATFORM_BASE,
  skipped: ["OIDC", "真实 MiniMax", "正式阶段通过"],
  finishedAt: new Date().toISOString(),
}, null, 2) + "\n");
'

echo "远程平台冒烟通过。证据: $EVIDENCE_FILE"
echo "不等于 P1 正式通过。"

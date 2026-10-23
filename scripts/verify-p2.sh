#!/bin/bash
# P2 本机工作台检查。真实 CLI、MCP 与企业知识不在本次。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: bash scripts/verify-p2.sh"
  exit 0
fi

EVIDENCE_DIR="${HOME}/Library/Application Support/CPclaw/evidence"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/p2-last.json"
LOG_DIR="${HOME}/Library/Application Support/CPclaw/logs"
mkdir -p "$LOG_DIR"
VERIFY_LOG="$LOG_DIR/verify-p2.log"

pass="false"
write_evidence() {
  local status="$1"
  CPCLAW_EVIDENCE_PASSED="$status" CPCLAW_EVIDENCE_FILE="$EVIDENCE_FILE" node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const file = process.env.CPCLAW_EVIDENCE_FILE;
    if (file === undefined || file === "") process.exit(1);
    const body = {
      workPackage: "P2-01/02/03/05/06",
      passed: process.env.CPCLAW_EVIDENCE_PASSED === "true",
      mode: "mock",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      skipped: ["CLI", "MCP", "真实连接器", "企业知识样本"],
      included: ["任务修订与单活动槽", "重启中断", "最终消息去重", "模式与补充队列", "跨执行预算", "未知用量", "审阅拒绝与恢复冲突", "项目记忆隔离", "Personal Wiki 选源与冲突"],
      blocked: "P2-04 首个 CLI 与 MCP 未指定",
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
  write_evidence "$pass" || true
  if [[ "$pass" != "true" ]]; then
    echo "P2 未通过。日志: $VERIFY_LOG" >&2
    exit "$code"
  fi
  echo "P2 本机 Mock 检查通过。未执行: CLI、MCP、真实连接器、企业知识。P2 不能宣布通过。"
  echo "证据: $EVIDENCE_FILE"
}
trap on_exit EXIT

{
  echo "---- $(date -u +"%Y-%m-%dT%H:%M:%SZ") verify P2 ----"
  cpclaw_load_dotenv "$ROOT/.env"
  cpclaw_require_runtime
  cpclaw_build "$ROOT"
  cpclaw_remote_platform_preflight "$ROOT"
  (cd "$ROOT" && pnpm --filter @cpclaw/desktop-host test)
} 2>&1 | tee -a "$VERIFY_LOG"

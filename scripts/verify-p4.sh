#!/bin/bash
# P4 本机办公入口检查。真实飞书/企微应用与回调网络不在本次。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: bash scripts/verify-p4.sh"
  exit 0
fi

EVIDENCE_DIR="${HOME}/Library/Application Support/CPclaw/evidence"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/p4-last.json"
LOG_DIR="${HOME}/Library/Application Support/CPclaw/logs"
mkdir -p "$LOG_DIR"
VERIFY_LOG="$LOG_DIR/verify-p4.log"

pass="false"
write_evidence() {
  local status="$1"
  CPCLAW_EVIDENCE_PASSED="$status" CPCLAW_EVIDENCE_FILE="$EVIDENCE_FILE" node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const file = process.env.CPCLAW_EVIDENCE_FILE;
    if (file === undefined || file === "") process.exit(1);
    const body = {
      workPackage: "P4-01/02/03/04",
      passed: process.env.CPCLAW_EVIDENCE_PASSED === "true",
      mode: "mock",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      skipped: ["真实飞书应用", "真实企微应用", "回调网络", "渠道侧验签联调"],
      included: [
        "可信配对与固定设备",
        "commandId 去重与过期",
        "PC 持久化受理回执",
        "飞书 Mock 单聊闭环",
        "企微 Mock 单聊闭环",
        "ACK 不冒充受理",
        "回复失败只重试回复",
        "离线不补执行旧指令",
        "无回执待核实且不换设备重跑",
        "同任务双入口有序",
        "撤销阻断新输入与待投递",
        "绝对路径禁止外发"
      ],
      blocked: "Q11 飞书/企微测试应用与回调网络未确认",
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
    echo "P4 未通过。日志: $VERIFY_LOG" >&2
    exit "$code"
  fi
  echo "P4 本机 Mock 检查通过。未执行: 真实飞书/企微应用、回调网络。P4 不能宣布通过。"
  echo "证据: $EVIDENCE_FILE"
}
trap on_exit EXIT

{
  echo "---- $(date -u +"%Y-%m-%dT%H:%M:%SZ") verify P4 ----"
  cpclaw_load_dotenv "$ROOT/.env"
  cpclaw_require_runtime
  cpclaw_build "$ROOT"
  cpclaw_remote_platform_preflight "$ROOT"
  (cd "$ROOT" && pnpm --filter @cpclaw/contracts test)
  (cd "$ROOT" && pnpm --filter @cpclaw/platform test)
  (cd "$ROOT" && pnpm --filter @cpclaw/desktop-host test)
} 2>&1 | tee -a "$VERIFY_LOG"

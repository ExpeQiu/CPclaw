#!/bin/bash
# P3 本机企业资源检查。知识样本、正式审核细则与真实容量策略不在本次。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: bash scripts/verify-p3.sh"
  exit 0
fi

EVIDENCE_DIR="${HOME}/Library/Application Support/CPclaw/evidence"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/p3-last.json"
LOG_DIR="${HOME}/Library/Application Support/CPclaw/logs"
mkdir -p "$LOG_DIR"
VERIFY_LOG="$LOG_DIR/verify-p3.log"

pass="false"
write_evidence() {
  local status="$1"
  CPCLAW_EVIDENCE_PASSED="$status" CPCLAW_EVIDENCE_FILE="$EVIDENCE_FILE" node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const file = process.env.CPCLAW_EVIDENCE_FILE;
    if (file === undefined || file === "") process.exit(1);
    const body = {
      workPackage: "P3-01/02/03/04/05/06/07",
      passed: process.env.CPCLAW_EVIDENCE_PASSED === "true",
      mode: "mock",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      skipped: ["正式知识样本", "OCR/多格式原文", "真实审核人", "上传/日志业务配额"],
      included: [
        "上传快照幂等与取消并发",
        "私有文件隔离",
        "日志脱敏与批次去重",
        "换账号隔离与队列缺口",
        "Skill 提交不公开与改稿重审",
        "Skill 安装失败保留旧版",
        "原文 ACL 与撤权",
        "Enterprise Wiki 未审不可见与源失效阻断",
        "学习默认关闭",
        "三类候选与两员工复用",
        "报告引用原文版本"
      ],
      blocked: "Q8 知识样本、Q9 审核细则、Q10 上传日志数值未确认",
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
    echo "P3 未通过。日志: $VERIFY_LOG" >&2
    exit "$code"
  fi
  echo "P3 本机 Mock 检查通过。未执行: 正式知识样本、OCR、真实审核人、业务配额。P3 不能宣布通过。"
  echo "证据: $EVIDENCE_FILE"
}
trap on_exit EXIT

{
  echo "---- $(date -u +"%Y-%m-%dT%H:%M:%SZ") verify P3 ----"
  cpclaw_load_dotenv "$ROOT/.env"
  cpclaw_require_runtime
  cpclaw_build "$ROOT"
  cpclaw_remote_platform_preflight "$ROOT"
  (cd "$ROOT" && pnpm --filter @cpclaw/platform test)
  (cd "$ROOT" && pnpm --filter @cpclaw/desktop-host test)
} 2>&1 | tee -a "$VERIFY_LOG"

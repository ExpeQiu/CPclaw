#!/bin/bash
# P5 本机交付检查。签名安装、试点门槛与自动更新不在本次。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: bash scripts/verify-p5.sh"
  exit 0
fi

EVIDENCE_DIR="${HOME}/Library/Application Support/CPclaw/evidence"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/p5-last.json"
LOG_DIR="${HOME}/Library/Application Support/CPclaw/logs"
mkdir -p "$LOG_DIR"
VERIFY_LOG="$LOG_DIR/verify-p5.log"

pass="false"
write_evidence() {
  local status="$1"
  CPCLAW_EVIDENCE_PASSED="$status" CPCLAW_EVIDENCE_FILE="$EVIDENCE_FILE" node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const file = process.env.CPCLAW_EVIDENCE_FILE;
    if (file === undefined || file === "") process.exit(1);
    const body = {
      workPackage: "P5-01/02/03/04/05",
      passed: process.env.CPCLAW_EVIDENCE_PASSED === "true",
      mode: "mock",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      skipped: ["签名安装包", "公证", "自动更新", "试点达标百分比", "真实机器矩阵全量"],
      included: [
        "只读诊断六类检查",
        "诊断不自动修复",
        "默认诊断包脱敏且额外范围显式",
        "工作区/平台/会话 schema 不兼容拒绝并保留旧数据",
        "未签名制品清单与升级门禁",
        "写前写后中断收敛",
        "备份恢复与权威台账撤权回放",
        "业务基线确定性检查与观测值",
        "移交文档与验收索引"
      ],
      blocked: "Q3 签名账号；Q12 自动更新；Q13 质量费用时延门槛未确认",
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
    echo "P5 未通过。日志: $VERIFY_LOG" >&2
    exit "$code"
  fi
  echo "P5 本机 Mock 检查通过。未执行: 签名安装、公证、试点达标。P5 不能宣布通过。"
  echo "证据: $EVIDENCE_FILE"
}
trap on_exit EXIT

{
  echo "---- $(date -u +"%Y-%m-%dT%H:%M:%SZ") verify P5 ----"
  cpclaw_load_dotenv "$ROOT/.env"
  cpclaw_require_runtime
  cpclaw_build "$ROOT"
  cpclaw_remote_platform_preflight "$ROOT"
  test -f "$ROOT/guide/用户指南.md"
  test -f "$ROOT/guide/管理员手册.md"
  test -f "$ROOT/guide/故障恢复.md"
  test -f "$ROOT/guide/已知限制与验收索引.md"
  (cd "$ROOT" && pnpm --filter @cpclaw/desktop-host test)
  (cd "$ROOT" && pnpm --filter @cpclaw/platform test)
  (cd "$ROOT" && pnpm --filter @cpclaw/verification test)
} 2>&1 | tee -a "$VERIFY_LOG"

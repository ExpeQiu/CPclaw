#!/bin/bash
# P0 检查。健康检查、包测试、未签名报告、桌面重复点击、Harness 文本流和取消都要通过。
# 真实 MiniMax 与签名安装包未执行，不能把它们记为通过，也不能宣布 P0 通过。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
用法: bash scripts/verify.sh

检查契约测试、错误配置被拒绝、Mock 健康检查、未签名报告、桌面重复点击、Harness 文本流和取消。
不把未执行的真实模型、签名安装包记为通过。
EOF
  exit 0
fi

EVIDENCE_DIR="${HOME}/Library/Application Support/CPclaw/evidence"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/p0-02a-last.json"
LOG_DIR="${HOME}/Library/Application Support/CPclaw/logs"
mkdir -p "$LOG_DIR"
VERIFY_LOG="$LOG_DIR/verify-p0-02a.log"

pass="false"
p0_code=1
write_evidence() {
  local status="$1"
  CPCLAW_EVIDENCE_PASSED="$status" CPCLAW_EVIDENCE_FILE="$EVIDENCE_FILE" node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const file = process.env.CPCLAW_EVIDENCE_FILE;
    if (file === undefined || file === "") {
      process.exit(1);
    }
    const body = {
      workPackage: "P0-02.a",
      passed: process.env.CPCLAW_EVIDENCE_PASSED === "true",
      mode: "mock",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      skipped: ["真实模型 MiniMax-M3", "签名安装包"],
      included: ["Mock 健康检查", "包测试", "未签名报告", "桌面重复点击", "Harness 文本流", "Harness 取消"],
      finishedAt: new Date().toISOString()
    };
    writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  '
}

on_exit() {
  local code=$?
  trap - EXIT
  if [[ "$p0_code" -eq 0 ]]; then
    pass="true"
  fi
  write_evidence "$pass" || true
  if [[ "$code" -ne 0 ]]; then
    echo "检查未通过。P0 日志: $VERIFY_LOG" >&2
    echo "证据: $EVIDENCE_FILE" >&2
    exit "$code"
  fi
  echo "检查通过。未执行: 真实 MiniMax-M3、签名安装包、外部身份组件。P0 和 P1 都不能宣布通过。"
  echo "证据: $EVIDENCE_FILE"
}
trap on_exit EXIT

{
  cleanup_verify_runtime() {
    if [[ -n "${WORK_DIR:-}" && -f "${WORK_DIR}/dev-host.pid" ]]; then
      AI_MOCK_MODE=true CPCLAW_DATA_DIR="$WORK_DIR" CPCLAW_DEV_HOST_PORT="${PORT:-3927}" \
        bash "$ROOT/scripts/stop.sh" || true
    fi
    if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then
      rm -rf "$WORK_DIR"
    fi
    if [[ -n "${NEG_DIR:-}" && -d "$NEG_DIR" ]]; then
      rm -rf "$NEG_DIR"
    fi
  }
  trap cleanup_verify_runtime EXIT

  echo "---- $(date -u +"%Y-%m-%dT%H:%M:%SZ") verify P0-02.a ----"
  cpclaw_require_runtime
  cpclaw_build "$ROOT"
  (cd "$ROOT" && pnpm --filter @cpclaw/contracts test)

  echo "负例: 坏健康报告必须返回非零"
  if node "$ROOT/scripts/check-health.mjs" <<<'{}'; then
    echo "坏健康报告被当成通过" >&2
    exit 1
  fi

  NEG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cpclaw-neg.XXXXXX")"
  echo "负例: AI_MOCK_MODE=false 必须返回非零"
  if AI_MOCK_MODE=false CPCLAW_DATA_DIR="$NEG_DIR" bash "$ROOT/scripts/start.sh"; then
    echo "AI_MOCK_MODE=false 不应启动成功" >&2
    exit 1
  fi
  if [[ -f "$NEG_DIR/dev-host.pid" ]]; then
    echo "失败启动仍留下 pid 文件" >&2
    exit 1
  fi

  echo "负例: docker 目标必须返回非零"
  if AI_MOCK_MODE=true CPCLAW_DATA_DIR="$NEG_DIR" bash "$ROOT/scripts/start.sh" --target docker; then
    echo "docker 目标不应启动成功" >&2
    exit 1
  fi
  rm -rf "$NEG_DIR"

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cpclaw-p0-02a.XXXXXX")"
  PORT="$(node "$ROOT/scripts/free-port.mjs")"
  export AI_MOCK_MODE=true
  export CPCLAW_DATA_DIR="$WORK_DIR"
  export CPCLAW_DEV_HOST_PORT="$PORT"

  echo "正例: 启动并检查健康报告 port=${PORT}"
  bash "$ROOT/scripts/start.sh"
  PID_1="$(cat "$WORK_DIR/dev-host.pid")"
  bash "$ROOT/scripts/start.sh"
  PID_2="$(cat "$WORK_DIR/dev-host.pid")"
  if [[ "$PID_1" != "$PID_2" ]]; then
    echo "重复启动创建了第二个进程" >&2
    exit 1
  fi
  LISTEN_COUNT="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t | wc -l | tr -d ' ')"
  if [[ "$LISTEN_COUNT" != "1" ]]; then
    echo "监听进程数不是 1: ${LISTEN_COUNT}" >&2
    exit 1
  fi
  if [[ -e "$WORK_DIR/report.md" ]]; then
    echo "健康检查不应写入报告" >&2
    exit 1
  fi

  bash "$ROOT/scripts/stop.sh"
  if [[ -f "$WORK_DIR/dev-host.pid" ]]; then
    echo "停止后仍有 pid 文件" >&2
    exit 1
  fi
  if kill -0 "$PID_1" >/dev/null 2>&1; then
    echo "停止后进程仍在" >&2
    exit 1
  fi
  bash "$ROOT/scripts/stop.sh"
  rm -rf "$WORK_DIR"
  echo "---- P0-02.b 至 P0-05 ----"
  node "$ROOT/scripts/verify-p0.mjs"
} 2>&1 | tee -a "$VERIFY_LOG"
p0_code=${PIPESTATUS[0]}
if [[ "$p0_code" -ne 0 ]]; then
  exit "$p0_code"
fi
bash "$ROOT/scripts/verify-p1.sh"

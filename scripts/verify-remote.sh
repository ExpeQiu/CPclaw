#!/bin/bash
# 云端平台 + 本机执行面 Mock 全貌：远程冒烟后跑 P1（远程）与 P2–P5（本机包测）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
用法: CPCLAW_PLATFORM_URL=http://47.113.225.93:3928 bash scripts/verify-remote.sh

先确认远端已部署且 3928 对本机出口放行。
不宣称 P0–P5 正式通过。
EOF
  exit 0
fi

cpclaw_load_dotenv "$ROOT/.env"
if [[ -z "${CPCLAW_PLATFORM_URL:-}" ]]; then
  echo "缺少 CPCLAW_PLATFORM_URL" >&2
  exit 1
fi

export CPCLAW_PLATFORM_URL
bash "$ROOT/scripts/verify-platform-remote.sh"
bash "$ROOT/scripts/verify-p1.sh"
bash "$ROOT/scripts/verify-p2.sh"
bash "$ROOT/scripts/verify-p3.sh"
bash "$ROOT/scripts/verify-p4.sh"
bash "$ROOT/scripts/verify-p5.sh"

echo "远程联调脚本跑完。各阶段仍待正式验收；见 evidence 目录。"

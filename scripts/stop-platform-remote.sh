#!/bin/bash
# 停止远端 Docker 控制面。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: bash scripts/stop-platform-remote.sh"
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "未知参数: $1" >&2
  exit 1
fi

cpclaw_load_dotenv "$ROOT/.env"
cpclaw_load_dotenv "$ROOT/deploy/platform/.env"

REMOTE_HOST="${CPCLAW_REMOTE_HOST:-47.113.225.93}"
REMOTE_USER="${CPCLAW_REMOTE_USER:-root}"
REMOTE_DIR="${CPCLAW_REMOTE_DIR:-/opt/cpclaw-platform}"
TARGET="${REMOTE_USER}@${REMOTE_HOST}"

ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "bash -s" <<EOF
set -euo pipefail
cd '${REMOTE_DIR}/repo/deploy/platform'
if docker compose version >/dev/null 2>&1; then
  docker compose down
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose down
else
  echo "远端未找到 docker compose" >&2
  exit 1
fi
EOF

echo "远端平台已停止 ${TARGET}"

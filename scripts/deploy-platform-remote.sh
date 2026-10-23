#!/bin/bash
# 将控制面 Docker 部署到验证云主机（默认 47.113.225.93）。
# 要求：SSH 可达、远端已装 Docker Compose；3928 仅对本机出口 IP 放行。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

usage() {
  cat <<'EOF'
用法: bash scripts/deploy-platform-remote.sh

环境变量（可用 .env 补缺）：
  CPCLAW_REMOTE_HOST   默认 47.113.225.93
  CPCLAW_REMOTE_USER   默认 root
  CPCLAW_REMOTE_DIR    默认 /opt/cpclaw-platform
  CPCLAW_FIREWALL_ACK  必须为精确值 yes（确认 3928 仅对本机出口 IP 放行）
  CPCLAW_FIREWALL_SOURCE_IP  可选；设置后在远端 iptables 只放行该 IPv4 访问 3928
  CPCLAW_SESSION_SECRET  写入远端 .env；至少 32 位

本脚本不会把供应商密钥同步到远端。fixture 口令仅 Mock。
阿里云安全组仍须另行收紧；iptables 是主机层补充。
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "未知参数: $1" >&2
  usage >&2
  exit 1
fi

cpclaw_load_dotenv "$ROOT/.env"
cpclaw_load_dotenv "$ROOT/deploy/platform/.env"

REMOTE_HOST="${CPCLAW_REMOTE_HOST:-47.113.225.93}"
REMOTE_USER="${CPCLAW_REMOTE_USER:-root}"
REMOTE_DIR="${CPCLAW_REMOTE_DIR:-/opt/cpclaw-platform}"
FIREWALL_ACK="${CPCLAW_FIREWALL_ACK:-}"

if [[ "$FIREWALL_ACK" != "yes" ]]; then
  echo "拒绝部署：未确认防火墙。将 CPCLAW_FIREWALL_ACK=yes 表示你已把 ${REMOTE_HOST}:3928 限制为本机出口 IP。" >&2
  exit 1
fi

if [[ -z "${CPCLAW_SESSION_SECRET:-}" ]]; then
  echo "缺少 CPCLAW_SESSION_SECRET（至少 32 位）" >&2
  exit 1
fi
if [[ "${#CPCLAW_SESSION_SECRET}" -lt 32 ]]; then
  echo "CPCLAW_SESSION_SECRET 长度不足 32" >&2
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1 || ! command -v rsync >/dev/null 2>&1; then
  echo "需要本机 ssh 与 rsync" >&2
  exit 1
fi

TARGET="${REMOTE_USER}@${REMOTE_HOST}"
echo "部署目标 ${TARGET}:${REMOTE_DIR}"
echo "防火墙确认: CPCLAW_FIREWALL_ACK=yes（3928 仅受信源）"

ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "mkdir -p '${REMOTE_DIR}'"

# 同步构建上下文（排除本机依赖与证据）。远端再 docker build。
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '**/node_modules' \
  --exclude '**/dist' \
  --exclude '.env' \
  --exclude 'deploy/platform/.env' \
  --exclude 'AppleDouble' \
  --exclude '**/._*' \
  "$ROOT/" "${TARGET}:${REMOTE_DIR}/repo/"

# 远端 .env：密钥不经仓库，经 SSH 写入。
ssh "$TARGET" "cat > '${REMOTE_DIR}/repo/deploy/platform/.env'" <<EOF
AI_MOCK_MODE=true
CPCLAW_DATA_DIR=/data
CPCLAW_PLATFORM_PORT=3928
CPCLAW_LISTEN_HOST=0.0.0.0
CPCLAW_PLATFORM_SEED=fixture
CPCLAW_SESSION_SECRET=${CPCLAW_SESSION_SECRET}
EOF
ssh "$TARGET" "chmod 600 '${REMOTE_DIR}/repo/deploy/platform/.env'"

ssh "$TARGET" "bash -s" <<EOF
set -euo pipefail
cd '${REMOTE_DIR}/repo/deploy/platform'
if ! command -v docker >/dev/null 2>&1; then
  echo "远端未找到 docker" >&2
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "远端未找到 docker compose" >&2
  exit 1
fi
"\${COMPOSE[@]}" up -d --build
EOF

SOURCE_IP="${CPCLAW_FIREWALL_SOURCE_IP:-}"
if [[ -n "$SOURCE_IP" ]]; then
  if [[ ! "$SOURCE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "CPCLAW_FIREWALL_SOURCE_IP 必须是 IPv4" >&2
    exit 1
  fi
  echo "收紧远端 iptables：3928 仅放行 ${SOURCE_IP}"
  ssh "$TARGET" "bash -s" <<EOF
set -euo pipefail
while iptables -C INPUT -p tcp --dport 3928 -j DROP -m comment --comment 'cpclaw-3928-deny' 2>/dev/null; do
  iptables -D INPUT -p tcp --dport 3928 -j DROP -m comment --comment 'cpclaw-3928-deny' || break
done
while iptables -C INPUT -p tcp --dport 3928 -s ${SOURCE_IP} -j ACCEPT -m comment --comment 'cpclaw-3928-allow' 2>/dev/null; do
  iptables -D INPUT -p tcp --dport 3928 -s ${SOURCE_IP} -j ACCEPT -m comment --comment 'cpclaw-3928-allow' || break
done
iptables -I INPUT 1 -p tcp --dport 3928 -s ${SOURCE_IP} -j ACCEPT -m comment --comment 'cpclaw-3928-allow'
iptables -A INPUT -p tcp --dport 3928 -j DROP -m comment --comment 'cpclaw-3928-deny'
EOF
fi

echo "等待远端健康检查..."
ok=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 3 "http://${REMOTE_HOST}:3928/health" 2>/dev/null \
    | node "$ROOT/scripts/check-platform-health.mjs" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [[ "$ok" -ne 1 ]]; then
  echo "远端健康检查失败。请查安全组/iptables 是否对本机出口放行 3928，以及 docker logs cpclaw-platform" >&2
  exit 1
fi

echo "平台已部署 http://${REMOTE_HOST}:3928 mode=mock"
if [[ -z "$SOURCE_IP" ]]; then
  echo "警告: 未设置 CPCLAW_FIREWALL_SOURCE_IP，主机 iptables 未自动收紧 3928。请确认云安全组已白名单。" >&2
fi
echo "本机联调: CPCLAW_PLATFORM_URL=http://${REMOTE_HOST}:3928 bash scripts/verify-platform-remote.sh"

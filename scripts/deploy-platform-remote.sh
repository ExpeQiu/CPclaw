#!/bin/bash
# 将控制面 Docker 部署到验证云主机（默认 47.113.225.93）。
# 要求：SSH 可达、远端已装 Docker Compose；3928 按已确认的网络策略放行。
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
  CPCLAW_FIREWALL_ACK  必须为精确值 yes（确认所选网络策略）
  CPCLAW_FIREWALL_MODE  all / allowlist；未设置时优先沿用远端已保存策略
  CPCLAW_FIREWALL_CIDRS  allowlist 的 IPv4/CIDR 列表，逗号分隔
  CPCLAW_FIREWALL_SOURCE_IP  兼容旧版单 IP 配置
  CPCLAW_SESSION_SECRET  写入远端 .env；至少 32 位

真实模型密钥经 SSH stdin 写入远端私有 .env，不进入镜像。fixture 仍是验证身份。
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
  echo "拒绝部署：请用 CPCLAW_FIREWALL_ACK=yes 确认所选网络策略。" >&2
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
echo "防火墙确认: CPCLAW_FIREWALL_ACK=yes（3928 按保存或显式配置的策略）"
if [[ -n "${CPCLAW_FIREWALL_MODE:-}" ]]; then
  node "$ROOT/scripts/platform-network-policy.mjs" --check
fi

ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "mkdir -p '${REMOTE_DIR}'"

# 发布前保存可回滚制品与一致数据库备份；备份在 repo 之外。
ssh "$TARGET" "bash -s" <<EOF
set -euo pipefail
BACKUP="${REMOTE_DIR}/backups/\$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "\$BACKUP"
chmod 700 "\$BACKUP"
if [ -d '${REMOTE_DIR}/repo' ]; then tar -czf "\$BACKUP/repo.tgz" -C '${REMOTE_DIR}' repo; fi
if docker inspect cpclaw-platform >/dev/null 2>&1; then
  docker exec cpclaw-platform node -e 'const {DatabaseSync}=require("node:sqlite"); const fs=require("node:fs"); const db=new DatabaseSync("/data/platform.sqlite"); const path="/data/predeploy-"+Date.now()+".sqlite"; db.prepare("VACUUM INTO ?").run(path); db.close(); fs.writeFileSync("/data/predeploy-path",path);'
  DBPATH=\$(docker exec cpclaw-platform cat /data/predeploy-path)
  docker cp "cpclaw-platform:\$DBPATH" "\$BACKUP/platform.sqlite"
  docker cp cpclaw-platform:/data/authority-ledger.json "\$BACKUP/authority-ledger.json"
  docker image tag \$(docker inspect cpclaw-platform --format '{{.Image}}') cpclaw-platform:rollback
fi
echo "发布备份: \$BACKUP"
EOF

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

# 不经命令行或日志传递供应商密钥。
node "$ROOT/scripts/write-platform-env.mjs" "$TARGET" "$REMOTE_DIR" "$ROOT/.env"

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

# 显式模式优先；否则沿用保存策略，防止旧 .env 的单 IP 覆盖 all。
if [[ -n "${CPCLAW_FIREWALL_MODE:-}" ]]; then
  bash "$ROOT/scripts/configure-platform-network.sh"
elif ssh "$TARGET" 'test -f /opt/cpclaw-platform/network-policy.sh'; then
  ssh "$TARGET" 'bash /opt/cpclaw-platform/network-policy.sh'
elif [[ -n "${CPCLAW_FIREWALL_SOURCE_IP:-}" ]]; then
  bash "$ROOT/scripts/configure-platform-network.sh"
else
  echo '未配置网络策略；保留现有规则。可使用 configure-platform-network.sh 单独设置。'
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

echo "平台已部署 http://${REMOTE_HOST}:3928 mode=real"
echo "本机联调: CPCLAW_PLATFORM_URL=http://${REMOTE_HOST}:3928 bash scripts/verify-platform-remote.sh"

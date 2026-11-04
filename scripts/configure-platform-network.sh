#!/bin/bash
# 单独调整企业端网络来源，不重建或重启平台。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib.sh"
cpclaw_load_dotenv "$ROOT/.env"
cpclaw_load_dotenv "$ROOT/deploy/platform/.env"
if [[ "${1:-}" == --check ]]; then
  exec node "$ROOT/scripts/platform-network-policy.mjs" --check
fi
if [[ "${CPCLAW_FIREWALL_ACK:-}" != yes ]]; then
  echo '须设置 CPCLAW_FIREWALL_ACK=yes 确认所选网络策略' >&2
  exit 1
fi
POLICY_FILE="$(mktemp "${TMPDIR:-/tmp}/cpclaw-network.XXXXXX")"
trap 'rm -f "$POLICY_FILE"' EXIT
node "$ROOT/scripts/platform-network-policy.mjs" > "$POLICY_FILE"
TARGET="${CPCLAW_REMOTE_USER:-root}@${CPCLAW_REMOTE_HOST:-47.113.225.93}"
# 固定路径在 repo 外，部署 rsync 不会覆盖；备份仅供回滚本次防火墙变更。
ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" 'umask 077; mkdir -p /opt/cpclaw-platform; cat > /opt/cpclaw-platform/network-policy.next.sh' < "$POLICY_FILE"
ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
cd /opt/cpclaw-platform
BACKUP="backups/network-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
iptables-save > "$BACKUP/iptables.rules"
if [[ -f network-policy.sh ]]; then cp -p network-policy.sh "$BACKUP/"; fi
bash -n network-policy.next.sh
if ! bash network-policy.next.sh; then
  iptables-restore < "$BACKUP/iptables.rules"
  exit 1
fi
mv network-policy.next.sh network-policy.sh
chmod 700 network-policy.sh
cat > /etc/systemd/system/cpclaw-network.service <<'UNIT'
[Unit]
Description=CPclaw platform network policy
Requires=docker.service
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/cpclaw-platform/network-policy.sh
RemainAfterExit=yes

[Install]
WantedBy=docker.service
UNIT
systemctl daemon-reload
systemctl enable cpclaw-network.service
systemctl restart cpclaw-network.service
echo "网络规则备份: /opt/cpclaw-platform/$BACKUP"
REMOTE

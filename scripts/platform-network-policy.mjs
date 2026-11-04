import { isIPv4 } from 'node:net';
import { pathToFileURL } from 'node:url';

export function networkPolicy(env = process.env) {
  const mode = env.CPCLAW_FIREWALL_MODE || (env.CPCLAW_FIREWALL_SOURCE_IP ? 'allowlist' : '');
  if (!['all', 'allowlist'].includes(mode)) throw Error('CPCLAW_FIREWALL_MODE 必须为 all 或 allowlist');
  const sources = mode === 'all' ? ['0.0.0.0/0'] : [...new Set(
    (env.CPCLAW_FIREWALL_CIDRS || env.CPCLAW_FIREWALL_SOURCE_IP || '').split(/[\s,]+/).filter(Boolean),
  )];
  if (!sources.length) throw Error('allowlist 模式需要 CPCLAW_FIREWALL_CIDRS');
  for (const source of sources) {
    const parts = source.split('/');
    if (parts.length > 2 || !isIPv4(parts[0]) || (parts.length === 2 && !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1]))) {
      throw Error(`无效的 IPv4 或 CIDR：${source}`);
    }
  }
  return { mode, sources };
}

export function policyScript(policy) {
  return `#!/bin/bash
# CPclaw network policy: ${JSON.stringify(policy)}
set -euo pipefail
iptables -w -nL DOCKER-USER >/dev/null
iptables -w -N CPCLAW-NET 2>/dev/null || iptables -w -nL CPCLAW-NET >/dev/null
iptables -w -F CPCLAW-NET
${policy.sources.map(source => `iptables -w -A CPCLAW-NET -s ${source} -j ACCEPT`).join('\n')}
iptables -w -A CPCLAW-NET -j DROP
for chain in INPUT DOCKER-USER; do
  # 用专属链统一管理；删除部署脚本遗留的重复单 IP 规则及旧跳转。
  while iptables -w -C "$chain" -p tcp --dport 3928 -j CPCLAW-NET 2>/dev/null; do
    iptables -w -D "$chain" -p tcp --dport 3928 -j CPCLAW-NET
  done
  iptables -w -I "$chain" 1 -p tcp --dport 3928 -j CPCLAW-NET
  while IFS= read -r rule; do
    read -r -a args <<< "$rule"
    args[0]=-D
    iptables -w "\${args[@]}"
  done < <(iptables -w -S "$chain" | awk '/--comment cpclaw-3928-(docker-)?(allow|deny)( |$)/')
done
echo 'CPclaw 3928: ${policy.mode} (${policy.sources.join(', ')})'
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const policy = networkPolicy();
    process.stdout.write(process.argv.includes('--check') ? JSON.stringify(policy) + '\n' : policyScript(policy));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { networkPolicy, policyScript } from './platform-network-policy.mjs';

test('all 模式覆盖遗留单 IP 配置', () => {
  assert.deepEqual(networkPolicy({ CPCLAW_FIREWALL_MODE: 'all', CPCLAW_FIREWALL_SOURCE_IP: '192.0.2.1' }), { mode: 'all', sources: ['0.0.0.0/0'] });
});
test('白名单接受多个 IPv4/网段并兼容原配置', () => {
  assert.deepEqual(networkPolicy({ CPCLAW_FIREWALL_MODE: 'allowlist', CPCLAW_FIREWALL_CIDRS: '192.0.2.1,198.51.100.0/24 192.0.2.1' }).sources, ['192.0.2.1', '198.51.100.0/24']);
  assert.equal(networkPolicy({ CPCLAW_FIREWALL_SOURCE_IP: '192.0.2.1' }).mode, 'allowlist');
});
test('错误策略/空白名单/无效网段/命令注入均拒绝', () => {
  for (const env of [{}, { CPCLAW_FIREWALL_MODE: 'bad' }, ...['', '999.0.0.1', '192.0.2.0/33', '192.0.2.0/-1', '192.0.2.0/24/1', '192.0.2.1;id', '::/0'].map(value => ({ CPCLAW_FIREWALL_MODE: 'allowlist', CPCLAW_FIREWALL_CIDRS: value }))]) {
    assert.throws(() => networkPolicy(env));
  }
});
test('两种策略脚本语法正确且只操作 3928 的专属规则', () => {
  for (const env of [{ CPCLAW_FIREWALL_MODE: 'all' }, { CPCLAW_FIREWALL_SOURCE_IP: '192.0.2.1' }]) {
    const script = policyScript(networkPolicy(env));
    assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
    assert.match(script, /--dport 3928 -j CPCLAW-NET/);
    assert.match(script, /CPCLAW-NET -j DROP/);
    assert.doesNotMatch(script, /iptables -w -F (INPUT|DOCKER-USER)/);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinConnectors,
  mergeConnectorViews,
  plannedChannelConnectors,
  resolveFeishuCli,
  statusLabel,
  summarizeCliVersionProbe,
  summarizeDreaminaDiscover,
  summarizeFeishuAuth,
  summarizeMcpProbe,
} from '../connector-health.mjs';

test('内置即梦与飞书服务调用出现在连接器视图；消息渠道单独规划', () => {
  const views = mergeConnectorViews([{ id: 'cli-1', title: '自定义', type: 'CLI', target: '/bin/echo', enabled: true, status: '未检测' }], {}, { includeChannels: true });
  assert.equal(views[0].id, 'dreamina');
  assert.equal(views[1].id, 'feishu');
  assert.equal(views[0].kind, 'service');
  assert.equal(views[1].kind, 'service');
  assert.ok(views.some((x) => x.id === 'cli-1'));
  assert.ok(views.some((x) => x.id === 'channel-feishu-bot' && x.planned));
  assert.ok(plannedChannelConnectors().every((x) => x.kind === 'channel'));
  assert.ok(builtinConnectors().length >= 2);
  assert.equal(typeof resolveFeishuCli(), 'string');
});

test('探测分层摘要区分程序、握手、登录与就绪', () => {
  assert.equal(summarizeCliVersionProbe({ ok: true, stdout: 'v1' }).layer, 'binary_ok');
  assert.equal(summarizeMcpProbe({ ok: true, serverName: 'demo' }).layer, 'handshake_ok');
  assert.equal(summarizeDreaminaDiscover({ ok: false, auth: { ok: true, data: { loggedIn: false } }, message: '请登录' }).layer, 'auth_required');
  const ready = summarizeDreaminaDiscover({ ok: true, commands: [{ command: ['model', 'list'] }, { command: ['auth', 'status'] }] });
  assert.equal(ready.layer, 'ready');
  assert.match(statusLabel(ready), /可调用/);
  const feishuReady = summarizeFeishuAuth({
    ok: true,
    version: 'lark-cli version 1.0.0',
    status: { brand: 'feishu', identities: { bot: { status: 'ready', available: true }, user: { status: 'missing', available: false } } },
  });
  assert.equal(feishuReady.layer, 'ready');
  assert.match(feishuReady.message, /不代表消息渠道/);
  assert.equal(
    summarizeFeishuAuth({
      ok: true,
      version: 'v1',
      status: { identities: { bot: { status: 'missing' }, user: { status: 'missing', tokenStatus: 'expired' } } },
    }).layer,
    'auth_required',
  );
});

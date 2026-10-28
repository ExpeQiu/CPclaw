import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAccountSession } from '@cpclaw/desktop-host/account-session';
import { createChatService } from '../chat-service.mjs';
import { analyzeChat } from '../chat-diagnostics.mjs';
import { clearPlatformCapabilityCache, fetchServiceTypes, fitServiceCatalog } from '../platform-capability.mjs';

test('平台自报能力时按其白名单裁剪目录；未声明时按最保守口径回落', async () => {
  clearPlatformCapabilityCache();
  const declared = await fetchServiceTypes('https://declared.invalid', {
    fetchImpl: async () => Response.json({ serviceTypes: ['CLI', 'MCP', 'WEB', 'APP'] }),
  });
  assert.equal(declared.declared, true);
  assert.deepEqual(declared.types, ['CLI', 'MCP', 'WEB', 'APP']);

  const legacy = await fetchServiceTypes('https://legacy.invalid', {
    fetchImpl: async () => Response.json({ status: 'ok' }),
  });
  assert.equal(legacy.declared, false);
  assert.deepEqual(legacy.types, ['CLI', 'MCP']);

  const offline = await fetchServiceTypes('https://offline.invalid', {
    fetchImpl: async () => { throw Error('offline'); },
  });
  assert.equal(offline.declared, false);
  assert.deepEqual(offline.types, ['CLI', 'MCP']);

  // 旧平台只接受 CLI/MCP：网页类型必须被剔除，activeId 不得指向被剔除的服务。
  const services = [
    { id: 'dreamina', title: '即梦画布', type: 'CLI' },
    { id: 'local-terminal', title: '本机文件与终端', type: 'CLI' },
    { id: 'browser-page', title: '原生页面 · Computer Use', type: 'WEB' },
  ];
  const trimmed = fitServiceCatalog(services, 'browser-page', legacy);
  assert.equal(trimmed.degraded, true);
  assert.equal(trimmed.services.length, 2);
  assert(!trimmed.services.some((s) => s.type === 'WEB'));
  assert.equal(trimmed.activeId, '');
  assert.equal(trimmed.dropped.length, 1);

  // 平台支持全部类型时目录保持原样。
  const full = fitServiceCatalog(services, 'browser-page', declared);
  assert.equal(full.degraded, false);
  assert.equal(full.services.length, 3);
  assert.equal(full.activeId, 'browser-page');
});

test('平台拒绝服务目录时整轮对话给出可诊断错误，而非空白回复', async () => {
  const root = mkdtempSync('/tmp/cpclaw-catalog-'), actor = 'catalog-user';
  clearPlatformCapabilityCache();
  writeAccountSession(root, { schemaVersion: 1, employeeId: actor, sessionId: 'fixture-session', refreshToken: 'fixture-refresh-token' }, { makeCurrent: true });
  writeFileSync(join(root, 'desktop-connection.json'), JSON.stringify({ platformUrl: 'https://fixture.invalid' }));
  globalThis.fetch = async (url) => {
    if (url.endsWith('/v1/session/refresh')) return Response.json({ employeeId: actor, sessionId: 'fixture-session', refreshToken: 'fixture-refresh-token', accessToken: 'fixture-access' });
    if (url.endsWith('/v1/market')) return Response.json({ connectors: [], items: [] });
    if (url.endsWith('/health')) return Response.json({ status: 'ok' });
    if (url.endsWith('/v1/chat/stream')) return Response.json({ ok: false, message: '应用服务目录无效', reason: '服务类型不被平台接受：WEB' }, { status: 400 });
    throw Error('Unexpected route');
  };
  const service = createChatService(root, () => {}, { runServiceLoop: async () => ({}), executeService: async () => ({ ok: true }) });
  try {
    const { chatId } = await service.dispatch('chat.create', actor, {});
    const sent = await service.dispatch('chat.send', actor, { chatId, requestId: 'catalog-1', text: '调用即梦CLI，生成图片' });
    assert.equal(sent.state, 'error');
    const history = await service.dispatch('chat.history', actor, { chatId });
    const message = history.messages.at(-1);
    assert.match(message.error, /不接受本机服务目录/);
    // 平台拒绝目录必须被识别为可修复项，而不是笼统的“回复未完成”。
    const report = analyzeChat(message, []);
    assert(report.some((f) => f.code === 'SERVICE_CATALOG_REJECTED' && f.status === 'error'));
    // 修复动作：重裁目录并清空能力缓存。
    const repaired = await service.dispatch('chat.diagnoseRepair', actor, { chatId, code: 'SERVICE_CATALOG_REJECTED' });
    assert.equal(repaired.ok, true);
    assert(repaired.repairs.some((r) => r.code === 'SERVICE_CATALOG_REJECTED'));
  } finally {
    service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

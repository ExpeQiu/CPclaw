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

test('local tool catalog is not rejected by the retired chat gateway route',async t=>{
 const root=mkdtempSync('/tmp/cpclaw-catalog-'),actor='catalog-user';writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh'},{makeCurrent:true});writeFileSync(join(root,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
 t.mock.method(globalThis,'fetch',async url=>{if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh',accessToken:'fixture-access'});if(url.endsWith('/v1/me/model-access'))return Response.json({schemaVersion:1,mode:'mock',model:'MiniMax-M3',limitTokens:100000000});if(url.endsWith('/v1/market'))return Response.json({connectors:[],items:[]});throw Error('模型旁路不应被调用');});
 const service=createChatService(root,()=>{},{runServiceLoop:async input=>{input.onAccepted('accepted');assert(input.pipeline.tools.some(t=>t.name==='browser_open'));return {finalResponse:'内核答复'};}});try{const {chatId}=await service.dispatch('chat.create',actor,{});assert.equal((await service.dispatch('chat.send',actor,{chatId,requestId:'catalog',text:'普通问题'})).state,'done');}finally{service.stop();rmSync(root,{recursive:true,force:true});}
});

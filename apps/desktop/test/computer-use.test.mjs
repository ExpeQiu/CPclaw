import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  browserPageService,
  classifyAction,
  compressAxTree,
  executeComputerUse,
  hasPageEntry,
  isSensitiveText,
  isSensitiveUrl,
  pageOriginsForService,
  partitionForOrigins,
  validatePageUrl,
} from '../computer-use.mjs';
import {createServiceRuntime, publicServices} from '../service-runtime.mjs';
import {mkdtempSync} from 'node:fs';

test('page origins cover dreamina, explicit web services, and optional CLI pageUrl', () => {
  assert.deepEqual(pageOriginsForService({ id: 'dreamina', builtin: true }), ['https://jimeng.jianying.com']);
  assert.deepEqual(pageOriginsForService({ id: 'web', type: 'WEB', target: 'https://app.example' }), ['https://app.example']);
  assert.deepEqual(pageOriginsForService({ id: 'cli', type: 'CLI', target: '/bin/tool', pageUrl: 'https://app.example/home' }), ['https://app.example']);
  assert.deepEqual(pageOriginsForService({ id: 'saas', type: 'MCP', target: 'https://saas.example/mcp' }), []);
  assert.equal(hasPageEntry({ id: 'cli', type: 'CLI', target: '/bin/tool' }), false);
  assert.equal(hasPageEntry({ id: 'dreamina', builtin: true }), true);
});

test('validatePageUrl rejects credentials, sensitive query and foreign origins', () => {
  const origins = ['https://app.example'];
  assert.equal(validatePageUrl('https://app.example/path', origins).ok, true);
  assert.equal(validatePageUrl('https://user:pass@app.example/', origins).ok, false);
  assert.equal(validatePageUrl('https://app.example/?token=x', origins).ok, false);
  const foreign = validatePageUrl('https://pay.example/checkout', origins);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.sensitive, true);
  assert.equal(foreign.origin, 'https://pay.example');
});

test('sensitive classifier covers login/pay and password fields', () => {
  assert.equal(isSensitiveText('立即登录'), true);
  assert.equal(isSensitiveText('去支付'), true);
  assert.equal(isSensitiveUrl('https://example.com/oauth/authorize'), true);
  assert.equal(isSensitiveUrl('https://example.com/docs'), false);
  assert.deepEqual(classifyAction({ action: 'snapshot' }), { risk: 'read', sensitive: false });
  assert.equal(classifyAction({ action: 'click' }, { role: 'button', name: '支付', sensitive: true }).sensitive, true);
  assert.equal(classifyAction({ action: 'type' }, { role: 'textbox', name: '密码', password: true }).sensitive, true);
  assert.equal(classifyAction({ action: 'click' }, { role: 'button', name: '生成' }).sensitive, false);
});

test('compressAxTree assigns refs to interactive nodes', () => {
  const { nodes, index } = compressAxTree([
    { nodeId: 1, role: 'none', name: '' },
    { nodeId: 2, backendDOMNodeId: 20, properties: [{ name: 'role', value: { value: 'button' } }, { name: 'name', value: { value: '生成' } }] },
    { nodeId: 3, backendDOMNodeId: 30, properties: [{ name: 'role', value: { value: 'textbox' } }, { name: 'name', value: { value: '密码' } }] },
  ]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].ref, 'e1');
  assert.equal(nodes[0].name, '生成');
  assert.equal(nodes[1].sensitive, true);
  assert.equal(index.get('e1').backendDOMNodeId, 20);
});

test('partition hash is stable per origin family', () => {
  assert.equal(partitionForOrigins(['https://a.example']), partitionForOrigins(['https://a.example']));
  assert.notEqual(partitionForOrigins(['https://a.example']), partitionForOrigins(['https://b.example']));
});

test('executeComputerUse discover and forceApproval on sensitive click even in full mode path', async () => {
  const approvals = [];
  const page = {
    getOrigins: () => ['https://app.example'],
    getUrl: () => 'https://app.example/',
    defaultUrl: () => 'https://app.example/',
    resolveRef: ref => ref === 'e1' ? { ref: 'e1', role: 'button', name: '去支付', sensitive: true } : undefined,
    open: async url => ({ ok: true, url }),
    snapshot: async () => ({ ok: true, nodes: [{ ref: 'e1', role: 'button', name: '去支付', sensitive: true }] }),
    click: async ref => ({ ok: true, ref }),
    reload: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    press: async () => ({ ok: true }),
    wait: async ms => ({ ok: true, ms }),
    allowOrigin() {},
  };
  const discover = await executeComputerUse({ page, request: { action: 'discover' }, signal: AbortSignal.timeout(1000), authorize: async () => {} });
  assert.equal(discover.ok, true);
  assert(discover.capabilities.some(c => c.action === 'snapshot'));

  await executeComputerUse({
    page,
    request: { action: 'click', ref: 'e1', purpose: '支付' },
    signal: AbortSignal.timeout(1000),
    authorize: async details => { approvals.push(details); },
    allowedOrigins: ['https://app.example'],
  });
  assert.equal(approvals[0].forceApproval, true);
  assert.match(approvals[0].title, /登录或支付/);
});

test('runtime routes browser-page and keeps forceApproval under full permission', async () => {
  const approvals = [];
  const page = {
    getOrigins: () => ['https://app.example'],
    getUrl: () => 'https://app.example/',
    resolveRef: () => ({ ref: 'e2', role: 'link', name: '登录', sensitive: true }),
    snapshot: async () => ({ ok: true, nodes: [] }),
    click: async ref => ({ ok: true, ref }),
    open: async url => ({ ok: true, url }),
    reload: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    press: async () => ({ ok: true }),
    wait: async ms => ({ ok: true, ms }),
    allowOrigin() {},
    defaultUrl: () => 'https://app.example/',
  };
  const runtime = createServiceRuntime({
    dataDir: mkdtempSync('/tmp/cpclaw-cu-'),
    isCurrent: () => true,
    getPermission: () => ({ mode: 'full', revision: 1 }),
    approve: async details => { approvals.push(details); return { mode: 'once', creditCeiling: 0 }; },
    computerUsePage: page,
  });
  const context = { actorId: 'a', chatId: 'c', taskId: 't', service: browserPageService };
  const discovered = await runtime.execute(context, { action: 'discover' }, AbortSignal.timeout(1000));
  assert.equal(discovered.ok, true);
  await runtime.execute(context, { action: 'click', ref: 'e2' }, AbortSignal.timeout(1000));
  assert.equal(approvals.some(a => a.forceApproval), true);
  assert(publicServices([]).some(s => s.id === 'browser-page'));
});

test('open outside allowlist without sensitive mark is denied', async () => {
  const page = {
    getOrigins: () => ['https://app.example'],
    getUrl: () => 'https://app.example/',
    allowOrigin() {},
    defaultUrl: () => 'https://app.example/',
    open: async () => { throw Error('should not open'); },
  };
  await assert.rejects(
    () => executeComputerUse({
      page,
      allowedOrigins: ['https://app.example'],
      request: { action: 'open', url: 'https://other.example/' },
      signal: AbortSignal.timeout(1000),
      authorize: async () => {},
    }),
    /允许源/,
  );
});

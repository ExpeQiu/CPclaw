import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorkspaceClient } from '../../../apps/desktop/workspace-client.mjs';
import { fixtureEmployees, listenPlatform, openPlatform } from '../dist/index.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const limit = Date.now() + 4000; while (!predicate()) { if (Date.now() > limit) throw Error('等待条件超时'); await sleep(5); } }
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;

async function setup() {
  const state = { scenario: 'normal', calls: 0, bodies: [], release: null, closed: false };
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); state.bodies.push(body); state.calls++;
    const scenario = state.scenario;
    if (scenario === 'http-error') { res.writeHead(500); res.end(); return; }
    res.on('close', () => { state.closed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(event({ choices: [{ delta: { content: '你好，世界🌏' } }] }));
    const index = bytes.indexOf(Buffer.from('你')) + 1;
    res.write(': keepalive\r\n\r\n'); res.write(bytes.subarray(0, index));
    await sleep(10); res.write(bytes.subarray(index));
    if (scenario === 'hold') await new Promise(resolve => { state.release = resolve; res.once('close', resolve); });
    if (scenario === 'malformed') { res.end('data: {broken}\n\n'); return; }
    if (scenario === 'truncated') { res.end(); return; }
    res.write(event({ choices: [{ delta: { reasoning_content: '不应显示的推理' } }] }));
    res.write(event({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.end(event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 8 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = mkdtempSync('/tmp/cpclaw-chat-http-');
  const opened = openPlatform({ dataDir, port: 0, listenHost: '127.0.0.1', sessionSecret: 'test-session-secret-0123456789abcdef', accessTtlSec: 3600, refreshTtlSec: 7200, seed: { kind: 'fixture', employees: fixtureEmployees }, keyPresent: true, now: () => Date.now() });
  assert.equal(opened.ok, true);
  const app = opened.app;
  const employee = app.login({ employeeId: 'employee-a', password: 'fixture-employee-a', deviceLabel: 'test' });
  const admin = app.login({ employeeId: 'admin', password: 'fixture-admin', deviceLabel: 'test' });
  const server = await listenPlatform(app, { dataDir, port: 0, aiMockMode: false, reportGateway: { mode: 'real', baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'test-key', timeoutMs: 5000 } });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (requestId, options = {}) => fetch(`${base}/v1/chat/stream`, { method: 'POST', headers: { authorization: `Bearer ${options.token ?? employee.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId, messages: options.messages ?? [{ role: 'user', content: '你好' }] }), ...(options.signal ? { signal: options.signal } : {}) });
  return { state, app, employee, admin, base, post, close: async () => { state.release?.(); await server.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); } };
}
async function readLines(response, callback) {
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''; const events = [];
  try {
    while (true) {
      const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) { const value = JSON.parse(line); events.push(value); await callback?.(value); } }
      if (chunk.done) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return events;
}

test('聊天网关增量转发、UTF-8 拆包、完整结束、重放和校验', async () => {
  const s = await setup();
  try {
    assert.equal((await s.post('bad-auth', { token: 'invalid' })).status, 401); assert.equal(s.state.calls, 0);
    assert.equal((await s.post('bad-context', { messages: [{ role: 'system', content: 'x' }] })).status, 400);
    s.state.scenario = 'hold';
    const response = await s.post('first'); assert.equal(response.status, 200);
    let first = false;
    const pending = readLines(response, value => { if (value.event === 'delta') first = true; });
    await until(() => first && s.state.release);
    assert.equal(s.app.readOwnQuota(s.employee.accessToken).quota.concurrentInUse, 1, '首段已收到时调用仍在途');
    s.state.release(); const events = await pending;
    assert.equal(events.filter(e => e.event === 'delta').map(e => e.text).join(''), '你好，世界🌏');
    assert.equal(events.at(-1).event, 'done'); assert.equal(events.at(-1).usage.outputTokens, 8);
    assert.equal(s.app.readOwnQuota(s.employee.accessToken).quota.concurrentInUse, 0);
    assert.equal((await s.post('first')).status, 409); assert.equal(s.state.calls, 1);
    assert.ok(!JSON.stringify(events).includes('不应显示的推理'));
    for (const scenario of ['truncated', 'malformed', 'http-error']) {
      s.state.scenario = scenario;
      const events = await readLines(await s.post(scenario));
      assert.equal(events.at(-1).event, 'error'); assert.ok(!events.some(e => e.event === 'done'));
      assert.equal(s.app.readOwnQuota(s.employee.accessToken).quota.concurrentInUse, 0);
    }
  } finally { await s.close(); }
});

test('聊天断开会取消上游并释放并发；撤销会话后不再转发正文', async () => {
  const s = await setup();
  try {
    s.state.scenario = 'hold'; const controller = new AbortController();
    const response = await s.post('cancel', { signal: controller.signal });
    const reading = readLines(response, value => { if (value.event === 'delta') controller.abort(); }).catch(() => []);
    await reading; await until(() => s.state.closed);
    await until(() => s.app.readOwnQuota(s.employee.accessToken).quota.concurrentInUse === 0);
    s.state.release = null; s.state.closed = false;
    const res = await s.post('revoke'); let seen = false;
    const pending = readLines(res, value => { if (value.event === 'delta') seen = true; });
    await until(() => seen && s.state.release);
    s.app.revoke(s.admin.accessToken, s.employee.sessionId); s.state.release();
    const events = await pending; assert.equal(events.at(-1).event, 'error'); assert.ok(!events.some(e => e.event === 'done'));
  } finally { await s.close(); }
});

test('桌面实际工作进程：登录、聊天历史、上下文、取消、重试、崩溃恢复与账号隔离', async () => {
  const s = await setup();
  const dir = mkdtempSync('/tmp/cpclaw-chat-worker-');
  const desktop = fileURLToPath(new URL('../../../apps/desktop/', import.meta.url));
  const events = []; let worker = createWorkspaceClient(dir, desktop, { onEvent: event => events.push(event) });
  const call = (method, input = {}, actorId = 'employee-a') => worker.request({ method, input, actorId });
  const login = (employeeId) => call('account.login', { platformUrl: s.base, employeeId, password: `fixture-${employeeId}` });
  try {
    assert.equal((await call('account.status')).employeeId, null);
    const loggedIn = await login('employee-a'); assert.equal(loggedIn.ok, true, JSON.stringify(loggedIn));
    const chat = await call('chat.create'); assert.equal(chat.ok, true);
    const send = (requestId, text = '你好', retry = false) => call('chat.send', { chatId: chat.chatId, requestId, text, retry });
    assert.equal((await send('turn1')).state, 'done');
    assert.equal(events.some(e => e.type === 'delta' && e.content === '你好，世界🌏'), true);
    assert.equal((await send('turn1')).code, 'CONFLICT');
    assert.equal((await send('turn2','继续')).state, 'done');
    assert.equal(s.state.bodies.at(-1).messages.filter(m=>m.role!=='system').length, 3);
    assert.equal(s.state.bodies.at(-1).tools[0].function.name,'deliver_document');
    assert.equal(s.state.bodies.at(-1).messages.filter(m=>m.role!=='system')[1].content, '你好，世界🌏');
    s.state.scenario = 'hold'; s.state.release = null;
    const pending = send('turn3', '等待'); await until(() => s.state.release);
    assert.equal((await login('employee-b')).code, 'SLOT_BUSY');
    assert.equal((await send('duplicate')).code, 'SLOT_BUSY');
    assert.equal((await call('chat.cancel', { chatId: chat.chatId })).ok, true);
    assert.equal((await pending).state, 'cancelled');
    const history = await call('chat.history', { chatId: chat.chatId });
    assert.equal(history.messages.at(-1).state, 'cancelled'); assert.ok(history.messages.at(-1).content);
    s.state.release?.(); s.state.scenario = 'normal';
    assert.equal((await send('retry3', '', true)).state, 'done');
    assert.equal((await call('chat.history', { chatId: chat.chatId })).messages.length, 6);
    worker.stop(); worker = createWorkspaceClient(dir, desktop, { onEvent: event => events.push(event) });
    assert.equal((await call('chat.list')).chats[0].id, chat.chatId);
    assert.equal((await call('chat.history', { chatId: chat.chatId })).messages.at(-1).state, 'done');
    s.state.scenario = 'hold'; s.state.release = null;
    const interrupted = send('turn4'); await until(() => s.state.release);
    worker.stop(); await interrupted;
    worker = createWorkspaceClient(dir, desktop); s.state.release?.();
    assert.equal((await call('chat.history', { chatId: chat.chatId })).messages.at(-1).state, 'interrupted');
    assert.equal((await login('employee-b')).ok, true);
    assert.equal((await call('chat.list', {}, 'employee-b')).chats.length, 0);
    assert.equal((await call('chat.history', { chatId: chat.chatId }, 'employee-b')).code, 'NOT_FOUND');
    assert.equal((await call('account.logout', {}, 'employee-b')).ok, true);
    assert.equal((await call('account.status')).employeeId, null);
  } finally { worker.stop(); await s.close(); }
});

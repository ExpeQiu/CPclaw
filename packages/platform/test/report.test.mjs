import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { writeAccountSession } from '../../desktop-host/dist/account-session.js';
import { createWorkspaceClient } from '../../../apps/desktop/workspace-client.mjs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixtureEmployees, listenPlatform, openPlatform } from '../dist/index.js';

const materials = [{ fileName: 'source.md', paragraphs: [{ id: 'p1', text: '已确认事实' }] }];
const report = '# 任务目标\n验证\n# 材料与来源\nsource.md#p1\n# 要点\n已确认事实 source.md#p1\n# 未覆盖项\n无';

test('真实报告 HTTP 网关：鉴权、重放、失败、撤销和取消均守住边界', async () => {
  let calls = 0, scenario = 'success', release;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    calls++;
    if (scenario === 'wait') await new Promise(resolve => { release = resolve; });
    if (scenario === 'error') { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (scenario === 'malformed') { res.write('data: {broken-json}\n\n'); }
    const text = scenario === 'bad-source' ? '# 任务目标\n无来源' : report;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    if (scenario !== 'truncated') res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = mkdtempSync('/tmp/cpclaw-report-test-');
  const opened = openPlatform({ dataDir, port: 0, listenHost: '127.0.0.1', sessionSecret: 'test-session-secret-0123456789abcdef', accessTtlSec: 3600, refreshTtlSec: 7200, seed: { kind: 'fixture', employees: fixtureEmployees }, keyPresent: true, now: () => Date.now() });
  assert.equal(opened.ok, true);
  const app = opened.app;
  const employee = app.login({ employeeId: 'employee-a', password: 'fixture-employee-a', deviceLabel: 'test' });
  const admin = app.login({ employeeId: 'admin', password: 'fixture-admin', deviceLabel: 'test' });
  const server = await listenPlatform(app, { dataDir, port: 0, reportGateway: { mode: 'real', baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'test-provider-key', timeoutMs: 1000 } });
  const post = (id, token = employee.accessToken, signal) => fetch(`http://127.0.0.1:${server.port}/v1/reports/generate`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ requestId: id, goal: '验证', materials }), ...(signal ? { signal } : {}) });
  try {
    assert.equal((await post('unauthorized', 'invalid')).status, 401);
    assert.equal(calls, 0);
    const ok = await post('success'); assert.equal(ok.status, 200);
    const body = await ok.json(); assert.equal(body.text, report); assert.equal(body.usage.inputTokens, 10);
    assert.equal((await post('success')).status, 409); assert.equal(calls, 1);
    for (const bad of ['error', 'bad-source', 'truncated', 'malformed']) {
      scenario = bad;
      const response = await post(bad); assert.equal(response.status, 502); assert.equal((await response.json()).ok, false);
      assert.equal(app.readOwnQuota(employee.accessToken).quota.concurrentInUse, 0);
    }
    scenario = 'wait';
    const pending = post('revoke');
    while (!release) await new Promise(r => setTimeout(r, 5));
    app.revoke(admin.accessToken, employee.sessionId);
    scenario = 'success'; release(); release = undefined;
    assert.equal((await pending).status, 401);
    const renewed = app.login({ employeeId: 'employee-a', password: 'fixture-employee-a', deviceLabel: 'test2' });
    assert.equal(app.readOwnQuota(renewed.accessToken).quota.concurrentInUse, 0);
    scenario = 'wait';
    const controller = new AbortController();
    const cancelled = post('cancel', renewed.accessToken, controller.signal).catch(() => undefined);
    while (!release) await new Promise(r => setTimeout(r, 5));
    controller.abort(); await cancelled;
    await new Promise(r => setTimeout(r, 30));
    scenario = 'success'; release();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(app.readOwnQuota(renewed.accessToken).quota.concurrentInUse, 0);
    // 使用桌面实际工作进程验证取消和预算，不只调用平台接口。
    const dir = mkdtempSync('/tmp/cpclaw-report-worker-');
    const out = `${dir}/out`; mkdirSync(out);
    const source = `${dir}/source.md`; writeFileSync(source, '已确认事实');
    writeAccountSession(dir, { schemaVersion: 1, employeeId: renewed.employeeId, sessionId: renewed.sessionId, refreshToken: renewed.refreshToken }, { makeCurrent: true });
    const savedBase = process.env.CPCLAW_PLATFORM_URL, savedMode = process.env.CPCLAW_REPORT_MODEL_MODE, savedEngine = process.env.CPCLAW_REPORT_ENGINE;
    process.env.CPCLAW_REPORT_ENGINE = 'direct';
    process.env.CPCLAW_PLATFORM_URL = `http://127.0.0.1:${server.port}`;
    process.env.CPCLAW_REPORT_MODEL_MODE = 'real';
    const worker = createWorkspaceClient(dir, fileURLToPath(new URL('../../../apps/desktop/', import.meta.url)));
    const call = (method, input) => worker.request({ method, input, actorId: 'employee-a' });
    const snapshot = call('snapshot', {});
    if (savedBase === undefined) delete process.env.CPCLAW_PLATFORM_URL; else process.env.CPCLAW_PLATFORM_URL = savedBase;
    if (savedMode === undefined) delete process.env.CPCLAW_REPORT_MODEL_MODE; else process.env.CPCLAW_REPORT_MODEL_MODE = savedMode;
    if (savedEngine === undefined) delete process.env.CPCLAW_REPORT_ENGINE; else process.env.CPCLAW_REPORT_ENGINE = savedEngine;
    await snapshot;
    try {
      const task = await call('createTask', { mode: 'execute', outputDir: out, budgetLimitCalls: 1 });
      assert.equal(task.ok, true);
      const initialCalls = calls;
      const outside = await call('stageReport', { taskId: task.taskId, outputDir: dir, materialPath: source });
      assert.equal(outside.code, 'OUTSIDE_GRANT'); assert.equal(calls, initialCalls);
      scenario = 'wait'; release = undefined;
      const generating = call('stageReport', { taskId: task.taskId, outputDir: out, materialPath: source });
      const deadline = Date.now() + 5000;
      while (!release && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
      assert.ok(release, '供应商必须已受理请求');
      const duplicate = await call('stageReport', { taskId: task.taskId, outputDir: out, materialPath: source });
      assert.equal(duplicate.code, 'SLOT_BUSY');
      assert.equal((await call('cancelReport', { taskId: task.taskId })).ok, true);
      assert.equal((await generating).code, 'CANCELLED');
      scenario = 'success'; release();
      await new Promise(r => setTimeout(r, 30));
      const board = await call('snapshot', {});
      assert.equal(board.changes.length, 0); assert.equal(existsSync(`${out}/report.md`), false);
      assert.equal(board.tasks[0].unknownUsageCount, 1);
      assert.equal((await call('stageReport', { taskId: task.taskId, outputDir: out, materialPath: source })).ok, false);
      assert.equal(calls, initialCalls + 1, '预算已用尽时不得调用模型');
    } finally { worker.stop(); }
  } finally { await server.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); }
});

test('真实模式拒绝缺密钥启动，Harness 网关限制模型与工具并保留工具调用流', async () => {
  const { resolvePlatformConfig } = await import('../dist/index.js');
  const baseConfig = { AI_MOCK_MODE: 'false', CPCLAW_SESSION_SECRET: 'test-session-secret-0123456789abcdef', CPCLAW_PLATFORM_SEED: 'fixture' };
  assert.equal(resolvePlatformConfig(baseConfig, { homeDir: '/tmp' }).ok, false);
  const resolved = resolvePlatformConfig({ ...baseConfig, MINIMAX_API_KEY: 'test-key' }, { homeDir: '/tmp' });
  assert.equal(resolved.ok, true); assert.equal(resolved.config.aiMockMode, false);
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, 'MiniMax-M3'); assert.equal(body.max_completion_tokens, 2048);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: 'read_material', arguments: '{}' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dataDir = mkdtempSync('/tmp/cpclaw-harness-gateway-test-');
  const opened = openPlatform({ ...resolved.config, dataDir, port: 0 });
  const server = await listenPlatform(opened.app, { dataDir, port: 0, aiMockMode: false, reportGateway: { mode: 'real', baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'test-key', timeoutMs: 1000 } });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const health = await (await fetch(`${origin}/health`)).json(); assert.equal(health.mode, 'real'); assert.equal(health.aiMockMode, false);
    const login = opened.app.login({ employeeId: 'employee-a', password: 'fixture-employee-a', deviceLabel: 'test' });
    const post = (path, body, id) => fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json', 'x-request-id': id }, body: JSON.stringify(body) });
    assert.equal((await post('/v1/models/invoke', { kind: 'text', requestId: 'old-mock' }, 'old')).status, 409);
    const body = { model: 'MiniMax-M3', messages: [{ role: 'user', content: '读材料' }], tools: [{ type: 'function', function: { name: 'read_material', parameters: { type: 'object', properties: {} } } }] };
    assert.equal((await post('/v1/harness/completions', { ...body, model: 'other' }, 'bad-model')).status, 400);
    assert.equal((await post('/v1/harness/completions', { ...body, tools: [{ function: { name: 'bash' } }] }, 'bad-tool')).status, 400);
    const response = await post('/v1/harness/completions', body, 'loop-ok');
    assert.equal(response.status, 200); const text = await response.text();
    assert.ok(text.includes('read_material')); assert.ok(text.includes('tool_calls')); assert.ok(text.includes('[DONE]'));
    assert.equal((await post('/v1/harness/completions', body, 'loop-ok')).status, 409);
    assert.equal(opened.app.readOwnQuota(login.accessToken).quota.concurrentInUse, 0);
  } finally { await server.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); }
});

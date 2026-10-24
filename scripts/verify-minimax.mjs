// 隔离本机真实模型验收，不修改现有平台/桌面数据或远程部署。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { resolvePlatformConfig, servePlatform } from '@cpclaw/platform';
import { runModelChecks } from '@cpclaw/model-gateway';
import { checkReport } from '@cpclaw/contracts';
import { writeAccountSession } from '@cpclaw/desktop-host';
import { createWorkspaceClient } from '../apps/desktop/workspace-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
const appIndex = process.argv.indexOf('--app');
if (appIndex !== -1) assert.ok(process.argv[appIndex + 1], '--app requires an App bundle path');
const appBundle = appIndex === -1 ? null : resolve(process.argv[appIndex + 1]);
const desktopDir = appBundle ? join(appBundle, 'Contents/Resources/app') : join(root, 'apps/desktop');
const workspaceFactory = appBundle ? (await import(pathToFileURL(join(desktopDir, 'workspace-client.mjs')).href)).createWorkspaceClient : createWorkspaceClient;
const dir = mkdtempSync('/tmp/cpclaw-minimax-');
const evidence = { passed: false, mode: 'real-local-platform', model: 'MiniMax-M3', checks: [], skipped: ['外部 OIDC', '签名安装包', '远程控制面部署', 'Harness 工具循环接真实模型'], directory: dir };
if (appBundle) {
  evidence.appBundle = appBundle;
  evidence.harnessBuild = JSON.parse(readFileSync(join(appBundle, 'Contents/Resources/harness/manifest.json'), 'utf8'));
}
let platform, client;
try {
  let base;
  if (process.argv.includes('--remote')) {
    assert.ok(env.CPCLAW_PLATFORM_URL, '缺少远程平台地址');
    base = env.CPCLAW_PLATFORM_URL;
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.mode, 'real'); assert.equal(health.aiMockMode, false);
    evidence.mode = 'real-remote-platform';
    evidence.skipped = evidence.skipped.filter(item => item !== '远程控制面部署');
    evidence.checks.push('远程平台真实模式健康检查');
  } else {
  const config = resolvePlatformConfig({ ...env, AI_MOCK_MODE: 'true', CPCLAW_REPORT_MODEL_MODE: 'real', CPCLAW_DATA_DIR: join(dir, 'platform'), CPCLAW_PLATFORM_SEED: 'fixture', CPCLAW_SESSION_SECRET: randomUUID().replaceAll('-', '') }, { homeDir: dir });
  assert.equal(config.ok, true, config.message);
  config.config.port = 0;
  platform = await servePlatform(config.config);
  base = `http://127.0.0.1:${platform.port}`;
  }
  if (!process.argv.includes('--remote')) {
  const model = await runModelChecks({ ...env, AI_MOCK_MODE: 'false' });
  assert.equal(model.ok, true, model.message);
  evidence.modelChecks = model.records;
  if (env.CPCLAW_REPORT_ENGINE === 'harness') evidence.skipped = evidence.skipped.filter(item => item !== 'Harness 工具循环接真实模型');
  evidence.checks.push('真实文本/流式/工具及客户端取消/超时检查');
  }
  if (env.CPCLAW_REPORT_ENGINE === 'harness') evidence.skipped = evidence.skipped.filter(item => item !== 'Harness 工具循环接真实模型');
  const login = await fetch(`${base}/v1/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeId: 'employee-a', password: 'fixture-employee-a', deviceLabel: 'real-model-verification' }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  const desktopData = join(dir, 'desktop');
  assert.equal(writeAccountSession(desktopData, { schemaVersion: 1, employeeId: session.employeeId, sessionId: session.sessionId, refreshToken: session.refreshToken }, { makeCurrent: true }).ok, true);
  evidence.checks.push('平台登录并保存员工会话');
  // 模型 key 不进入工作进程，只传会话和平台地址。
  const oldBase = process.env.CPCLAW_PLATFORM_URL;
  const oldMode = process.env.CPCLAW_REPORT_MODEL_MODE;
  const oldEngine = process.env.CPCLAW_REPORT_ENGINE;
  if (env.CPCLAW_REPORT_ENGINE) process.env.CPCLAW_REPORT_ENGINE = env.CPCLAW_REPORT_ENGINE;
  process.env.CPCLAW_PLATFORM_URL = base;
  process.env.CPCLAW_REPORT_MODEL_MODE = 'real';
  if (appBundle) process.env.CPCLAW_NODE_BINARY = join(appBundle, 'Contents/Resources/runtime/bin/node');
  client = workspaceFactory(desktopData, desktopDir);
  const first = client.request({ method: 'snapshot', input: {}, actorId: session.employeeId });
  if (oldBase === undefined) delete process.env.CPCLAW_PLATFORM_URL; else process.env.CPCLAW_PLATFORM_URL = oldBase;
  if (oldMode === undefined) delete process.env.CPCLAW_REPORT_MODEL_MODE; else process.env.CPCLAW_REPORT_MODEL_MODE = oldMode;
  if (oldEngine === undefined) delete process.env.CPCLAW_REPORT_ENGINE; else process.env.CPCLAW_REPORT_ENGINE = oldEngine;
  await first;
  const out = join(dir, 'out'); mkdirSync(out);
  const nonce = `CPCLAW-${randomUUID().slice(0, 8)}`;
  const material = join(dir, 'project-note.md');
  writeFileSync(material, `项目编号为 ${nonce}。\n本轮验收目标是登录后经平台调用真实 MiniMax，审阅通过后才写报告。\n业务质量阈值尚未指定，不能声称已达标。\n`);
  async function call(method, input) {
    const response = await client.request({ method, input, actorId: session.employeeId });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response;
  }
  const task = await call('createTask', { mode: 'execute', outputDir: out, budgetLimitCalls: 2 });
  const generated = await call('stageReport', { taskId: task.taskId, outputDir: out, materialPath: material });
  if (env.CPCLAW_REPORT_ENGINE === 'harness') {
    assert.ok(generated.harness.toolCalls >= 1); assert.ok(generated.harness.modelCalls >= 2);
    assert.equal(generated.harness.childCommandSeenAfterClose, false);
    evidence.harness = generated.harness;
    evidence.checks.push('Harness 真实模型 → read_material → 模型续答；子进程已回收');
  }
  assert.equal(existsSync(join(out, 'report.md')), false);
  evidence.checks.push('真实生成完成仍未落盘');
  await call('decide', { changeId: generated.changeId, decision: 'accept' });
  const report = readFileSync(join(out, 'report.md'), 'utf8');
  assert.equal(checkReport(report, ['project-note.md']).ok, true);
  assert.ok(report.includes(nonce), '报告必须包含本次随机材料的项目编号');
  for (const id of ['p1', 'p2', 'p3']) assert.ok(report.includes(`project-note.md#${id}`));
  evidence.checks.push('审阅后落盘；随机事实、四节结构和三处来源检查通过');
  evidence.report = join(out, 'report.md');
  const board = await call('snapshot', {});
  assert.equal(board.tasks.find(t => t.taskId === task.taskId).spentCalls, generated.harness?.modelCalls ?? 1);
  evidence.checks.push('本地任务调用次数与实际模型调用一致');
  if (process.argv.includes('--cancel')) {
    assert.equal(env.CPCLAW_REPORT_ENGINE, 'harness');
    const cancelledTask = await call('createTask', { mode: 'execute', outputDir: out, budgetLimitCalls: 2 });
    const pending = client.request({ method: 'stageReport', input: { taskId: cancelledTask.taskId, outputDir: out, materialPath: material }, actorId: session.employeeId });
    const deadline = Date.now() + 20000;
    let count = 0;
    while (Date.now() < deadline) {
      const current = await call('snapshot', {});
      count = current.tasks.find(t => t.taskId === cancelledTask.taskId).spentCalls;
      if (count >= 2) break;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(count, 2, '等待材料工具返回后的第二次真实模型调用');
    await new Promise(r => setTimeout(r, 200));
    await call('cancelReport', { taskId: cancelledTask.taskId });
    const cancelled = await pending;
    assert.equal(cancelled.ok, false); assert.equal(cancelled.code, 'CANCELLED');
    const after = await call('snapshot', {});
    assert.equal(after.changes.some(c => c.taskId === cancelledTask.taskId), false);
    assert.equal(after.tasks.find(t => t.taskId === cancelledTask.taskId).spentCalls, 2);
    let inUse = 1;
    for (let i = 0; i < 30; i++) {
      const quotaResponse = await fetch(`${base}/v1/me/quota`, { headers: { authorization: `Bearer ${session.accessToken}` } });
      assert.equal(quotaResponse.status, 200);
      inUse = (await quotaResponse.json()).quota.concurrentInUse;
      if (inUse === 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(inUse, 0);
    evidence.checks.push('第二次真实模型调用中取消；无新待审变更、无新增模型调用、远端并发位已释放');
  }
  evidence.passed = true;
} finally {
  if (client) {
    try {
      const logout = await client.request({method:'account.logout',input:{},actorId:'employee-a'});
      evidence.sessionRevoked = logout.ok === true && logout.remoteRevoked === true;
    } catch { evidence.sessionRevoked = false; }
    client.stop();
  }
  await platform?.close();
  evidence.finishedAt = new Date().toISOString();
  const path = join(dir, 'evidence.json');
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, evidence: path }));
}

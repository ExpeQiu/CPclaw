// 以隔离桌面账号数据验证远程真实聊天；不会读取用户现有会话或打印凭证。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceClient } from '../apps/desktop/workspace-client.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || process.env.CPCLAW_PLATFORM_URL;
if (!base) throw Error('需要指定远程平台地址');
const dataDir = mkdtempSync('/tmp/cpclaw-chat-real-');
const evidence = { passed: false, base, mode: 'real', directory: dataDir, checks: [], finishedAt: '' };
const events = [];
let cancelRequest = '', cancelling;
const worker = createWorkspaceClient(dataDir, process.env.CPCLAW_TEST_DESKTOP_DIR || join(root,'apps/desktop'), { onEvent(event) {
  events.push({ ...event, receivedAt: Date.now() });
  if (event.requestId === cancelRequest && event.type === 'delta' && !cancelling) cancelling = call('chat.cancel', { chatId: event.chatId });
} });
async function call(method, input = {}) { return worker.request({ method, input, actorId: 'employee-a' }); }
try {
  const health = await (await fetch(base + '/health', { signal: AbortSignal.timeout(8000) })).json();
  assert.equal(health.mode, 'real');
  const login = await call('account.login', { platformUrl: base, employeeId: 'employee-a', password: 'fixture-employee-a' });
  assert.equal(login.ok, true, JSON.stringify(login));
  const created = await call('chat.create'); assert.equal(created.ok, true, JSON.stringify(created));
  const chatId = created.chatId, nonce = 'CHAT-' + randomUUID().slice(0, 8);
  const first = await call('chat.send', { chatId, requestId: randomUUID(), text: `请记住本轮测试码 ${nonce}，只回复“已记住”。` });
  assert.equal(first.state, 'done', JSON.stringify(first));
  const secondId = randomUUID();
  const second = await call('chat.send', { chatId, requestId: secondId, text: '上一条消息中的测试码是什么？只输出测试码。' });
  assert.equal(second.state, 'done', JSON.stringify(second));
  const history = await call('chat.history', { chatId });
  assert.ok(history.messages.at(-1).content.includes(nonce), '真实模型必须从前文恢复随机测试码');
  const deltaIndex = events.findIndex(e => e.requestId === secondId && e.type === 'delta');
  const finishIndex = events.findIndex(e => e.requestId === secondId && e.type === 'finish');
  assert.ok(deltaIndex >= 0 && finishIndex > deltaIndex, '桌面工作进程应在完成事件前收到正文增量');
  assert.ok(events.some(e => e.type === 'mode' && e.mode === 'real'));
  evidence.checks.push('真实平台登录', '独立桌面工作进程接收真实正文增量', '多轮上下文恢复随机测试码', '完成回复本地保存');
  cancelRequest = randomUUID();
  const cancelled = await call('chat.send', { chatId, requestId: cancelRequest, text: '请逐行列出从 1 到 300 的中文数字，每行解释一个数字的含义。' });
  assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled));
  await cancelling;
  const partial = await call('chat.history', { chatId });
  assert.equal(partial.messages.at(-1).state, 'cancelled');
  assert.ok(partial.messages.at(-1).content.length > 0);
  evidence.checks.push('收到首段后取消真实请求，保留部分回复');
  evidence.deltaEvents = events.filter(e => e.type === 'delta').length;
  evidence.passed = true;
} finally {
  await call('account.logout').catch(() => {}); worker.stop();
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(dataDir, 'evidence.json'), JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
}

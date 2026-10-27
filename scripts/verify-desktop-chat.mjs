// Electron 端到端验证：真实 IPC/Node 工作进程 + 隔离 Mock 平台，不连接生产服务。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--platform-child')) {
  const { openPlatform, listenPlatform, fixtureEmployees } = await import('../packages/platform/dist/index.js');
  const dataDir = mkdtempSync('/tmp/cpclaw-chat-ui-platform-');
  const opened = openPlatform({ dataDir, port: 0, listenHost: '127.0.0.1', sessionSecret: 'ui-test-session-secret-0123456789abcdef', accessTtlSec: 3600, refreshTtlSec: 7200, seed: { kind: 'fixture', employees: fixtureEmployees }, keyPresent: false, now: () => Date.now() });
  if (!opened.ok) throw Error(opened.message);
  const server = await listenPlatform(opened.app, { dataDir, port: 0, aiMockMode: true });
  process.stdout.write(JSON.stringify({ port: server.port }) + '\n');
  process.on('SIGTERM', () => { void server.close().then(() => process.exit(0)); });
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron');
  const { createWorkspaceClient } = await import('../apps/desktop/workspace-client.mjs');
  const { readCurrentAccountSession } = await import('../packages/desktop-host/dist/account-session.js');
  const desktopDir = process.env.CPCLAW_TEST_DESKTOP_DIR || join(root,'apps/desktop');
  const dataDir = mkdtempSync('/tmp/cpclaw-chat-ui-');
  const output = join(dataDir, 'out'); mkdirSync(output);
  let platform, worker;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.whenReady().then(async () => {
  try {
    const remoteBase = process.env.CPCLAW_CHAT_UI_REAL_BASE;
    let port;
    if (!remoteBase) {
    platform = spawn(process.env.CPCLAW_NODE_BINARY || 'node', [fileURLToPath(import.meta.url), '--platform-child'], { cwd: root, stdio: ['ignore','pipe','pipe'] });
    platform.stderr.on('data', () => {});
    port = await new Promise((resolvePort, reject) => {
      const timeout = setTimeout(() => reject(Error('测试平台未启动')), 8000);
      createInterface({input:platform.stdout}).on('line', line => { const result = JSON.parse(line); if(result.port) {clearTimeout(timeout);resolvePort(result.port);} });
      platform.on('error',reject);
    });
    }
    const base = remoteBase || `http://127.0.0.1:${port}`;
    const w = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { preload: join(desktopDir,'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    ipcMain.handle('extension.action',(_event,input)=>({ok:true,remembered:false}));
    const errors=[];
    w.webContents.on('console-message', (_e,level,message) => { if(level===3) errors.push(message); });
    worker = createWorkspaceClient(dataDir, desktopDir, { onEvent:event=>w.webContents.send('chat.event',event) });
    ipcMain.handle('workspace.call',(_e,call)=>{
      const session=readCurrentAccountSession(dataDir);
      const actorId=session.ok ? session.session?.employeeId : null;
      if(!actorId&&!call.method.startsWith('account.')) return {ok:false,message:'请先登录'};
      return worker.request({...call,actorId});
    });
    const js = code => w.webContents.executeJavaScript(code);
    async function until(code) { const limit=Date.now()+(process.env.CPCLAW_CHAT_UI_REAL_BASE?70000:8000);while(!await js(code)){if(Date.now()>limit)throw Error(`UI 条件超时: ${code}`);await sleep(15);} }
    async function login(id) {
      await js(`openPanel('settings');byId('platform-url').value='${base}';byId('employee-id').value='${id}';byId('account-password').value='fixture-${id}';byId('account-login').click()`);
      await until(`chatAccount==='${id}' && !byId('account-login').dataset.busy`);
    }
    await w.loadFile(join(desktopDir,'renderer/index.html')); await login('employee-a');
    if (remoteBase) {
      await js(`byId('close-panel').click();byId('note').value='用中文列出五条高效整理项目资料的建议，每条约30字。';byId('chat-send').click()`);
      await until(`Boolean(runningChatId)&&chatMessages.some(m=>m.role==='assistant'&&m.content.trim().length>3)`);
      await sleep(50);
      const screenshots = process.env.CPCLAW_CHAT_SCREENSHOTS || dataDir; mkdirSync(screenshots,{recursive:true});
      writeFileSync(join(screenshots,'desktop-chat-real-streaming.png'),(await w.webContents.capturePage()).toPNG());
      await until(`!runningChatId&&chatMessages.at(-1)?.state==='done'&&!byId('chat-send').dataset.busy`);
      await sleep(150);
      if (await js(`chatMessages.at(-1).content.includes('Mock 演示')`)) throw Error('真实平台返回了 Mock 文本');
      writeFileSync(join(screenshots,'desktop-chat-real.png'),(await w.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({realModelUI:true,streaming:true,finished:true,screenshots}));
      await js(`chatCall('account.logout')`); worker.stop(); app.exit(0); return;
    }
    await js(`byId('close-panel').click();byId('note').value='你好 <img src=x onerror=alert(1)>，请说明你能做什么。';byId('chat-send').click()`);
    await until(`Boolean(runningChatId) && chatMessages.some(m=>m.role==='assistant'&&m.content.length>0)`);
    const streaming = await js(`chatMessages.at(-1).state==='streaming'&&!byId('chat-stop').hidden`);
    if(!streaming)throw Error('未展示流式中间态');
    if(!await js(`document.querySelector('.chat-message.assistant .chat-elapsed')?.textContent.includes('处理中')`))throw Error('处理中没有计时');
    if(!await js(`elapsedLabel({startedAt:1000,state:'streaming'},66500).includes('1 分 5 秒')&&elapsedLabel({startedAt:1000,finishedAt:4000,state:'done'},900000).includes('3 秒')`))throw Error('秒数或结束后的计时不准确');
    const streamedLength=await js(`window.__streamNode=byId('chat-messages').querySelector('.chat-message.assistant .message-body');chatMessages.at(-1).content.length`);
    await until(`chatMessages.at(-1).content.length>${streamedLength}`);
    if(!await js(`window.__streamNode===byId('chat-messages').querySelector('.chat-message.assistant .message-body')`))throw Error('增量输出重建了消息节点');
    await until(`!runningChatId && chatMessages.at(-1)?.state==='done'&&!byId('chat-send').dataset.busy`);
    if(await js(`byId('chat-messages').querySelector('img')!==null`)) throw Error('消息被当成 HTML 执行');
    await js(`byId('note').value='请接着上一条继续';byId('chat-send').click()`);
    await until(`chatMessages.length===4 && !runningChatId && chatMessages.at(-1)?.state==='done'&&!byId('chat-send').dataset.busy`);
    if(!await js(`chatMessages.at(-1).content.includes('3 条消息')`))throw Error('未携带多轮上下文');
    await js(`byId('note').value='请再继续，并补充说明';byId('chat-send').click()`);
    await until(`runningChatId && chatMessages.at(-1)?.content.length>0`);
    await js(`byId('chat-stop').click()`);await until(`!runningChatId&&chatMessages.at(-1)?.state==='cancelled'`);
    if(await js(`chatMessages.at(-1).activities?.some(s=>s.state==='running')`))throw Error('停止后步骤仍显示执行中');
    if(!await js(`!byId('chat-retry').hidden`))throw Error('停止后没有重试入口');
    if(await js(`byId('chat-diagnose').textContent`)!=='自诊断')throw Error('顶部自诊断入口缺失');
    await js(`byId('chat-diagnose').click()`);
    await until(`byId('diagnostics-dialog').open&&!byId('chat-diagnose').dataset.busy`);
    if(!await js(`byId('diagnostics-body').textContent.includes('上次回复未完成')&&byId('diagnostics-body').textContent.includes('平台连接及账号会话验证通过')`))throw Error('自诊断未展示持久化异常及连接检查');
    writeFileSync(join(dataDir,'desktop-self-diagnosis.png'),(await w.webContents.capturePage()).toPNG());
    w.setSize(800,720);await sleep(100);
    if(!await js(`byId('diagnostics-dialog').getBoundingClientRect().width<=innerWidth`))throw Error('自诊断窄窗口溢出');
    await js(`byId('diagnostics-close').click();byId('rail-documents').click()`);
    if(!await js(`!byId('panel-documents').hidden`))throw Error('左侧文档入口失效');
    await js(`byId('close-panel').click()`);w.setSize(1280,860);

    await js(`byId('chat-retry').click()`);await until(`!runningChatId&&chatMessages.at(-1)?.state==='done'&&!byId('chat-send').dataset.busy`);
    await until(`byId('task-title').textContent!=='新聊天'`);
    const expected=await js(`({id:currentChatId,text:chatMessages.at(-1).content,count:chatMessages.length,startedAt:chatMessages.at(-1).startedAt,finishedAt:chatMessages.at(-1).finishedAt})`);
    await w.webContents.reload();await until(`currentChatId==='${expected.id}'&&chatMessages.length===${expected.count}`);
    if(!await js(`chatMessages.at(-1).startedAt===${expected.startedAt}&&chatMessages.at(-1).finishedAt===${expected.finishedAt}`))throw Error('重启后计时记录不一致');
    if(await js(`chatMessages.at(-1).content`) !== expected.text)throw Error('刷新后历史不一致');
    // 工作模式与通用 SaaS 服务选择，不产生本机命令。
    await js(`(async()=>{const r=await chatCall('market.call',{action:'connector-save',input:{title:'工单系统',type:'MCP',target:'https://saas.example/mcp'}});window.__saasId=r.connector.id;})()`);
    await js(`byId('mode-service').click()`);await until(`byId('extension-picker').open&&document.querySelector('[data-service="'+window.__saasId+'"]')!==null`);
    await js(`document.querySelector('[data-service="'+window.__saasId+'"]').click();byId('extension-start').click()`);
    await until(`chatExecution.service===window.__saasId&&!byId('extension-picker').open`);
    if(!await js(`!byId('panel-extensions').hidden&&!byId('extension-cli-panel').hidden&&byId('mode-service').textContent==='工单系统'&&byId('extension-native').hidden`))throw Error('CLI 服务选择没有打开通用操作面板');
    const modeScreenshots=process.env.CPCLAW_CHAT_SCREENSHOTS||dataDir;mkdirSync(modeScreenshots,{recursive:true});
    writeFileSync(join(modeScreenshots,'desktop-cli-saas-mode.png'),(await w.webContents.capturePage()).toPNG());
    const saasId=await js('window.__saasId');await w.webContents.reload();await until(`chatExecution.service==='${saasId}'`);
    if(await js(`Boolean(byId('mode-chat')||byId('mode-cli'))`))throw Error('自然对话不应要求选择模式');
    const screenshots=process.env.CPCLAW_CHAT_SCREENSHOTS || dataDir;
    mkdirSync(screenshots,{recursive:true});
    writeFileSync(join(screenshots,'desktop-chat.png'),(await w.webContents.capturePage()).toPNG());
    w.setSize(800,720);await sleep(100);
    if(await js('document.documentElement.scrollWidth>innerWidth'))throw Error('窄窗口横向溢出');
    writeFileSync(join(screenshots,'desktop-chat-narrow.png'),(await w.webContents.capturePage()).toPNG());
    await login('employee-b');
    if(await js('chats.length!==0||chatMessages.length!==0'))throw Error('账号切换后泄漏聊天历史');
    await login('employee-a');await js(`selectChat('${expected.id}')`);await until(`chatMessages.length===${expected.count}`);
    if(!await js(`!byId('new-task')&&!byId('mode')&&!byId('budget')&&!byId('create')&&byId('legacy-history').hidden`))throw Error('统一入口仍要求用户选择任务模式');
    await js(`(async()=>{await chatCall('createTask',{mode:'execute',outputDir:${JSON.stringify(output)},budgetLimitCalls:4});await refresh();byId('legacy-history').open=true;document.querySelector('#tasks button').click();})()`);
    await until(`desktopView==='task'&&Boolean(selectedTaskId())`);
    if(!await js(`!byId('enqueue').hidden&&byId('chat-send').hidden`))throw Error('报告任务输入入口混淆');
    if(errors.length)throw Error(errors.join('\n'));
    console.log(JSON.stringify({naturalConversation:true,noModeSwitch:true,saasPicker:true,serviceReload:true,elapsedTimer:true,timingReload:true,stableStreaming:true,streaming:true,multiTurn:true,cancel:true,retry:true,historyReload:true,accountIsolation:true,taskCompatibility:true,unifiedEntry:true,xssSafe:true,narrowLayout:true,screenshots}));
    worker.stop();platform?.kill();app.exit(0);
  } catch(error) {console.error(error);worker?.stop();platform?.kill();app.exit(1);}
  });
}

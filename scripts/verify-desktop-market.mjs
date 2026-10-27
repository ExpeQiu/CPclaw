// Electron 端到端验证：真实 IPC/Node 工作进程 + 隔离 Mock 平台，不连接生产服务。
import { spawn, spawnSync } from 'node:child_process';
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
    ipcMain.handle('extension.action',()=>({ok:true,remembered:false}));
    const errors=[];
    w.webContents.on('console-message', (_e,level,message) => { if(level===3) { errors.push(message); console.error(message); } });
    worker = createWorkspaceClient(dataDir, desktopDir, { onEvent:event=>w.webContents.send('chat.event',event) });
    ipcMain.handle('workspace.call',(_e,call)=>{
      const session=readCurrentAccountSession(dataDir);
      const actorId=session.ok ? session.session?.employeeId : null;
      if(!actorId&&!call.method.startsWith('account.')) return {ok:false,message:'请先登录'};
      return worker.request({...call,actorId});
    });
    const js = code => w.webContents.executeJavaScript(code);
    async function until(code) { const limit=Date.now()+(process.env.CPCLAW_CHAT_UI_REAL_BASE?70000:8000);while(!await js('('+code+') && !marketFrame.contentDocument?.body?.hasAttribute("aria-busy")')){if(Date.now()>limit)throw Error(`UI 条件超时: ${code}`);await sleep(15);} }
    async function login(id) {
      await js(`openPanel('settings');byId('platform-url').value='${base}';byId('employee-id').value='${id}';byId('account-password').value='fixture-${id}';byId('account-login').click()`);
      await until(`chatAccount==='${id}' && !byId('account-login').dataset.busy`);
    }
    await w.loadFile(join(desktopDir,'renderer/index.html')); await login('employee-a');

    // 隔离回归数据：验证消息底部保存过程、点赞与多轮后提炼草稿，不连接真实即梦。
    await js(`byId('close-panel').click();byId('note').value='本地回归样例：整理图片创作流程';byId('chat-send').click()`);
    await until(`chatMessages.at(-1)?.state==='done'&&!runningChatId&&!byId('chat-send').dataset.busy`);
    const assistantId=await js('chatMessages.at(-1).id');
    const receipt={step:1,service:{id:'dreamina',title:'即梦画布',type:'CLI'},request:{action:'call',args:['model','list','--type','image'],purpose:'读取创作模型目录（本地回归夹具）'},result:{ok:true,data:{items:[]}}};
    const seeded=spawnSync(process.env.CPCLAW_NODE_BINARY||'node',['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.prepare('INSERT INTO chat_service_steps VALUES(?,?,?)').run(process.argv[2],1,process.argv[3]);db.prepare('UPDATE chat_messages SET content=? WHERE id=?').run('已读取创作模型目录并整理可复用步骤，包含发现能力、授权与结果核对。',process.argv[2]);db.close();",join(dataDir,'chat.sqlite'),assistantId,JSON.stringify(receipt)],{encoding:'utf8'});if(seeded.status!==0)throw Error(seeded.stderr);
    await js('selectChat(currentChatId)');await until('chatMessages.at(-1)?.hasServiceSteps');
    if(!await js(`[...byId('chat-messages').querySelectorAll('button')].some(b=>b.textContent==='保存创作过程.md')&&[...byId('chat-messages').querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='点赞有用')&&![...byId('chat-messages').querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='提炼成Skill')`))throw Error('单轮应有保存/点赞，且不应出现提炼 Skill');
    await js(`byId('note').value='补充第二轮：继续完善流程说明';byId('chat-send').click()`);
    await until(`chatMessages.filter(m=>m.role==='user').length>=2&&chatMessages.at(-1)?.state==='done'&&!runningChatId`);
    await js('selectChat(currentChatId)');await until(`chatMessages.some(m=>m.id==='${assistantId}'&&m.hasServiceSteps)&&[...byId('chat-messages').querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='提炼成Skill')`);
    if(!await js(`[...byId('chat-messages').querySelectorAll('button')].some(b=>b.textContent==='保存创作过程.md')&&[...byId('chat-messages').querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='提炼成Skill')&&[...byId('chat-messages').querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='点赞有用')`))throw Error('缺少创作过程/点赞/Skill 图标操作');
    const skillShots=join(root,'docs/verification/market-v2/skill-draft');mkdirSync(skillShots,{recursive:true});
    writeFileSync(join(skillShots,'message-actions.png'),(await w.webContents.capturePage()).toPNG());
    await js(`[...byId('chat-messages').querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='点赞有用').click()`);
    await until(`[...byId('chat-messages').querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='取消点赞')`);
    await js(`[...byId('chat-messages').querySelectorAll('button')].find(b=>b.textContent==='保存创作过程.md').click()`);
    await until(`chatArtifacts.some(a=>a.name==='创作过程.md')&&document.getElementById('document-preview').textContent.includes('model')`);
    await js(`[...byId('chat-messages').querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='提炼成Skill').click()`);
    await until(`!marketOverlay.hidden&&marketFrame.contentDocument?.getElementById('editor')?.hidden===false&&marketFrame.contentDocument.getElementById('body').value.includes('disable-model-invocation: true')`);
    if(!await js(`marketFrame.contentDocument.getElementById('message').textContent.includes('尚未发布或启用')`))throw Error('草稿状态不明确');
    writeFileSync(join(skillShots,'skill-draft.png'),(await w.webContents.capturePage()).toPNG());
    await js('marketClose.click()');
    await js(`byId('rail-market').click()`);
    await until(`!marketOverlay.hidden && marketFrame.contentDocument?.getElementById('nav')?.children.length===4`);
    await js(`marketFrame.contentDocument.getElementById('nav').querySelectorAll('button')[0].click()`);
    await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('暂无')`);
    const frame = async code => { try { return await js(`marketFrame.contentWindow.eval(${JSON.stringify(code)})`); } catch(e) { console.error("FAILED UI STEP", JSON.stringify(code)); throw e; } };
    await frame(`document.getElementById('nav').querySelectorAll('button')[3].click()`);
    await until(`marketFrame.contentDocument.getElementById('heading').textContent==='技能创作'`);
    await frame(`document.getElementById('manual').click();document.getElementById('title').value='前台验证技能';document.getElementById('description').value='信息检查';document.getElementById('body').value='# 检查方法：请先核对来源。';document.getElementById('example-input').value='合成材料';document.getElementById('example-output').value='核对结果';document.getElementById('editor').requestSubmit()`);
    await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('前台验证技能')`);
    await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='个人使用').click()`);
    await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('个人可用')`);
    await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='提交审核').click()`);
    await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('待审核')`);
    await js(`marketClose.click()`); await login('admin');await js(`byId('rail-market').click()`);
    await until(`marketFrame.contentDocument?.getElementById('nav')?.children.length===5`);
    await frame(`document.getElementById('nav').querySelectorAll('button')[4].click()`);
    await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('前台验证技能')`);
    await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='通过').click()`);
    await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('暂无')`);
    await js(`marketClose.click()`);await login('employee-a');await js(`byId('rail-market').click()`);
    await until(`marketFrame.contentDocument?.getElementById('nav')?.children.length===4`);
    await frame(`document.getElementById('tabs').querySelectorAll('button')[1].click()`);
    await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('前台验证技能')`);
    await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='安装').click()`);
    await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('用于新聊天')`);
    const screenshots=join(root,'docs/verification/market-v2');mkdirSync(screenshots,{recursive:true});
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    writeFileSync(join(screenshots,'desktop-market.png'),(await w.webContents.capturePage()).toPNG());
    await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='用于新聊天').click()`);
    await until(`marketOverlay.hidden && byId('task-title').textContent==='前台验证技能'`);
    await until(`!byId('chat-skill-context').hidden&&byId('chat-skill-context').textContent.includes('前台验证技能')`);
    await login('admin');await js(`byId('rail-market').click()`);await until(`marketFrame.contentDocument?.getElementById('nav')?.children.length===5`);
    await frame(`document.getElementById('official-import').click()`);
    await until(`marketFrame.contentDocument.getElementById('list').querySelectorAll('article').length===6`);
    for(let i=0;i<6;i++){
      await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='提交审核').click()`);
      await until(`marketFrame.contentDocument.getElementById('list').querySelectorAll('article').length===6&&[...marketFrame.contentDocument.querySelectorAll('article button')].filter(b=>b.textContent==='提交审核').length===${5-i}`);
    }
    await frame(`document.getElementById('nav').querySelectorAll('button')[4].click()`);await until(`marketFrame.contentDocument.getElementById('list').querySelectorAll('article').length===6`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');writeFileSync(join(screenshots,'review-queue.png'),(await w.webContents.capturePage()).toPNG());
    for(let i=0;i<6;i++){
      await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='通过').click()`);
      await until(`marketFrame.contentDocument.getElementById('list').querySelectorAll('article').length===${5-i}`);
    }
    await js('marketClose.click()');await login('employee-a');await js(`byId('rail-market').click()`);await until(`marketFrame.contentDocument?.getElementById('list')?.querySelectorAll('article').length===6`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');writeFileSync(join(screenshots,'official-catalog.png'),(await w.webContents.capturePage()).toPNG());
    await frame(`document.getElementById('search').value='汇报材料';document.getElementById('search').dispatchEvent(new Event('input'))`);
    await until(`marketFrame.contentDocument.getElementById('list').querySelectorAll('article').length===1&&marketFrame.contentDocument.getElementById('list').textContent.includes('材料报告')`);
    await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='详情').click()`);await until(`!marketFrame.contentDocument.getElementById('details').hidden&&marketFrame.contentDocument.getElementById('details').textContent.includes('效果示例')`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');writeFileSync(join(screenshots,'skill-detail.png'),(await w.webContents.capturePage()).toPNG());
    await frame(`document.getElementById('close-details').click();document.getElementById('nav').querySelectorAll('button')[2].click()`);await until(`marketFrame.contentDocument.getElementById('heading').textContent==='连接器'`);
    await frame(`document.getElementById('nav').querySelectorAll('button')[0].click()`);await until(`marketFrame.contentDocument.getElementById('search').value==='汇报材料'&&marketFrame.contentDocument.getElementById('list').querySelectorAll('article').length===1`);
    w.setSize(640,820);await until(`marketFrame.contentDocument.documentElement.scrollWidth<=marketFrame.contentDocument.documentElement.clientWidth`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');writeFileSync(join(screenshots,'market-narrow.png'),(await w.webContents.capturePage()).toPNG());w.setSize(1280,860);
    await frame(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await until(`marketOverlay.hidden`);await js(`byId('rail-market').click()`);await until(`!marketOverlay.hidden&&marketFrame.contentDocument.getElementById('search').value==='汇报材料'`);
    await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='安装').click()`);await until(`marketFrame.contentDocument.getElementById('list').textContent.includes('用于新聊天')`);
    await frame(`[...document.querySelectorAll('article button')].find(b=>b.textContent==='用于新聊天').click()`);await until(`marketFrame.contentDocument.getElementById('use-dialog').open`);
    await frame(`document.querySelector('#use-inputs textarea').value='合成试点记录：10人参与，8人完成，失败原因待确认。';document.getElementById('use-form').requestSubmit()`);
    await until(`marketOverlay.hidden&&byId('chat-skill-context').textContent.includes('材料报告')&&byId('note').value.includes('合成试点记录')`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');writeFileSync(join(screenshots,'chat-skill-binding.png'),(await w.webContents.capturePage()).toPNG());
    if(errors.length)throw Error(errors.join('\n'));
    console.log(JSON.stringify({saveCreationProcess:true,distillSkill:true,draftEditor:true,marketEmpty:true,iframeIPC:true,create:true,personal:true,submit:true,adminReview:true,install:true,useInChat:true,officialImport:true,officialPublish:true,aliasSearch:true,skillDetail:true,inputPreparation:true,chatSkillBinding:true,filterMemory:true,narrowWindow:true,escapeReturn:true,screenshots}));
    worker.stop();platform?.kill();app.exit(0);
  }catch(error){console.error(error);worker?.stop();platform?.kill();app.exit(1);}
  });
}

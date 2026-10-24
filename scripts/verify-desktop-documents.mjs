// Electron 端到端验证：真实 IPC/Node 工作进程 + 隔离 Mock 平台，不连接生产服务。
import { spawn } from 'node:child_process';
import { realpathSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--platform-child')) {
  const { documentModelFixture } = await import('./document-model-fixture.mjs');
  const upstream=documentModelFixture(({context,body})=>body.messages.at(-1)?.content.includes('请说明验收标准') ? {kind:'answer',content:body.messages.at(-1).content.includes('AUTO-LOCAL-873')?'已根据项目标准核实 AUTO-LOCAL-873。':'没有检索到项目标准。'} : body.messages.at(-1)?.content==='你好，介绍一下你自己' ? {kind:'answer',content:'你好，我可以回答问题，也可以帮你完成文档。'} : ({kind:'document',slow:true,content:'> **来源文档**：项目材料\n> **文档性质**：观点整理。\n\n# 资料整理\n\n## 步骤\n- 核对来源\n- 整理内容'+(context.active?'\n\n## 验收标准\n检查来源完整性。':'')+(body.messages.some(m=>m.content.includes('项目材料：验收必须检查原始来源'))?'\n\n## 材料依据\n原始来源已纳入。':'')}));
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const { openPlatform, listenPlatform, fixtureEmployees } = await import('../packages/platform/dist/index.js');
  const dataDir = mkdtempSync('/tmp/cpclaw-chat-ui-platform-');
  const opened = openPlatform({ dataDir, port: 0, listenHost: '127.0.0.1', sessionSecret: 'ui-test-session-secret-0123456789abcdef', accessTtlSec: 3600, refreshTtlSec: 7200, seed: { kind: 'fixture', employees: fixtureEmployees }, keyPresent: true, now: () => Date.now() });
  if (!opened.ok) throw Error(opened.message);
  const server = await listenPlatform(opened.app, { dataDir, port: 0, aiMockMode: false, reportGateway:{mode:"real",baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:"test",timeoutMs:5000} });
  process.stdout.write(JSON.stringify({ port: server.port }) + '\n');
  process.on('SIGTERM', () => { void server.close().then(() => process.exit(0)); });
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron');
  const { createWorkspaceClient } = await import('../apps/desktop/workspace-client.mjs');
  const { readCurrentAccountSession } = await import('../packages/desktop-host/dist/account-session.js');
  const desktopDir = process.env.CPCLAW_TEST_DESKTOP_DIR || join(root,'apps/desktop');
  const { performProjectAction } = await import(pathToFileURL(join(desktopDir,'project-actions.mjs')).href);
  const { performDocumentAction } = await import(pathToFileURL(join(desktopDir,'document-actions.mjs')).href);
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
    const errors=[];
    w.webContents.on('console-message', (_e,level,message) => { if(level===3) { errors.push(message); console.error(message); } });
    worker = createWorkspaceClient(dataDir, desktopDir, { onEvent:event=>w.webContents.send('chat.event',event) });
    ipcMain.handle('workspace.call',(_e,call)=>{
      const session=readCurrentAccountSession(dataDir);
      const actorId=session.ok ? session.session?.employeeId : null;
      if(!actorId&&!call.method.startsWith('account.')) return {ok:false,message:'请先登录'};
      return worker.request({...call,actorId});
    });
    let savedPath=join(dataDir,'另存文档.md'), openedPath='',saveCancelled=false;
    ipcMain.handle('document.action',(_e,input)=>{
      const session=readCurrentAccountSession(dataDir);const actor=session.ok?session.session?.employeeId:null;
      return performDocumentAction({input,actor,request:call=>worker.request(call),isCurrent:id=>{const s=readCurrentAccountSession(dataDir);return s.ok&&s.session?.employeeId===id;},parent:w,dialog:{async showSaveDialog(){return {canceled:saveCancelled,filePath:savedPath};}},shell:{async openPath(path){openedPath=path;return '';},showItemInFolder(path){openedPath=path;}}});
    });
    writeFileSync(join(output,'验收标准.md'),'验收标准：自动检索依据 AUTO-LOCAL-873。');
    writeFileSync(join(output,'source.md'),'项目材料：验收必须检查原始来源。');
    ipcMain.handle('project.action',(_e,input)=>{
      const session=readCurrentAccountSession(dataDir);const actor=session.ok?session.session?.employeeId:null;
      return performProjectAction({input,actor,request:call=>worker.request({...call,actorId:actor}),isCurrent:id=>{const s=readCurrentAccountSession(dataDir);return s.ok&&s.session?.employeeId===id;},parent:w,dialog:{async showOpenDialog(){return {canceled:false,filePaths:[input.action==='create'?output:join(output,'source.md')]};}},shell:{showItemInFolder(path){openedPath=path;}}});
    });
    const js = code => w.webContents.executeJavaScript(code);
    async function until(code) { const limit=Date.now()+(process.env.CPCLAW_CHAT_UI_REAL_BASE?70000:8000);while(!await js(code)){if(Date.now()>limit)throw Error(`UI 条件超时: ${code}`);await sleep(15);} }
    async function login(id) {
      await js(`openPanel('settings');byId('platform-url').value='${base}';byId('employee-id').value='${id}';byId('account-password').value='fixture-${id}';byId('account-login').click()`);
      await until(`chatAccount==='${id}' && !byId('account-login').dataset.busy`);
    }
    await w.loadFile(join(desktopDir,'renderer/index.html')); await login('employee-a');
    const markdownCheck=await js(String.raw`(()=>{const root=document.createElement('div');renderChatMarkdown(root,'# 标题\n\n> **来源文档**：说明\n\n- 重点\n\n| 项目 | 结果 |\n| --- | --- |\n| 安全 | 通过 |\n\n<img src=x onerror=alert(1)>');const valid=Boolean(root.querySelector('h1'))&&Boolean(root.querySelector('blockquote strong'))&&Boolean(root.querySelector('li'))&&Boolean(root.querySelector('table td'))&&!root.querySelector('img')&&!root.textContent.includes('**');renderChatMarkdown(root,'**加',true);const pending=!root.textContent.includes('**');renderChatMarkdown(root,'**加粗**');return valid&&pending&&root.querySelector('strong')?.textContent==='加粗';})()`);
    if(!markdownCheck)throw Error('聊天 Markdown 渲染、流式标记处理或 HTML 隔离异常');


    if(!await js(`Math.round(document.querySelector('.quick-rail').getBoundingClientRect().width)===44&&Math.round(document.querySelector('.sidebar').getBoundingClientRect().left)===44`))throw Error('窄快捷栏布局异常');
    if(!await js(`!document.querySelector('.sidebar .profile')&&!byId('new-chat')&&!byId('open-market')`))throw Error('聊天侧栏仍包含功能入口');
    await js(`byId('rail-sources').click()`);if(!await js(`!byId('panel-sources').hidden&&byId('rail-sources').getAttribute('aria-current')==='true'`))throw Error('资料快捷入口异常');
    await js(`byId('rail-market').click()`);await until(`!marketOverlay.hidden&&marketFrame.contentDocument?.getElementById('list')`);
    await js(`byId('rail-settings').click()`);if(!await js(`marketOverlay.hidden&&!byId('panel-settings').hidden`))throw Error('快捷栏切换没有关闭市场');
    await js(`byId('rail-home').click()`);if(!await js(`byId('inspector').hidden&&byId('rail-home').getAttribute('aria-current')==='true'`))throw Error('工作台快捷入口异常');
    if(!await js(`!byId('mode')&&!byId('new-task')&&!byId('create')`))throw Error('仍有模式选择入口');
    await js(`byId('rail-project').click()`);await until(`projects.length===1&&Boolean(currentProjectId)&&!byId('rail-project').dataset.busy`);
    const projectId=await js('currentProjectId');
    mkdirSync(join(output,'子目录'));writeFileSync(join(output,'子目录','报告.pdf'),'PDF fixture');writeFileSync(join(output,'.hidden'),'hidden');
    await js(`byId('rail-documents').click();byId('document-folders-tab').click()`);
    await until(`byId('document-folder-tree').textContent.includes('source.md')`);
    if(!await js(`byId('document-folders-tab').nextElementSibling.id==='document-files-tab'&&byId('document-folder-tree').textContent.includes('.hidden')&&byId('document-list').hidden&&byId('document-outline').hidden`))throw Error('文件夹页签顺序或全类型文件显示异常');
    await js(`Array.from(byId('document-folder-tree').querySelectorAll('summary')).find(e=>e.textContent.includes('子目录')).click()`);
    await until(`byId('document-folder-tree').textContent.includes('报告.pdf')`);
    await js(`byId('document-folder-tree').querySelector('button[data-path="子目录/报告.pdf"]').click()`);
    await sleep(100);if(openedPath!==join(realpathSync(output),'子目录','报告.pdf'))throw Error('文件定位未使用项目内路径');
    writeFileSync(join(output,'新增.txt'),'new');
    await js(`byId('document-folder-heading').querySelector('button').click()`);
    await until(`byId('document-folder-tree').textContent.includes('新增.txt')`);
    await js(`Array.from(byId('document-folder-tree').querySelectorAll('summary')).find(e=>e.textContent.includes('子目录')).click()`);
    await until(`byId('document-folder-tree').textContent.includes('报告.pdf')`);
    writeFileSync(join(dataDir,'project-folder-tree.png'),(await w.webContents.capturePage()).toPNG());
    await js(`byId('document-files-tab').click()`);

    if(!await js(`Array.from(document.querySelectorAll('.project-group')).some(g=>g.dataset.project==='${projectId}')`))throw Error('项目分组未显示');
    await js(`byId('rail-chat').click()`);await until(`!currentChatId&&byId('inspector').hidden`);
    await js(`byId('note').value='你好，介绍一下你自己';byId('chat-send').click()`);
    await until(`!runningChatId&&chatMessages.at(-1)?.state==='done'&&!byId('chat-send').dataset.busy`);
    if(!await js(`chatArtifacts.length===0&&chatMessages.at(-1).content.includes('回答问题')`))throw Error('普通回答不应生成文档');
    const unifiedChat=await js('currentChatId');
    await until(`chats.some(c=>c.id===currentChatId)`);
    await js(`document.querySelector('.project-chat-row .chat-move').click();byId('move-chat-project').value='';byId('move-chat-confirm').click()`);
    await until(`currentProjectId===''&&!byId('move-chat-dialog').open&&!byId('move-chat-confirm').dataset.busy`);
    await js(`byId('document-folders-tab').click()`);
    if(!await js(`byId('document-folder-tree').textContent==='选择项目后查看文件夹'`))throw Error('未归类聊天仍显示项目文件');
    await js(`byId('document-files-tab').click()`);
    await js(`document.querySelector('.project-chat-row .chat-move').click();byId('move-chat-project').value='${projectId}';byId('move-chat-confirm').click()`);
    await until(`currentProjectId==='${projectId}'&&!byId('move-chat-dialog').open&&!byId('move-chat-confirm').dataset.busy`);

    await js(`byId('note').value='请说明验收标准';byId('chat-send').click()`);
    await until(`!runningChatId&&chatMessages.at(-1)?.state==='done'&&!byId('chat-send').dataset.busy`);
    if(!await js(`chatMessages.at(-1).content.includes('AUTO-LOCAL-873')&&chatMessages.at(-1).sources?.some(s=>s.path==='验收标准.md')`))throw Error('未自动检索项目资料或未显示来源');
    await js(`byId('attach-project-material').click()`);await until(`Boolean(attachedProjectFile)`);
    await js(`window.__documentDeltas=[];window.cpclaw.onChatEvent(e=>{if(e.type==='delta')window.__documentDeltas.push(e.content);});void 0;`);
    await js(`byId('note').value='帮我准备一份明天会上可以直接用的资料整理提纲';byId('chat-send').click()`);
    await until(`chatMessages.at(-1)?.activities?.some(s=>s.step==='model'&&s.state==='running')`);
    if(!await js(`Boolean(document.querySelector('.chat-message.assistant:last-child .chat-progress li[data-state=running]'))`))throw Error('文档生成时没有展示处理进度');
    await until(`!runningChatId && chatArtifacts.length===1 && Boolean(activeArtifact) && !byId('chat-send').dataset.busy`);
    if(await js('currentChatId')!==unifiedChat)throw Error('生成成果不应切换到另一种任务');
    if(!await js(`chatMessages.at(-1).content.length<400&&!chatMessages.at(-1).content.includes('**')&&!chatMessages.at(-1).content.includes('## 步骤')&&chatMessages.at(-1).activities.some(s=>s.step==='save'&&s.state==='done')`))throw Error('文档正文仍重复输出到聊天，或保存步骤未展示');
    if(await js(`window.__documentDeltas.some(text=>text.includes('## 步骤'))`))throw Error('生成过程中完整正文闪现到聊天');
    const first=await js(`({...activeArtifact})`);
    if(!first.body.includes('原始来源已纳入'))throw Error('选择的材料未发送到模型');
    if(!first.path.startsWith(realpathSync(output)+'/'))throw Error('成果没有保存到项目文件夹');
    if(!existsSync(first.path)||readFileSync(first.path,'utf8')!==first.body)throw Error('卡片与实际文件不一致');
    if(first.name!=='x.md'||!await js(`Boolean(document.querySelector('.document-card'))&&!byId('panel-documents').hidden`))throw Error('没有文件卡片或右侧预览');
    await js(`byId('document-more').querySelector('summary').click()`);
    if(!await js(`byId('document-more').open&&byId('document-open').getBoundingClientRect().width>0`))throw Error('更多操作未展开');
    await js(`byId('document-open').click()`);await until(`Boolean(activeArtifact)`);await sleep(100);
    if(await js(`byId('document-more').open`))throw Error('选择操作后菜单未收起');
    if(openedPath!==first.path)throw Error('打开未使用真实文档路径');
    await js(`byId('document-more').querySelector('summary').click();byId('document-save-as').click()`);await until(`byId('status').textContent.includes('已另存为')`);
    if(readFileSync(savedPath,'utf8')!==first.body)throw Error('另存为内容不一致');
    saveCancelled=true;await js(`byId('document-more').querySelector('summary').click();byId('document-save-as').click()`);await until(`byId('status').textContent.includes('已取消另存为')`);
    await js(`byId('note').value='最后再补上验收标准';byId('chat-send').click()`);
    await until(`!runningChatId&&chatArtifacts.length===2&&activeArtifact?.revision===2&&!byId('chat-send').dataset.busy`);
    const second=await js(`({...activeArtifact})`);
    if(second.path===first.path||readFileSync(first.path,'utf8')!==first.body||!second.body.includes('验收标准'))throw Error('修改未保留旧版或未生成新内容');
    await js(`byId('document-source-tab').click()`);
    if(!await js(`!byId('document-source').hidden&&byId('document-preview').hidden`))throw Error('源文切换失败');
    if(!await js(`byId('document-source-tab').getAttribute('aria-selected')==='true'&&byId('document-preview-tab').getAttribute('aria-selected')==='false'`))throw Error('显示方式未标记选中状态');
    await js(`byId('document-source-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft'}))`);
    if(!await js(`!byId('document-preview').hidden&&byId('document-source').hidden`))throw Error('键盘切换预览失败');
    if(!await js(`document.querySelector('.document-toolbar').getBoundingClientRect().height<=54`))throw Error('工具栏高度未收紧');
    const screenshots=join(root,'docs/verification/documents');mkdirSync(screenshots,{recursive:true});
    await js(`byId('document-preview-tab').click()`);await sleep(100);
    writeFileSync(join(screenshots,'chat-document-preview.png'),(await w.webContents.capturePage()).toPNG());
    await js(`byId('document-outline-tab').click()`);
    if(!await js(`byId('document-outline').textContent.includes('步骤')&&byId('document-outline').textContent.includes('验收标准')`))throw Error('标题大纲未生成');
    await js(`byId('document-filter').value='验收';byId('document-filter').dispatchEvent(new Event('input'))`);
    if(!await js(`byId('document-outline').querySelectorAll('button').length===1`))throw Error('大纲筛选失败');
    await js(`byId('document-filter').value='';byId('document-filter').dispatchEvent(new Event('input'));byId('document-files-tab').click();byId('document-expand').click()`);
    if(!await js(`document.body.classList.contains('document-expanded')&&getComputedStyle(byId('document-preview').parentElement).overflowY==='auto'&&getComputedStyle(document.querySelector('.structure-scroll')).overflowY==='auto'`))throw Error('文档展开或独立滚动异常');
    writeFileSync(join(screenshots,'document-workspace-expanded.png'),(await w.webContents.capturePage()).toPNG());
    await js(`byId('document-edit').click()`);
    if(!await js(`!document.body.classList.contains('document-expanded')&&document.activeElement===byId('note')&&!byId('document-edit-context').hidden`))throw Error('展开视图继续修改未返回聊天输入');
    await js(`byId('close-panel').click()`);
    if(!await js(`!document.body.classList.contains('document-expanded')&&getComputedStyle(document.querySelector('.thread')).display!=='none'`))throw Error('关闭展开的文档后聊天未恢复');
    const chatId=await js('currentChatId');await w.webContents.reload();
    await until(`currentChatId==='${chatId}'&&chatArtifacts.length===2`);
    if(!await js(`chatMessages.some(m=>m.activities?.some(s=>s.step==='document'))`))throw Error('重启后文档处理步骤丢失');
    if(!await js(`chatMessages.some(m=>m.sources?.some(s=>s.path==='验收标准.md'))`))throw Error('重启后检索来源丢失');
    if(!await js(`currentProjectId==='${projectId}'&&projects.length===1`))throw Error('重启未恢复项目关联');
    await js(`byId('rail-documents').click();showDocument('${second.id}')`);
    await until(`activeArtifact?.id==='${second.id}'`);
    await js(`renderMarkdown('# 安全文档\\n<script>window.__docXss=true</script>')`);
    if(await js(`Boolean(window.__docXss)||Boolean(byId('document-preview').querySelector('script'))`))throw Error('Markdown 执行脚本');
    await js(`showDocument('${second.id}')`);
    await login('employee-b');
    if(await js(`projects.length!==0`))throw Error('账号切换泄漏项目');
    if(await js(`chatArtifacts.length!==0||byId('document-source').textContent!==''||byId('document-preview').textContent!==''`))throw Error('账号切换泄漏文档');
    await login('employee-a');await js(`selectChat('${chatId}')`);await until(`chatArtifacts.length===2`);
    w.setSize(800,720);await js(`byId('documents-toggle').click();showDocument('${second.id}')`);await sleep(150);
    if(!await js(`byId('inspector').getBoundingClientRect().left>=219`))throw Error('窄窗口文档遮挡快捷栏');
    if(await js('document.documentElement.scrollWidth>innerWidth'))throw Error('预览窄窗口横向溢出');
    await js(`byId('document-more').querySelector('summary').click();byId('document-more').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    if(await js(`byId('document-more').open`))throw Error('Escape未关闭更多操作');
    await js(`byId('document-edit').click()`);
    if(!await js(`byId('inspector').hidden&&document.activeElement===byId('note')`))throw Error('窄窗口继续修改未展示输入框');
    if(errors.length)throw Error(errors.join('\n'));
    console.log(JSON.stringify({progressTimeline:true,documentSummary:true,autoRetrieval:true,sourceHistory:true,projects:true,projectFiles:true,folderTree:true,folderRefresh:true,folderReveal:true,folderEmptyState:true,projectReload:true,compactToolbar:true,editFocus:true,unifiedAnswerAndDocument:true,automaticMarkdown:true,fileCard:true,preview:true,openAction:true,saveAs:true,saveCancel:true,revision:true,historyReload:true,accountIsolation:true,xssSafe:true,narrowLayout:true,screenshots}));
    worker.stop();platform?.kill();app.exit(0);
  }catch(error){console.error(error);worker?.stop();platform?.kill();app.exit(1);}
  });
}

import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const desktopDir=process.env.CPCLAW_TEST_DESKTOP_DIR||join(root,'apps/desktop');
if(process.argv.includes('--platform-child')){
 const {openPlatform,listenPlatform,fixtureEmployees}=await import('../packages/platform/dist/index.js');
 const dataDir=mkdtempSync('/tmp/cpclaw-kb-ui-platform-');const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'knowledge-ui-0123456789abcdef-secret',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()});if(!opened.ok)throw Error(opened.message);
 const server=await listenPlatform(opened.app,{dataDir,port:0,aiMockMode:true});console.log(JSON.stringify({port:server.port}));
 process.on('SIGTERM',()=>void server.close().then(()=>process.exit(0)));
}else{
 const {app,BrowserWindow,ipcMain}=await import('electron');
 const {createWorkspaceClient}=await import('../apps/desktop/workspace-client.mjs');
 const {readCurrentAccountSession}=await import('../packages/desktop-host/dist/account-session.js');
 const {performKnowledgeAction}=await import(pathToFileURL(join(desktopDir,'knowledge-actions.mjs')).href);
 let child,worker;app.whenReady().then(async()=>{
 try{
  const dir=mkdtempSync('/tmp/cpclaw-kb-ui-'),notes=join(dir,'notes');mkdirSync(notes);writeFileSync(join(notes,'验收.md'),'验收需要核实知识库引用。');
  child=spawn(process.env.CPCLAW_NODE_BINARY||'node',[fileURLToPath(import.meta.url),'--platform-child'],{cwd:root,stdio:['ignore','pipe','inherit']});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('平台启动超时')),10000);createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line);if(r.port){clearTimeout(timer);resolve(r.port);}}catch{}});child.on('error',reject);});
  const w=new BrowserWindow({width:1280,height:860,show:false,webPreferences:{preload:join(desktopDir,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}}),errors=[];
  w.webContents.on('console-message',(_e,level,message)=>{if(level===3)errors.push(message);});
  worker=createWorkspaceClient(dir,desktopDir,{onEvent:event=>w.webContents.send('chat.event',event)});
  const actor=()=>{const r=readCurrentAccountSession(dir);return r.ok?r.session?.employeeId:null;};
  ipcMain.handle('workspace.call',(_e,call)=>worker.request({...call,actorId:actor()}));
  ipcMain.handle('knowledge.action',(_e,input)=>performKnowledgeAction({input,actor:actor(),request:call=>worker.request({...call,actorId:actor()}),isCurrent:id=>actor()===id,dialog:{async showOpenDialog(){return {canceled:false,filePaths:[notes]};}},shell:{showItemInFolder(){}},parent:w}));
  await w.loadFile(join(desktopDir,'renderer/index.html'));
  const js=code=>w.webContents.executeJavaScript(code,true);
  const wait=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,50));}throw Error('等待失败：'+code);};
  await wait("byId('account-summary').textContent.includes('尚未登录')");
  await js(`byId('platform-url').value='http://127.0.0.1:${port}';byId('employee-id').value='admin';byId('account-password').value='fixture-admin';byId('account-login').click()`);
  await wait("chatAccount==='admin'");await js("openPanel('sources')");await wait("byId('knowledge-enterprise-list').textContent.includes('尚未关联')");
  assert.match(await js("byId('panel-sources').textContent"),/关联 企业知识库（wiki）/);
  await js("kbAssociate('personal');[...kbBody.querySelectorAll('button')].find(b=>b.textContent==='本地目录').click()");
  await wait("byId('knowledge-personal-list').textContent.includes('1 份文档')");
  await js("kbAssociate('enterprise');[...kbBody.querySelectorAll('button')].find(b=>b.textContent==='CPclaw 平台').click()");await wait("kbBody.textContent.includes('新建知识库')");
  await js("[...kbBody.querySelectorAll('button')].find(b=>b.textContent.includes('新建知识库')).click();kbBody.querySelectorAll('input')[0].value='企业研发知识库';kbBody.querySelectorAll('input')[1].value='employee-a';[...kbBody.querySelectorAll('button')].find(b=>b.textContent==='保存并关联').click()");
  await wait("byId('knowledge-enterprise-list').textContent.includes('企业研发知识库')");
  await js("[...byId('knowledge-enterprise-list').querySelectorAll('button')].find(b=>b.textContent==='查看').click()");await wait("kbBody.textContent.includes('新建文档')");
  await js("[...kbBody.querySelectorAll('button')].find(b=>b.textContent.includes('新建文档')).click();kbBody.querySelector('input').value='研发规范';kbBody.querySelector('textarea').value='研发规范要求核实引用来源。';[...kbBody.querySelectorAll('button')].find(b=>b.textContent==='保存').click()");
  await wait("kbBody.textContent.includes('研发规范')");await js("kbDialog.close();byId('knowledge-sources').click()");await wait("kbBody.querySelectorAll('input[type=checkbox]').length===2");
  await js("kbBody.querySelectorAll('input').forEach(b=>b.checked=true);[...kbBody.querySelectorAll('button')].find(b=>b.textContent==='保存选择').click()");await wait("!kbDialog.open");
  assert.equal(await js("(async()=> (await kbCall('knowledge.list',{chatId:currentChatId})).selected.length)()"),2);
  await js("openPanel('sources')");
  const screenshots=join(root,'docs/verification/knowledge');mkdirSync(screenshots,{recursive:true});writeFileSync(join(screenshots,'desktop-knowledge.png'),(await w.webContents.capturePage()).toPNG());
  w.setSize(800,860);await new Promise(r=>setTimeout(r,150));assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
  writeFileSync(join(screenshots,'desktop-knowledge-narrow.png'),(await w.webContents.capturePage()).toPNG());assert.deepEqual(errors,[]);
  console.log('知识库桌面验证通过：关联本地与平台、创建企业库及文档、选择来源、宽窄布局，无渲染错误。');
 }catch(e){console.error(e);process.exitCode=1;}finally{worker?.stop();child?.kill();app.exit(process.exitCode??0);}
 });
}

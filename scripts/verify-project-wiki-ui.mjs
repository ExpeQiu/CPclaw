// Isolated Electron + actual workspace worker and files; the HTTP model is a fixture, no paid calls.
import {app,BrowserWindow,ipcMain} from 'electron';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createWorkspaceClient} from '../apps/desktop/workspace-client.mjs';
import {performProjectAction} from '../apps/desktop/project-actions.mjs';
import {readCurrentAccountSession} from '../packages/desktop-host/dist/account-session.js';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),desktop=join(repo,'apps/desktop');
let worker,server,calls=0;const revealed=[];
const deadline=setTimeout(()=>{console.error('Wiki Electron verification timed out');worker?.stop();app.exit(1);},45000);
app.whenReady().then(async()=>{
  try {
    const dir=mkdtempSync('/tmp/cpclaw-wiki-ui-'),project=join(dir,'示例项目');mkdirSync(project);writeFileSync(join(project,'验收规范.md'),'验收标准：核实证据，温度低于 30 度。');writeFileSync(join(project,'未支持.pdf'),'fixture');
    server=createServer(async(req,res)=>{
      let raw='';for await(const part of req)raw+=part;
      const body=raw?JSON.parse(raw):{};res.setHeader('content-type','application/json');
      if(req.url==='/v1/session/login'||req.url==='/v1/session/refresh'){res.end(JSON.stringify({employeeId:'wiki-ui',sessionId:'fixture-session',refreshToken:'fixture-refresh',accessToken:'fixture-access'}));return;}
      if(req.url==='/v1/chat/stream') {
        calls++;const source=JSON.parse(body.messages[0].content.split('\n').at(-1));
        const quote=source.numberedText.split('\n')[0].replace(/^\d+: /,'');
        const result={title:'项目验收规范',points:[{kind:'fact',topic:'验收标准',text:'核实证据并保留温度条件。',quote,startLine:source.startLine,endLine:source.startLine}]};
        res.setHeader('content-type','application/x-ndjson');res.end([{event:'start',mode:'real'},{event:'delta',text:JSON.stringify(result)},{event:'done'}].map(e=>JSON.stringify(e)+'\n').join(''));return;
      }
      res.end(JSON.stringify({ok:true,items:[],connectors:[],capabilities:{serviceTypes:['CLI','MCP']}}));
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
    const win=new BrowserWindow({width:1280,height:860,show:false,webPreferences:{preload:join(desktop,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}}),errors=[];
    win.webContents.on('console-message',(_event,level,message)=>{if(level===3)errors.push(message);});
    worker=createWorkspaceClient(dir,desktop,{onEvent:event=>win.webContents.send('chat.event',event)});
    const actor=()=>{const r=readCurrentAccountSession(dir);return r.ok?r.session?.employeeId:null;};
    ipcMain.handle('workspace.call',(_e,call)=>worker.request({...call,actorId:actor()}));
    ipcMain.handle('runtime.status',()=>({ok:true,name:'fixture',ready:true}));
    ipcMain.handle('settings.get',()=>({ok:true,settings:{}}));ipcMain.handle('ui.log',()=>({ok:true}));
    ipcMain.handle('extension.action',(_e,input)=>input.action==='permission-status'?{ok:true,mode:'ask'}:{ok:false,message:'隔离 UI 夹具未启用应用服务'});
    ipcMain.handle('project.action',(_e,input)=>performProjectAction({input,actor:actor(),request:call=>worker.request({...call,actorId:actor()}),isCurrent:id=>actor()===id,dialog:{async showOpenDialog(){return {canceled:false,filePaths:[project]};}},shell:{showItemInFolder(path){revealed.push(path);}},parent:win}));
    await win.loadFile(join(desktop,'renderer/index.html'));
    const js=code=>win.webContents.executeJavaScript(code,true),until=async code=>{for(let i=0;i<200;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('等待失败：'+code);};
    await until("byId('account-summary').textContent.includes('尚未登录')");
    await js(`byId('platform-url').value='http://127.0.0.1:${port}';byId('employee-id').value='wiki-ui';byId('account-password').value='fixture';byId('account-login').click()`);
    await until("chatAccount==='wiki-ui'");await js("byId('rail-project').click()");await until("projects.length===1");
    assert.equal(await js("document.querySelectorAll('.project-wiki-action').length"),1);
    assert.equal(await js("document.querySelector('.project-wiki-action').nextElementSibling.textContent"),'↗');
    await js("document.querySelector('.project-wiki-action').click()");await until("wikiDialog.open&&!wikiStart.disabled");
    assert.equal(await js("document.querySelector('.project-group').open"),true);assert.match(await js('wikiSummary.textContent'),/1 份支持/);
    assert.match(await js('wikiDetails.textContent'),/未支持.pdf/);
    await js('wikiStart.click()');await until("!wikiStart.disabled&&wikiStatus?.updated");assert.equal(calls,1);
    await js('wikiView.click()');await until("wikiPreview.textContent.includes('主题导航')");
    await js("[...wikiPreview.querySelectorAll('button')].find(b=>b.textContent==='项目验收规范').click()");await until("wikiPreview.textContent.includes('L1-L1')");
    assert.match(await js('wikiPreview.textContent'),/低于 30 度/);
    await js("[...wikiPreview.querySelectorAll('.project-wiki-link')].find(b=>b.title==='验收规范.md').click()");
    for(let i=0;i<100&&!revealed.length;i++)await new Promise(r=>setTimeout(r,10));assert.ok(revealed[0]?.endsWith('/验收规范.md'));
    await js('wikiStart.click()');await until("wikiFeedback.textContent.includes('未调用模型')");assert.equal(calls,1);
    writeFileSync(join(project,'验收规范.md'),'验收标准已更新：核实证据，温度低于 25 度。');
    await js('wikiStart.click()');await until("wikiFeedback.textContent.includes('更新 1 页')");assert.equal(calls,2);
    await js('wikiChanges.click()');await until("wikiPreview.textContent.includes('本次变更')");
    await js('wikiView.click()');await until("wikiPreview.textContent.includes('主题导航')");
    const evidence=join(repo,'docs/verification/project-wiki');mkdirSync(evidence,{recursive:true});
    writeFileSync(join(evidence,'desktop-project-wiki.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(800,860);await new Promise(r=>setTimeout(r,150));assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    assert.equal(await js('wikiDialog.getBoundingClientRect().right<=innerWidth'),true);
    writeFileSync(join(evidence,'desktop-project-wiki-narrow.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(readFileSync(join(project,'验收规范.md'),'utf8'),'验收标准已更新：核实证据，温度低于 25 度。');
    await js('clearProjectWiki()');assert.equal(await js('wikiDialog.open'),false);assert.equal(await js('wikiPreview.textContent'),'');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,level:'isolated-electron-real-worker-fixture-model',modelCalls:calls,checks:['project-icon-position','no-collapse','scan-and-skips','wiki-publish','wiki-view-and-citations','incremental-update','no-op-no-model','change-log','wide-and-narrow-layout','no-renderer-errors'],evidence,project}));
  }catch(error){console.error(error);process.exitCode=1;}
  finally {clearTimeout(deadline);worker?.stop();server?.close();app.exit(process.exitCode??0);}
});

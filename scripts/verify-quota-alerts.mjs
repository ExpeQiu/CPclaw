// Real desktop IPC + temporary platform. No production quota changes or paid model calls.
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.includes('--platform-child')){
 const {openPlatform,listenPlatform,fixtureEmployees}=await import('../packages/platform/dist/index.js');
 const dataDir=mkdtempSync('/tmp/cpclaw-alert-platform-');
 const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'quota-alert-test-secret',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()});assert(opened.ok);
 const login=opened.app.login({employeeId:'employee-a',password:'fixture-employee-a',deviceLabel:'seed'});assert(login.ok);
 assert(opened.app.reserve(login.accessToken,{requestId:'spent'}).ok);assert(opened.app.settle(login.accessToken,{requestId:'spent',usage:{state:'known',inputTokens:1000,outputTokens:0}}).ok);
 const server=await listenPlatform(opened.app,{dataDir,port:0,aiMockMode:true});
 process.stdout.write(JSON.stringify({port:server.port})+'\n');process.on('SIGTERM',()=>void server.close().then(()=>{opened.app.close();process.exit(0);}));
}else{
 const {app,BrowserWindow,ipcMain}=await import('electron');
 const {createWorkspaceClient}=await import('../apps/desktop/workspace-client.mjs');
 const {readCurrentAccountSession}=await import('../packages/desktop-host/dist/account-session.js');
 const {taskIssue}=await import('../apps/desktop/task-issue.mjs');
 const dataDir=mkdtempSync('/tmp/cpclaw-alert-ui-'),desktop=join(root,'apps/desktop'),evidence=process.env.CPCLAW_ALERT_EVIDENCE||join(dataDir,'evidence');mkdirSync(evidence,{recursive:true});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));let platform,worker,win;const requestIds=[],consoleErrors=[];let loseFirstResponse=true,quotaReadRequiresLogin=false;
 app.whenReady().then(async()=>{
  const timer=setTimeout(()=>{worker?.stop();platform?.kill();app.exit(1);},45000);
  try{
   platform=spawn(process.env.CPCLAW_NODE_BINARY||'node',[fileURLToPath(import.meta.url),'--platform-child'],{cwd:root,stdio:['ignore','pipe','pipe']});platform.stderr.on('data',()=>{});
   const port=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('fixture platform timeout')),8000);createInterface({input:platform.stdout}).on('line',line=>{const r=JSON.parse(line);if(r.port){clearTimeout(t);resolve(r.port);}});platform.on('error',reject);});
   win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload:join(desktop,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
   win.webContents.on('console-message',(_e,level,message)=>{if(level===3)consoleErrors.push(message);});
   worker=createWorkspaceClient(dataDir,desktop,{onEvent:e=>win.webContents.send('chat.event',e)});
   ipcMain.handle('extension.action',()=>({ok:true,remembered:false}));ipcMain.handle('runtime.status',()=>({ok:true,ready:false,name:'deepseek-harness',source:'none'}));ipcMain.handle('settings.get',()=>({ok:false,message:'fixture'}));ipcMain.handle('ui.log',()=>({ok:true}));
   ipcMain.handle('workspace.call',async(_event,call)=>{
    if(call.method==='account.quota'&&quotaReadRequiresLogin)return {ok:false,message:'登录凭证无效，请重新登录',issue:taskIssue({error:'登录凭证无效，请重新登录'})};
    const session=readCurrentAccountSession(dataDir),actorId=session.ok?session.session?.employeeId:null;
    const result=await worker.request({...call,actorId});
    if(call.method==='account.quotaRequest'){
     requestIds.push(call.input.requestId);
     if(loseFirstResponse&&result.ok){loseFirstResponse=false;return {ok:false,code:'DEPENDENCY_UNAVAILABLE',message:'申请结果暂未确认，请核实原申请。'};}
    }
    return result;
   });
   const js=code=>win.webContents.executeJavaScript(code);
   async function until(code){const end=Date.now()+12000;while(!await js(code)){if(Date.now()>end)throw Error('UI timeout: '+code);await sleep(25);}}
   await win.loadFile(join(desktop,'renderer/index.html'));
   await js(`openPanel('settings');byId('platform-url').value='http://127.0.0.1:${port}';byId('employee-id').value='employee-a';byId('account-password').value='fixture-employee-a';byId('account-login').click()`);
   await until(`chatAccount==='employee-a'&&!byId('account-login').dataset.busy`);
   await js(`byId('close-panel').click();byId('note').value='列出三条整理项目资料的建议';byId('chat-send').click()`);
   await until(`byId('task-issue-dialog').open&&byId('task-issue-title').textContent.includes('额度不足')`);
   const initialIssue=await js(`chatMessages.at(-1).issue`);
   assert(await js(`byId('quota-request-policy').textContent.includes('自动审批')`));assert(await js(`byId('task-issue-impact').textContent.includes('即梦积分')`));
   assert(!await js(`document.querySelector('#chat-messages .assistant .message-body').textContent.includes('没有收到回复正文')`));
   await sleep(150);
   writeFileSync(join(evidence,'quota-exhausted.png'),(await win.webContents.capturePage()).toPNG());
   win.setSize(800,720);await sleep(80);assert(await js(`byId('task-issue-dialog').getBoundingClientRect().width<=innerWidth`));
   await js(`byId('quota-request-amount').value='1';byId('task-issue-primary').click()`);await until(`byId('task-issue-primary').textContent==='核实原申请结果'&&!byId('task-issue-primary').disabled`);
   assert.equal(requestIds.length,1);assert(!await js(`byId('task-issue-title').textContent.includes('已到账')`));
   assert(await js(`JSON.parse(localStorage.getItem('cpclaw-quota-pending:'+chatAccount+':'+currentChatId))?.requestId===${JSON.stringify(requestIds[0])}`));
   await js(`byId('task-issue-primary').click()`);await until(`byId('quota-request-feedback').textContent.includes('仍不足')&&!byId('quota-request-amount').disabled`);
   assert.equal(requestIds.length,2);assert.equal(requestIds[0],requestIds[1]);
   assert(!await js(`byId('task-issue-title').textContent.includes('已到账')`));
   await js(`byId('quota-request-amount').value='1000000';byId('task-issue-primary').click()`);await until(`byId('task-issue-title').textContent==='新额度已到账'`);
   assert.equal(requestIds.length,3);assert.notEqual(requestIds[1],requestIds[2]);
   assert(await js(`!localStorage.getItem('cpclaw-quota-pending:'+chatAccount+':'+currentChatId)`));
   const quota=await js(`chatCall('account.quota')`);assert.equal(quota.quota.limitTokens,1001001);assert.equal(quota.quota.settledKnown,1000);
   writeFileSync(join(evidence,'quota-approved.png'),(await win.webContents.capturePage()).toPNG());
   await js(`byId('task-issue-primary').click()`);await until(`!runningChatId&&chatMessages.at(-1)?.state==='done'&&!byId('task-issue-dialog').open`);
   quotaReadRequiresLogin=true;
   await js(`window.showTaskIssue(${JSON.stringify(initialIssue)},{messageId:'session-fixture'})`);
   assert.equal(await js(`byId('task-issue-primary').textContent`),'重新登录');
   assert(await js(`byId('task-issue-title').textContent.includes('额度暂无法核实')`));
   await js(`byId('task-issue-primary').click()`);assert(await js(`!byId('task-issue-dialog').open&&!byId('panel-settings').hidden`));assert.equal(requestIds.length,3);
   assert.deepEqual(consoleErrors,[]);
   const result={ok:true,checks:['automatic-quota-dialog','cause-impact-preserved-next-action','model-vs-service-credits','narrow-layout','auto-approval','ambiguous-response-retry-same-id','no-double-credit','approved-but-insufficient','usage-preserved','resume-original-request','quota-read-session-expired-action'],limitTokens:quota.quota.limitTokens};
   writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
   clearTimeout(timer);worker.stop();platform.kill();win.destroy();app.exit(0);
  }catch(error){clearTimeout(timer);console.error(error);worker?.stop();platform?.kill();app.exit(1);}
 });
}

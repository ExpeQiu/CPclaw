// 验证「请求批准」模式下授权范围三个选项均可用，且弹窗显示当前对话权限上下文。
import {app,BrowserWindow,ipcMain} from 'electron';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const desktop=resolve(import.meta.dirname,'../apps/desktop');
const {registerExtensionHost}=await import(pathToFileURL(join(desktop,'extension-host.mjs')).href);
const temp=mkdtempSync('/tmp/cpclaw-approval-scope-');
app.setPath('userData',join(temp,'profile'));
const evidence=resolve(import.meta.dirname,'../docs/verification/授权范围解耦028');
import {mkdirSync} from 'node:fs';
mkdirSync(evidence,{recursive:true});

let win;const actor='test-actor';
const host=registerExtensionHost({dataDir:temp,ipcMain,getWindow:()=>win,getActor:()=>actor});
app.whenReady().then(async()=>{
 const deadline=setTimeout(()=>{console.error('approval scope timeout');app.exit(1);},30000);
 try{
  const renderer=join(desktop,'renderer');
  const preload=join(temp,'preload.cjs');
  writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('cpclaw',{extensionAction:i=>ipcRenderer.invoke('extension.action',i),onExtensionEvent:f=>ipcRenderer.on('extension.event',(_e,v)=>f(v))});");
  let html=readFileSync(join(renderer,'index.html'),'utf8').replace(/<script src="[^"]+"><\/script>/g,'');
  html=html.replace('<head>','<head><base href="'+pathToFileURL(renderer+'/')+'">').replace('</body>',`<script>window.chatAccount='test-actor';window.currentChatId='chat-1';window.openPanel=()=>{};window.setStatus=()=>{};</script><script src="${pathToFileURL(join(renderer,'extensions.js'))}"></script><script src="${pathToFileURL(join(renderer,'permissions.js'))}"></script></body>`);
  const page=join(temp,'index.html');writeFileSync(page,html);
  win=new BrowserWindow({show:true,width:1100,height:800,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',(_e,level,message)=>{if(level===3)errors.push(message);});
  await win.loadFile(page);
  const js=s=>win.webContents.executeJavaScript(s);
  const settle=()=>js('new Promise(r=>setTimeout(r,100))');
  const until=async code=>{for(let i=0;i<30;i++){if(await js(code))return;await settle();}throw Error('timeout '+code);};

  host.setContext(actor,'chat-1');
  // 对话权限保持默认「请求批准」。
  assert.equal(await js("document.getElementById('permission-mode-label').textContent"),'请求批准');

  const service={id:'terminal-test',title:'终端验证',type:'CLI',target:'/usr/bin/printf'};
  const execute=(taskId='task-1')=>host.executeService({actorId:actor,chatId:'chat-1',taskId,service,request:{action:'call',args:['%s','{"ok":true}']}},new AbortController().signal);

  const pending=execute();await until("document.getElementById('service-approval').open");
  assert.equal(await js("document.getElementById('service-approval-mode').value"),'task');
  assert.equal(await js("document.querySelector('#service-approval-mode [value=\"task\"]').disabled"),false);
  assert.equal(await js("document.querySelector('#service-approval-mode [value=\"auto\"]').disabled"),false);
  assert.equal(await js("document.querySelector('#service-approval-mode [value=\"once\"]').disabled"),false);
  assert.match(await js("document.getElementById('service-approval-context').textContent"),/请求批准/);
  writeFileSync(join(evidence,'approval-scope-ask-mode.png'),(await win.webContents.capturePage()).toPNG());

  // 选「仅当前操作」：只放行这一次。
  await js("document.getElementById('service-approval-mode').value='once';document.getElementById('service-approval-mode').dispatchEvent(new Event('change'))");
  await js("document.getElementById('service-approval-confirm').click()");
  assert.equal((await pending).ok,true);

  // 选「本次任务」：同任务内不再弹窗。
  const second=execute('task-2');await until("document.getElementById('service-approval').open");
  await js("document.getElementById('service-approval-mode').value='task';document.getElementById('service-approval-mode').dispatchEvent(new Event('change'))");
  await js("document.getElementById('service-approval-confirm').click()");
  assert.equal((await second).ok,true);
  const third=execute('task-2');
  assert.equal((await third).ok,true);
  assert.equal(await js("document.getElementById('service-approval').open"),false);
  assert.match(await js("document.getElementById('extension-permission').textContent"),/本次任务已授权/);

  assert.deepEqual(errors,[]);
  clearTimeout(deadline);
  console.log(JSON.stringify({ok:true,checks:['ask-mode-offers-three-scopes','context-shows-conversation-mode','once-not-reused','task-reused-in-task','grant-visible-in-panel'],screenshots:evidence}));
  app.exit(0);
 }catch(error){clearTimeout(deadline);console.error(error);app.exit(1);}
});

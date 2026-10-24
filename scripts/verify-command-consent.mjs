import {app,BrowserWindow,ipcMain} from 'electron';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {registerExtensionHost} from '../apps/desktop/extension-host.mjs';
const temp=mkdtempSync('/tmp/cpclaw-native-consent-');app.setPath('userData',join(temp,'profile'));
let win,actor='employee-a',executed=0,queued=[],dialogs=[],lastSignal;
const host=registerExtensionHost({ipcMain,getWindow:()=>win,getActor:()=>actor,
 service:{describeInspection:()=>({app:'即梦 CLI',purpose:'只读检查',cwd:temp,commands:[['/test/cli','version'],['/test/cli','auth','status'],['/test/cli','canvas','ls','--limit','1']],fingerprint:'fixed-plan'}),
 inspect:async({beforeExecute,signal})=>{for(let i=0;i<3;i++){beforeExecute();assert.equal(signal.aborted,false);executed++;}return{ok:true,state:'ready',message:'已连接'};}},
 approvalDialog:async(parent,options)=>{assert.equal(parent,win);dialogs.push(options);lastSignal=options.signal;const next=queued.shift();assert.ok(next,'unexpected consent dialog');return typeof next==='function'?next(options):next;},
});
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>{console.error('consent host verification timeout');app.exit(1);},30000);
 try{
 const preload=join(temp,'preload.cjs');writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',{action:i=>ipcRenderer.invoke('extension.action',i)});");
 const html=join(temp,'index.html');writeFileSync(html,'<!doctype html><title>Local command authorization test</title>');
 win=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false}});await win.loadFile(html);
 const action=input=>win.webContents.executeJavaScript(`probe.action(${JSON.stringify(input)})`);
 queued.push({response:0});assert.equal((await action({action:'inspect',approved:true})).state,'denied');assert.equal(executed,0);
 assert.match(dialogs[0].detail,/工作目录/);assert.match(dialogs[0].detail,/canvas ls --limit 1/);assert.equal(dialogs[0].defaultId,0);assert.equal(dialogs[0].cancelId,0);assert.equal(dialogs[0].checkboxChecked,undefined);
 host.setContext(actor,'chat-a');queued.push({response:1,checkboxChecked:false},{response:0});
 assert.equal((await action({action:'inspect'})).state,'ready');assert.equal((await action({action:'inspect'})).state,'denied');assert.equal(executed,3);
 assert.equal(dialogs.at(-1).checkboxChecked,false);
 queued.push({response:1,checkboxChecked:true});const before=dialogs.length;
 await action({action:'inspect'});await action({action:'inspect'});assert.equal(dialogs.length,before+1);assert.equal((await action({action:'permission-status'})).remembered,true);
 await action({action:'revoke-permission'});assert.equal((await action({action:'permission-status'})).remembered,false);
 queued.push({response:0});assert.equal((await action({action:'inspect'})).state,'denied');
 queued.push({response:1,checkboxChecked:true});await action({action:'inspect'});
 host.setContext(actor,'chat-b');host.setContext(actor,'chat-a');queued.push({response:0});assert.equal((await action({action:'inspect'})).state,'denied');
 const strangers=new BrowserWindow({show:false,webPreferences:{preload,sandbox:true,contextIsolation:true}});await strangers.loadFile(html);const count=dialogs.length;
 assert.equal((await strangers.webContents.executeJavaScript("probe.action({action:'inspect',approved:true})")).ok,false);assert.equal(dialogs.length,count);strangers.destroy();
 let ready;const opened=new Promise(r=>ready=r);queued.push(options=>new Promise(resolve=>{ready();options.signal.addEventListener('abort',()=>resolve({response:0}),{once:true});}));
 const waiting=action({action:'inspect'});await opened;const commandsBefore=executed;host.clearContext();assert.equal((await waiting).state,'cancelled');assert.equal(lastSignal.aborted,true);assert.equal(executed,commandsBefore);
 queued.push({response:0});assert.equal((await host.probeConnector({title:'Node',target:'/Applications/CPclaw.app/Contents/Resources/runtime/bin/node'},actor)).state,'denied');
 queued.push({response:1,checkboxChecked:true});const probe=await host.probeConnector({title:'Node',target:'/Applications/CPclaw.app/Contents/Resources/runtime/bin/node'},actor);assert.equal(probe.ok,true);assert.match(probe.message,/v22/);assert.equal(dialogs.at(-1).checkboxLabel,undefined);
 clearTimeout(timer);console.log(JSON.stringify({ok:true,checks:['native-modal-details','deny-without-execution','cannot-forge-approval','once-only','conversation-scope','revoke','context-change','untrusted-window','cancel-pending-on-context-change','legacy-connector-once-only']}));win.destroy();app.exit(0);
 }catch(error){clearTimeout(timer);console.error(error);app.exit(1);}
});

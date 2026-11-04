import {app,BrowserWindow} from 'electron';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const temp=mkdtempSync('/tmp/cpclaw-doctor-ui-');app.setPath('userData',join(temp,'profile'));
app.whenReady().then(async()=>{
 setTimeout(()=>app.exit(1),30000).unref();
 try{
  const renderer=resolve(import.meta.dirname,'../apps/desktop/renderer');
  let html=readFileSync(join(renderer,'index.html'),'utf8').replace(/<script src="[^"]+"><\/script>/g,'');
  const fixture=`<script>
  let chatAccount='a',currentChatId='chat-a';window.calls=[];window.deferUpload=false;window.pendingUpload=null;window.chatDiagnostics=0;
  document.getElementById('chat-diagnose').onclick=()=>chatDiagnostics++;
  window.refreshKernelStatus=async()=>{};
  window.cpclaw={doctorAction:async input=>{calls.push(input);if(input.action==='upload'&&deferUpload)await new Promise(r=>pendingUpload=r);
  if(input.action==='check'||input.action==='export')return {ok:true,fileName:'diagnostic.json',bytes:1234,logCount:4,app:{version:'test',packaged:true,systemPathReady:true,kernel:{ready:true,source:'bundle',name:'deepseek-harness'}},report:{checks:[{id:'identity',status:'ok',summary:'登录会话可用'}]}};
  if(input.action==='repair')return {ok:true,verified:true};
  if(input.action==='upload'||input.action==='status')return {ok:true,upload:{status:'available',uploadId:'upl-fixture'}};
  if(input.action==='kernel')return {ok:true,kernel:{ready:true}};
  return {ok:true,message:'已打开目录',summary:'连接检查通过'};}};
  document.getElementById('panel-settings').hidden=false;document.getElementById('inspector').hidden=false;
  </script><script src="${pathToFileURL(join(renderer,'doctor-center.js'))}"></script>`;
  html=html.replace('<head>','<head><base href="'+pathToFileURL(renderer+'/')+'">').replace('</body>',fixture+'</body>');
  const page=join(temp,'index.html');writeFileSync(page,html);
  const win=new BrowserWindow({width:1400,height:1000,show:false});const errors=[];
  win.webContents.on('console-message',(_e,level,message)=>{if(level===3)errors.push(message);});
  await win.loadFile(page);const js=code=>win.webContents.executeJavaScript(code);const settle=()=>js('new Promise(r=>setTimeout(r,80))');
  assert.equal(await js("document.querySelectorAll('#doctor-shortcuts button').length"),7);
  await js("document.getElementById('doctor').click()");await settle();assert.match(await js("document.getElementById('doctor-checks').textContent"),/系统命令路径.*工作进程.*推理内核/);
  await js("document.getElementById('doctor-repair').click()");await settle();assert.match(await js("document.getElementById('doctor-out').textContent"),/修复后检查通过/);
  await js("document.querySelector('[data-command=chat]').click()");assert.equal(await js('chatDiagnostics'),1);
  await js("document.getElementById('doctor-export').click()");await settle();assert.match(await js("document.getElementById('doctor-out').textContent"),/已导出/);
  await js("deferUpload=true;document.getElementById('doctor-upload').click();document.getElementById('doctor-upload').click()");await settle();assert.equal(await js("calls.filter(c=>c.action==='upload').length"),1);
  await js('pendingUpload()');await settle();assert.match(await js("document.getElementById('doctor-cloud').textContent"),/已保存.*完整性校验/);
  await js("document.querySelector('[data-command=status]').click()");await settle();assert.equal(await js("calls.at(-1).action"),'status');
  await js("clearDoctorCenter();chatAccount='b'");assert.equal(await js("document.getElementById('doctor-cloud').textContent"),'');
  await js("deferUpload=false;document.getElementById('doctor').click()");await settle();
  await js("document.getElementById('doctor-center').scrollIntoView({block:'start'})");await settle();
  const evidence=resolve(import.meta.dirname,'../docs/verification/doctor-center');mkdirSync(evidence,{recursive:true});
  writeFileSync(join(evidence,'doctor-center.png'),(await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['app-worker-kernel','verified-repair','seven-shortcuts','chat-diagnostic-reuse','export','duplicate-upload-blocked','cloud-receipt','account-state-cleared'],screenshot:join(evidence,'doctor-center.png')}));app.exit(0);
 }catch(e){console.error(e);app.exit(1);}
});

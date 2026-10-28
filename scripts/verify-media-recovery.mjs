// Real Electron renderer + extension host + independent Node worker; no external generation.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),desktop=join(root,'apps/desktop'),actor='recovery-fixture';
const resource='00000000-0000-4000-8000-000000000002',project='00000000-0000-4000-8000-000000000001';
if(process.argv[2]==='--seed'){
  const dataDir=process.argv[3],source=process.argv[4];
  const {DatabaseSync}=await import('node:sqlite');
  const {writeAccountSession}=await import('../packages/desktop-host/dist/account-session.js');
  const {createChatService}=await import('../apps/desktop/chat-service.mjs');
  writeAccountSession(dataDir,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token'},{makeCurrent:true});
  const service=createChatService(dataDir,()=>{}),{chatId}=await service.dispatch('chat.create',actor,{});
  const db=new DatabaseSync(join(dataDir,'chat.sqlite'));
  const dir=join(dataDir,'service-artifacts',createHash('sha256').update(actor).digest('hex').slice(0,16),chatId);mkdirSync(dir,{recursive:true});
  const path=join(dir,`dreamina-${resource}.png`);
  if(source)copyFileSync(source,path);
  else{const bytes=Buffer.alloc(13*1024*1024);Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=','base64').copy(bytes);writeFileSync(path,bytes);}
  db.prepare('INSERT INTO chat_messages(id,chat,role,content,state,error,request) VALUES(?,?,?,?,?,?,?)').run('user',chatId,'user','绘制风景图','done','','fixture');
  db.prepare('INSERT INTO chat_messages(id,chat,role,content,state,error,request) VALUES(?,?,?,?,?,?,?)').run('assistant',chatId,'assistant','本轮回复未完成，已恢复执行记录。','error','模型步骤达到上限，请继续当前任务','fixture');
  const steps=[{step:1,request:{action:'call',args:['resource','get',resource,'--project-id',project]},result:{ok:true,data:{resourceId:resource,type:'image',status:'success'}}},{step:2,request:{action:'call',args:['resource','download',resource,'--project-id',project]},result:{ok:false,code:'SERVICE_FAILED',message:'图片文件为空或超过预览限制'}}];
  for(const s of steps)db.prepare('INSERT INTO chat_service_steps VALUES(?,?,?)').run('assistant',s.step,JSON.stringify({...s,service:{id:'dreamina',title:'即梦画布',type:'CLI'}}));
  service.stop();db.close();process.stdout.write(JSON.stringify({chatId,path}));
}else{
  const {app,BrowserWindow,ipcMain,nativeImage}=await import('electron');
  const {registerExtensionHost,previewServiceImage}=await import('../apps/desktop/extension-host.mjs');
  const {createWorkspaceClient}=await import('../apps/desktop/workspace-client.mjs');
  const dataDir=mkdtempSync('/tmp/cpclaw-recovery-ui-');mkdirSync(join(dataDir,'profile'),{recursive:true});app.setPath('userData',join(dataDir,'profile'));
  const evidence=process.env.CPCLAW_RECOVERY_EVIDENCE||join(dataDir,'evidence');mkdirSync(evidence,{recursive:true});
  const seeded=JSON.parse(execFileSync(process.env.CPCLAW_NODE_BINARY||'node',[fileURLToPath(import.meta.url),'--seed',dataDir,...(process.env.CPCLAW_RECOVERY_IMAGE?[process.env.CPCLAW_RECOVERY_IMAGE]:[])],{encoding:'utf8'}));
  let win,worker;const calls=[],errors=[];
  const host=registerExtensionHost({dataDir,ipcMain,getWindow:()=>win,getActor:()=>actor});
  worker=createWorkspaceClient(dataDir,desktop,{onService:(request,signal)=>{calls.push(request.request.action);assert.equal(request.request.action,'recover_image');return host.executeService(request,signal);},onEvent:e=>win?.webContents.send('chat.event',e)});
  ipcMain.handle('workspace.call',async(_event,call)=>{if(call.input?.chatId)host.setContext(actor,call.input.chatId);return worker.request({...call,actorId:actor});});
  ipcMain.handle('ui.log',()=>({ok:true}));
  ipcMain.handle('runtime.status',()=>({ok:true,name:'deepseek-harness',ready:false,source:'none'}));
  ipcMain.handle('settings.get',()=>({ok:false,message:'隔离恢复测试，不连接平台'}));
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  app.whenReady().then(async()=>{
  const timer=setTimeout(()=>{console.error('media recovery verification timeout');worker.stop();app.exit(1);},45000);
  try{
    // Exercise the actual production page, IPC, native decoder and persisted chat flow.
    win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload:join(desktop,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
    win.webContents.on('console-message',(_e,level,message)=>{if(level===3&&!/No handler registered|平台地址|ERR_FILE_NOT_FOUND/.test(message))errors.push(message);});
    await win.loadFile(join(desktop,'renderer/index.html'));
    const js=code=>win.webContents.executeJavaScript(code);
    async function until(code){const end=Date.now()+12000;while(!await js(code)){if(Date.now()>end)throw Error('UI condition timed out: '+code);await wait(25);}}
    await until(`chatAccount===${JSON.stringify(actor)}`);
    await js(`selectChat(${JSON.stringify(seeded.chatId)})`);
    await js(`byId('chat-diagnose').click()`);
    await until(`byId('diagnostics-dialog').open&&!byId('chat-diagnose').dataset.busy&&lastDiagnoseResult?.task?.status==='delivered'`);
    assert.equal(await js(`lastDiagnoseResult.repairs.some(r=>r.code==='MEDIA_DELIVERY'&&r.verified)`),true);
    assert.equal(await js(`lastDiagnoseResult.authority`),'system-diagnostic');
    assert.equal(await js(`lastDiagnoseResult.experience.some(e=>e.code==='MEDIA_DELIVERY'&&e.state==='verified')`),true);
    await js(`Array.from(byId('diagnostics-body').querySelectorAll('button')).find(b=>b.textContent==='查看已恢复图片').click()`);
    await until(`Boolean(byId('diagnostics-body').querySelector('img')?.naturalWidth)`);
    assert.equal(await js(`Boolean(Array.from(byId('diagnostics-body').querySelectorAll('button')).find(b=>b.textContent==='打开原图'))`),true);
    const preview=previewServiceImage(seeded.path),image=nativeImage.createFromDataURL(preview),size=image.getSize();
    assert(Math.max(size.width,size.height)<=2048);assert(preview.length<12*1024*1024);
    const hash=createHash('sha256').update(readFileSync(seeded.path)).digest('hex');
    writeFileSync(join(evidence,'diagnosis-recovered.png'),await win.webContents.capturePage().then(i=>i.toPNG()));
    win.setSize(800,720);await wait(80);assert(await js(`byId('diagnostics-dialog').getBoundingClientRect().width<=innerWidth`));
    await js(`byId('diagnostics-close').click();selectChat('')`);worker.stop();
    await js(`selectChat(${JSON.stringify(seeded.chatId)})`);
    await until(`chatMessages.at(-1)?.content.includes('自诊断恢复成果')`);
    const saved=await worker.request({method:'chat.history',actorId:actor,input:{chatId:seeded.chatId}});
    await js(`window.restoreServicePanel(${JSON.stringify(saved.serviceSteps)},{mode:'chat',service:'dreamina'})`);
    await until(`Array.from(document.querySelectorAll('#service-operation-results img')).some(i=>i.naturalWidth>0)`);
    await js(`byId('chat-diagnose').click()`);await until(`!byId('chat-diagnose').dataset.busy&&lastDiagnoseResult?.task?.status==='delivered'`);
    assert.equal(await js(`lastDiagnoseResult.summary.repairState`),'none');assert.deepEqual(calls,['recover_image']);
    assert.equal(await js(`lastDiagnoseResult.experience.some(e=>e.code==='MEDIA_DELIVERY'&&e.state==='verified')`),true);
    assert.equal(hash,createHash('sha256').update(readFileSync(seeded.path)).digest('hex'));
    assert.deepEqual(errors,[]);
    const result={ok:true,checks:['native-large-image-preview','original-preserved','real-diagnostic-dialog','narrow-layout','worker-restart','persisted-service-panel-image','no-resubmission','no-repair-false-positive','system-diagnostic-authority','verified-experience-persisted'],preview:size,previewBytes:Buffer.byteLength(preview),originalBytes:readFileSync(seeded.path).length,sha256:hash};
    writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
    clearTimeout(timer);worker.stop();win.destroy();app.exit(0);
  }catch(error){clearTimeout(timer);console.error(error);worker.stop();app.exit(1);}
  });
}

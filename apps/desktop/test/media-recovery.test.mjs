import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,realpathSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {writeAccountSession} from '@cpclaw/desktop-host/account-session';
import {createChatService} from '../chat-service.mjs';
import {createServiceRuntime,dreaminaService,serviceImageData} from '../service-runtime.mjs';
import {mediaTaskState} from '../media-task-state.mjs';

const project='00000000-0000-4000-8000-000000000001',resource='00000000-0000-4000-8000-000000000002',submit='00000000-0000-4000-8000-000000000003';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=','base64');
const record=(step,args,result)=>({step,service:{id:'dreamina',title:'即梦画布',type:'CLI'},request:{action:'call',args:[...args,'--project-id',project]},result});

test('diagnosis recovers existing image, persists delivery, survives restart and never resubmits',async t=>{
 const root=mkdtempSync('/tmp/cpclaw-media-recovery-'),actor='media-user',events=[],calls=[];
 writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token'},{makeCurrent:true});
 // Offline platform must not prevent recovering an already downloaded image.
 t.mock.method(globalThis,'fetch',async()=>{throw Error('offline');});
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,notify:e=>events.push(e),run:()=>{throw Error('No CLI allowed for local recovery');}});
 const options={executeService:async(c,s)=>{calls.push(c.request);return runtime.execute(c,c.request,s);}};
 let service=createChatService(root,()=>{},options);
 const db=new DatabaseSync(join(root,'chat.sqlite'));
 const {chatId}=await service.dispatch('chat.create',actor,{});
 const dir=join(root,'service-artifacts',createHash('sha256').update(actor).digest('hex').slice(0,16),chatId);mkdirSync(dir,{recursive:true});
 const path=join(dir,`dreamina-${resource}.png`);writeFileSync(path,png);
 db.prepare('INSERT INTO chat_messages(id,chat,role,content,state,error,request) VALUES(?,?,?,?,?,?,?)').run('message',chatId,'assistant','本轮回复未完成，已恢复执行记录。','error','模型步骤达到上限，请继续当前任务','fixture');
 const steps=[record(1,['node','run','--node-id','node_0123456789'],{ok:true,recovery:{projectId:project,items:[{submitId:submit,nodeId:'node_0123456789'}]},data:{items:[{submitId:submit,nodeId:'node_0123456789',state:'accepted',resources:[{resourceId:resource}]}]}}),record(2,['operation','wait',submit],{ok:true,data:{state:'succeeded',resources:[{resourceId:resource,state:'succeeded'}]}}),record(3,['resource','get',resource],{ok:true,data:{resourceId:resource,type:'image',status:'success'}}),record(4,['resource','download',resource],{ok:false,code:'SERVICE_FAILED',message:'图片文件为空或超过预览限制'})];
 for(const s of steps)db.prepare('INSERT INTO chat_service_steps VALUES(?,?,?)').run('message',s.step,JSON.stringify(s));
 try{
  const report=await service.dispatch('chat.diagnose',actor,{chatId});
  assert.equal(report.task?.status,'delivered');assert.equal(report.task.images[0].resourceId,resource);
  assert(report.repairs.some(r=>r.code==='MEDIA_DELIVERY'&&r.verified));
  assert(events.some(e=>e.type==='image'&&e.path===realpathSync(path)));
  assert.equal(calls.length,1);assert.equal(calls[0].action,'recover_image');
  const history=await service.dispatch('chat.history',actor,{chatId});assert.match(history.messages.at(-1).content,/图片.*恢复|恢复.*图片/);
  assert.equal(history.messages.at(-1).state,'error'); // Preserve original execution failure.
  assert(history.serviceSteps.some(s=>s.request.action==='recover_image'&&s.result.data.path===realpathSync(path)));
  service.stop();service=createChatService(root,()=>{},options);
  const again=await service.dispatch('chat.diagnose',actor,{chatId});assert.equal(again.task.status,'delivered');assert.equal(again.repairs.length,0);assert.equal(calls.length,1);
  assert.equal((await service.dispatch('chat.diagnose', 'other', {chatId})).ok,false);
  const lines=(await import('node:fs')).readFileSync(join(root,'logs/desktop-worker.log'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.at(-1).fields.verified,0);assert.equal(lines.at(-1).fields.repairState,'none');
 }finally{service.stop();db.close();rmSync(root,{recursive:true,force:true});}
});

test('large valid image can be read while mismatched hashes remain rejected',()=>{
 const root=mkdtempSync('/tmp/cpclaw-large-image-');try{
  const bytes=Buffer.alloc(13*1024*1024);png.copy(bytes);const path=join(root,'large.png');writeFileSync(path,bytes);
  assert.match(serviceImageData(path),/^data:image\/png;base64,/);
  assert.throws(()=>serviceImageData(path,{sha256:'bad'}),/校验失败/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('local image recovery rejects paths and symlinks outside the current actor/chat',async()=>{
 const root=mkdtempSync('/tmp/cpclaw-media-isolation-');const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true});
 const context={actorId:'a',chatId:'chat',service:dreaminaService};
 try{
  const outside=join(root,'outside.png');writeFileSync(outside,png);
  const dir=join(root,'service-artifacts',createHash('sha256').update('a').digest('hex').slice(0,16),'chat');mkdirSync(dir,{recursive:true});symlinkSync(outside,join(dir,`dreamina-${resource}.png`));
  await assert.rejects(()=>runtime.execute(context,{action:'recover_image',resourceId:resource},new AbortController().signal),/目录|路径/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('diagnosis automatically resumes after restart using only the original submission and existing resource',async()=>{
 const root=mkdtempSync('/tmp/cpclaw-media-resume-'),actor='resume-user',calls=[];
 writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token'},{makeCurrent:true});
 let path;
 const options={executeService:async(context)=>{
  const q=context.request;calls.push(q);assert.equal(context.authority,'system-diagnostic');
  if(q.action==='discover')return {ok:true};
  assert.equal(q.action,'call');const [command,action]=q.args;
  assert(!q.args.includes('run'));assert(!q.args.includes('create'));assert(q.args.includes(project));
  if(command==='operation'){assert.equal(action,'status');assert.equal(q.args[2],submit);return {ok:true,data:{operationRef:submit,state:'succeeded',resources:[{resourceId:resource,state:'succeeded'}]}};}
  if(action==='get')return {ok:true,data:{resourceId:resource,type:'image',status:'success'}};
  assert.equal(command,'resource');assert.equal(action,'download');assert.equal(q.args[2],resource);
  writeFileSync(path,png);return {ok:true,data:{path,size:png.length,sha256:createHash('sha256').update(png).digest('hex'),deliveryVerified:true,preview:{state:'ready'}}};
 }};
 let service=createChatService(root,()=>{},options);const db=new DatabaseSync(join(root,'chat.sqlite'));
 const {chatId}=await service.dispatch('chat.create',actor,{});
 const dir=join(root,'service-artifacts',createHash('sha256').update(actor).digest('hex').slice(0,16),chatId);mkdirSync(dir,{recursive:true});path=join(dir,`dreamina-${resource}.png`);
 db.prepare('INSERT INTO chat_messages(id,chat,role,content,state,error,request) VALUES(?,?,?,?,?,?,?)').run('pending',chatId,'assistant','等待原任务','interrupted','应用退出','original');
 const saved=record(1,['node','run','--node-id','node_0123456789'],{ok:true,recovery:{projectId:project,items:[{nodeId:'node_0123456789',submitId:submit}]},data:{items:[{nodeId:'node_0123456789',submitId:submit,state:'accepted'}]}});
 db.prepare('INSERT INTO chat_service_steps VALUES(?,?,?)').run('pending',1,JSON.stringify(saved));
 service.stop();service=createChatService(root,()=>{},options);
 try{
  const result=await service.dispatch('chat.diagnose',actor,{chatId});
  assert.equal(result.ok,true);assert.equal(result.task.status,'delivered');assert(result.repairs.every(r=>r.verified));
  assert(result.experience.some(e=>e.code==='MEDIA_RESUME'&&e.state==='verified'));
  assert.deepEqual(calls.map(q=>q.action==='discover'?'discover':q.args.slice(0,2).join(' ')),['discover','operation status','resource get','resource download']);
  const history=await service.dispatch('chat.history',actor,{chatId});assert.equal(history.serviceSteps.length,5);
 }finally{service.stop();db.close();rmSync(root,{recursive:true,force:true});}
});

test('pending and failed operations remain unresolved; a successful sibling image cannot mask them',()=>{
 const done=record(1,['resource','get',resource],{ok:true,data:{resourceId:resource,type:'image',status:'success'}});
 const pending=record(2,['node','run','--node-id','node_0123456789'],{ok:true,recovery:{items:[{submitId:submit}]},data:{items:[{submitId:submit,state:'accepted'}]}});
 const state=mediaTaskState([done,pending]);assert.equal(state.status,'pending');assert.equal(state.images.length,1);
 assert.equal(mediaTaskState([record(1,['operation','status',submit],{ok:true,data:{state:'failed'}})]).status,'failed');
 const delivered=record(3,['resource','download',resource],{ok:true,data:{path:'/fixture/image.png',deliveryVerified:true,preview:{state:'ready'}}});
 assert.equal(mediaTaskState([done,delivered,record(4,['operation','status',submit],{ok:true,data:{state:'failed'}})]).status,'failed');
});

test('preview failure retains the successful download path, size and checksum',async()=>{
 const root=mkdtempSync('/tmp/cpclaw-preview-failure-'),actor='preview-user',chatId='preview-chat';
 const dir=join(root,'service-artifacts',createHash('sha256').update(actor).digest('hex').slice(0,16),chatId);mkdirSync(dir,{recursive:true});
 const path=join(dir,`dreamina-${resource}.png`);writeFileSync(path,png);
 const schema=JSON.parse(readFileSync(new URL('./fixtures/dreamina-schema.json',import.meta.url)));
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,approve:async()=>true,binaryPath:x=>x,readBinary:()=>Buffer.from('fixture'),previewImage:()=>{throw Error('decode failed');},run:async(_file,full)=>{
  const args=full.slice(3);
  const value=args[0]==='schema'?{ok:true,data:schema}:args.join(' ')==='auth status'?{ok:true,data:{loggedIn:true}}:args[0]==='resource'?{ok:true,data:{path,size:png.length,sha256:createHash('sha256').update(png).digest('hex')}}:{ok:true,data:{}};
  return {stdout:JSON.stringify(value)};
 }});
 try{
  const context={actorId:actor,chatId,service:dreaminaService},signal=new AbortController().signal;
  await runtime.execute(context,{action:'discover'},signal);
  const result=await runtime.execute(context,{action:'call',args:['resource','download',resource,'--project-id',project]},signal);
  assert.equal(result.ok,true);assert.equal(result.data.path,realpathSync(path));assert.equal(result.data.preview.state,'failed');assert.equal(result.data.size,png.length);assert(result.data.sha256);
 }finally{rmSync(root,{recursive:true,force:true});}
});

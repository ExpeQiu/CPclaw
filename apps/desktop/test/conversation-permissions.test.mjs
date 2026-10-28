import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createConversationPermissions} from '../conversation-permissions.mjs';
import {createServiceRuntime} from '../service-runtime.mjs';
import {localService} from '../local-tools.mjs';

const context={actorId:'a',chatId:'c'};
test('conversation modes are isolated by account and chat, survive switching, and reset on new host',()=>{
 const p=createConversationPermissions();assert.equal(p.get(context).mode,'ask');p.set(context,'full');
 assert.equal(p.get({...context,chatId:'other'}).mode,'ask');assert.equal(p.get({...context,actorId:'b'}).mode,'ask');assert.equal(p.get(context).mode,'full');
 assert.throws(()=>p.set(context,'forged'));assert.throws(()=>p.set({...context,chatId:''},'full'));
 const revision=p.get(context).revision;p.set(context,'ask');assert(p.get(context).revision>revision);
 p.set(context,'full');p.clearActor('a');assert.equal(p.get(context).mode,'ask');assert.equal(createConversationPermissions().get(context).mode,'ask');
});
function fixture(mode,approve=false){
 const root=mkdtempSync('/tmp/cpclaw-permission-tools-'),project=join(root,'project'),external=join(root,'outside');mkdirSync(project);mkdirSync(external);writeFileSync(join(project,'input.txt'),'project input');writeFileSync(join(external,'private.txt'),'external fixture');
 const policy=createConversationPermissions();policy.set(context,mode);const approvals=[];
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,getPermission:c=>policy.get(c),approve:async request=>{approvals.push(request);return approve;}});
 const c={...context,taskId:'task-1',service:localService,workingDirectory:project,projectRoot:project};
 const execute=(r,signal=new AbortController().signal)=>runtime.execute(c,r,signal);
 return {root,project,external,c,policy,runtime,execute,approvals,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('ask mode denies project reads until a real approval and does not open files on denial',async()=>{
 const f=fixture('ask');try{await assert.rejects(f.execute({action:'read_file',path:'input.txt'}),e=>e.code==='DENIED');assert.equal(f.approvals.length,1);}finally{f.close();}
});
test('auto mode reads project files without prompts, but asks for writes, external reads and arbitrary terminal commands',async()=>{
 const f=fixture('auto');try{
  assert.equal((await f.execute({action:'read_file',path:'input.txt'})).content,'project input');assert.equal(f.approvals.length,0);
  symlinkSync(join(f.external,'private.txt'),join(f.project,'link.txt'));
  for(const request of [{action:'write_file',path:'new.txt',content:'blocked'},{action:'read_file',path:join(f.external,'private.txt')},{action:'read_file',path:'link.txt'},{action:'terminal',command:'echo hello'}])await assert.rejects(f.execute(request),e=>e.code==='DENIED');
  assert(!existsSync(join(f.project,'new.txt')));assert.equal(f.approvals.length,4);
 }finally{f.close();}
});
test('full mode performs real external file writes and terminal commands without individual prompts, returning verified output',async()=>{
 const f=fixture('full');try{
  const file=join(f.external,'result.txt');const saved=await f.execute({action:'write_file',path:file,content:'verified'});assert(saved.verified);assert.equal(readFileSync(file,'utf8'),'verified');
  const result=await f.execute({action:'terminal',command:"printf 'terminal works'",cwd:f.external});assert.equal(result.exitCode,0);assert.equal(result.stdout,'terminal works');assert.equal(result.cwd,realpathSync(f.external));assert.equal(f.approvals.length,0);
  const failed=await f.execute({action:'terminal',command:"printf 'failure detail' >&2; exit 7"});assert.equal(failed.ok,false);assert.equal(failed.exitCode,7);assert.match(failed.stderr,/failure detail/);
 }finally{f.close();}
});
test('mode downgrade invalidates the existing task and requires a new task under the new policy',async()=>{
 const f=fixture('full');try{
  await f.execute({action:'read_file',path:'input.txt'});f.policy.set(context,'ask');f.runtime.revoke();
  await assert.rejects(f.execute({action:'terminal',command:'pwd'}),e=>e.code==='DENIED');
  f.c.taskId='task-2';await assert.rejects(f.execute({action:'terminal',command:'pwd'}),e=>e.code==='DENIED');assert.equal(f.approvals.length,1);
 }finally{f.close();}
});
test('revocation or context change during an approval cannot execute a stale command',async()=>{
 let resolveApproval;
 const root=mkdtempSync('/tmp/cpclaw-permission-revoke-'),policy=createConversationPermissions();let current=true;
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>current,getPermission:c=>policy.get(c),approve:()=>new Promise(r=>{resolveApproval=r;})});
 const c={...context,taskId:'task-1',service:localService,workingDirectory:root};
 const pending=runtime.execute(c,{action:'terminal',command:'echo must-not-run'},new AbortController().signal);
 await Promise.resolve();current=false;runtime.revoke();resolveApproval(true);await assert.rejects(pending,/会话或账号已变化/);rmSync(root,{recursive:true,force:true});
});


test('full mode terminal timeout is bounded and cancellation stops execution',async()=>{
 const f=fixture('full');try{
  const timed=await f.execute({action:'terminal',command:'sleep 10',timeoutMs:100});assert.equal(timed.code,'COMMAND_TIMEOUT');
  const controller=new AbortController(),pending=f.execute({action:'terminal',command:'sleep 10'},controller.signal);
  setTimeout(()=>controller.abort(),30);await assert.rejects(pending);
 }finally{f.close();}
});
test('ask mode still offers task and conversation scopes so one approval can cover a whole task',async()=>{
 const f=fixture('ask',{mode:'task',creditCeiling:0});try{
  await f.execute({action:'read_file',path:'input.txt'});
  assert.equal(f.approvals.length,1);
  assert.equal(f.approvals[0].canAuthorizeTask,true);
  assert.equal(f.approvals[0].canAuthorizeAuto,true);
  assert.equal(f.approvals[0].conversationMode,'ask');
  // 同任务内第二次操作复用授权，不再弹窗。
  await f.execute({action:'read_file',path:'input.txt'});
  assert.equal(f.approvals.length,1);
 }finally{f.close();}
});
test('ask mode without a task or chat identity can only authorize the current operation',async()=>{
 const root=mkdtempSync('/tmp/cpclaw-permission-scope-');
 const policy=createConversationPermissions();
 const approvals=[];
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,getPermission:c=>policy.get(c),approve:async p=>{approvals.push(p);return {mode:'once',creditCeiling:0};}});
 const c={actorId:'a',chatId:'',service:localService,workingDirectory:root};
 await runtime.execute(c,{action:'terminal',command:'pwd'},new AbortController().signal);
 assert.equal(approvals[0].canAuthorizeTask,false);
 assert.equal(approvals[0].canAuthorizeAuto,false);
 rmSync(root,{recursive:true,force:true});
});
test('narrowing to a single operation stops the saved task grant from covering later calls',async()=>{
 const f=fixture('ask',{mode:'task',creditCeiling:0});try{
  await f.execute({action:'read_file',path:'input.txt'});
  assert.equal(f.approvals.length,1);
  // 同任务内第二次操作复用任务授权，不再弹窗。
  await f.execute({action:'read_file',path:'input.txt'});
  assert.equal(f.approvals.length,1);
  // 换一个任务后任务授权不再覆盖，必须重新确认。
  f.c.taskId='task-2';
  await f.execute({action:'read_file',path:'input.txt'});
  assert.equal(f.approvals.length,2);
 }finally{f.close();}
});
test('a single operation grant never covers the next operation',async()=>{
 const f=fixture('ask',{mode:'once',creditCeiling:0});try{
  await f.execute({action:'read_file',path:'input.txt'});
  await f.execute({action:'read_file',path:'input.txt'});
  assert.equal(f.approvals.length,2);
  assert.deepEqual(f.runtime.status(f.c).grants,[]);
 }finally{f.close();}
});
test('narrowing to a single operation drops the saved task grant from the reported grants',async()=>{
 const f=fixture('ask',{mode:'task',creditCeiling:8});try{
  await f.execute({action:'read_file',path:'input.txt'});
  const grants=f.runtime.status(f.c).grants;
  assert.equal(grants.length,1);
  assert.equal(grants[0].mode,'task');
  assert.equal(grants[0].reservedCredits,0);
 }finally{f.close();}
});

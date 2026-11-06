import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {canAutoApprove,createConversationPermissions} from '../conversation-permissions.mjs';
import {createServiceRuntime} from '../service-runtime.mjs';
import {localService} from '../local-tools.mjs';

const context={actorId:'a',chatId:'c'};
test('conversation modes are isolated by account and chat, survive switching, and reset on new host',()=>{
 const p=createConversationPermissions();assert.equal(p.get(context).mode,'auto');p.set(context,'full');
 assert.equal(p.get({...context,chatId:'other'}).mode,'auto');assert.equal(p.get({...context,actorId:'b'}).mode,'auto');assert.equal(p.get(context).mode,'full');
 assert.throws(()=>p.set(context,'forged'));assert.throws(()=>p.set({...context,chatId:''},'full'));
 const revision=p.get(context).revision;p.set(context,'ask');assert(p.get(context).revision>revision);
 p.set(context,'full');p.clearActor('a');assert.equal(p.get(context).mode,'auto');assert.equal(createConversationPermissions().get(context).mode,'auto');
});
function fixture(mode,approve=false){
 const root=mkdtempSync('/tmp/cpclaw-permission-tools-'),project=join(root,'project'),external=join(root,'outside');mkdirSync(project);mkdirSync(external);writeFileSync(join(project,'input.txt'),'project input');writeFileSync(join(external,'private.txt'),'external fixture');
 const policy=createConversationPermissions();policy.set(context,mode);const approvals=[];
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,getPermission:c=>policy.get(c),approve:async request=>{approvals.push(request);return approve;}});
 const c={...context,taskId:'task-1',service:localService,workingDirectory:project,projectRoot:project};
 const execute=(r,signal=new AbortController().signal)=>runtime.execute(c,r,signal);
 return {root,project,external,c,policy,runtime,execute,approvals,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('ask and auto share the workspace sandbox; only ask stops external edits and network',async()=>{
 const ask=fixture('ask'),auto=fixture('auto');
 try{
  assert.equal((await ask.execute({action:'read_file',path:'input.txt'})).content,'project input');
  assert.equal((await ask.execute({action:'write_file',path:'new.txt',content:'inside'})).verified,true);
  assert.equal((await ask.execute({action:'terminal',command:'printf local'})).stdout,'local');
  assert.equal(ask.approvals.length,0);
  await assert.rejects(ask.execute({action:'write_file',path:join(ask.external,'out.txt'),content:'outside'}),e=>e.code==='DENIED');
  await assert.rejects(ask.execute({action:'terminal',command:'printf net # https://example.com'}),e=>e.code==='DENIED');
  assert(!existsSync(join(ask.external,'out.txt')));
  assert.equal((await auto.execute({action:'write_file',path:'new.txt',content:'inside'})).verified,true);
  assert.equal((await auto.execute({action:'write_file',path:join(auto.external,'out.txt'),content:'outside'})).verified,true);
  assert.equal((await auto.execute({action:'terminal',command:'printf net # https://example.com'})).stdout,'net');
  await assert.rejects(auto.execute({action:'terminal',command:'printf risk # ~/.ssh/id_rsa'}),e=>e.code==='DENIED');
  assert.equal(auto.approvals.length,1);
 }finally{ask.close();auto.close();}
});
test('approval matrix matches Codex ask, approve-for-me, and full access',()=>{
 const allow=(mode,risk,cost=0)=>canAutoApprove({mode},risk,cost);
 assert.equal(allow('ask','workspace'),true);assert.equal(allow('ask','read'),true);assert.equal(allow('ask','external-read'),true);
 assert.equal(allow('ask','external-write'),false);assert.equal(allow('ask','network'),false);assert.equal(allow('ask','unsafe'),false);
 assert.equal(allow('auto','external-write'),true);assert.equal(allow('auto','network'),true);assert.equal(allow('auto','unknown'),true);
 assert.equal(allow('auto','unsafe'),false);assert.equal(allow('auto','network',8),false);
 assert.equal(allow('full','unsafe'),true);assert.equal(allow('full','network',8),true);
 assert.equal(allow('legacy','read'),false);
});
test('full mode performs real external file writes and terminal commands without individual prompts, returning verified output',async()=>{
 const f=fixture('full');try{
  const file=join(f.external,'result.txt');const saved=await f.execute({action:'write_file',path:file,content:'verified'});assert(saved.verified);assert.equal(readFileSync(file,'utf8'),'verified');
  const result=await f.execute({action:'terminal',command:"printf 'terminal works'",cwd:f.external});assert.equal(result.exitCode,0);assert.equal(result.stdout,'terminal works');assert.equal(result.cwd,realpathSync(f.external));assert.equal(f.approvals.length,0);
  const failed=await f.execute({action:'terminal',command:"printf 'failure detail' >&2; exit 7"});assert.equal(failed.ok,false);assert.equal(failed.exitCode,7);assert.match(failed.stderr,/failure detail/);
 }finally{f.close();}
});
test('mode downgrade keeps the same task alive and asks under the new policy',async()=>{
 const f=fixture('full');try{
  await f.execute({action:'read_file',path:'input.txt'});f.policy.set(context,'ask');f.runtime.revoke();
  await assert.rejects(f.execute({action:'terminal',command:'printf continued # https://example.com'}),e=>e.code==='DENIED');
  assert.equal(f.c.taskId,'task-1');assert.equal(f.approvals.length,1);
 }finally{f.close();}
});
test('revocation or context change during an approval cannot execute a stale command',async()=>{
 let resolveApproval;
 const root=mkdtempSync('/tmp/cpclaw-permission-revoke-'),policy=createConversationPermissions();let current=true;
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>current,getPermission:c=>policy.get(c),approve:()=>new Promise(r=>{resolveApproval=r;})});
 const c={...context,taskId:'task-1',service:localService,workingDirectory:root};
 const pending=runtime.execute(c,{action:'terminal',command:'echo must-not-run # ~/.ssh/id_rsa'},new AbortController().signal);
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
  const boundary={action:'terminal',command:"printf ok # https://example.com"};
  await f.execute(boundary);
  assert.equal(f.approvals.length,1);
  assert.equal(f.approvals[0].canAuthorizeTask,true);
  assert.equal(f.approvals[0].canAuthorizeAuto,true);
  assert.equal(f.approvals[0].conversationMode,'ask');
  await f.execute(boundary);
  assert.equal(f.approvals.length,1);
 }finally{f.close();}
});
test('ask mode without a task or chat identity can only authorize the current operation',async()=>{
 const root=mkdtempSync('/tmp/cpclaw-permission-scope-');
 const policy=createConversationPermissions();
 const approvals=[];
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,getPermission:c=>policy.get(c),approve:async p=>{approvals.push(p);return {mode:'once',creditCeiling:0};}});
 const c={actorId:'a',chatId:'',service:localService,workingDirectory:root};
 await runtime.execute(c,{action:'terminal',command:'printf ok # ~/.ssh/id_rsa'},new AbortController().signal);
 assert.equal(approvals[0].canAuthorizeTask,false);
 assert.equal(approvals[0].canAuthorizeAuto,false);
 rmSync(root,{recursive:true,force:true});
});
test('narrowing to a single operation stops the saved task grant from covering later calls',async()=>{
 const f=fixture('ask',{mode:'task',creditCeiling:0});try{
  const boundary={action:'terminal',command:"printf ok # https://example.com"};
  await f.execute(boundary);
  assert.equal(f.approvals.length,1);
  await f.execute(boundary);
  assert.equal(f.approvals.length,1);
  f.c.taskId='task-2';
  await f.execute(boundary);
  assert.equal(f.approvals.length,2);
 }finally{f.close();}
});
test('a single operation grant never covers the next operation',async()=>{
 const f=fixture('ask',{mode:'once',creditCeiling:0});try{
  const boundary={action:'terminal',command:"printf ok # https://example.com"};
  await f.execute(boundary);
  await f.execute(boundary);
  assert.equal(f.approvals.length,2);
  assert.deepEqual(f.runtime.status(f.c).grants,[]);
 }finally{f.close();}
});
test('narrowing to a single operation drops the saved task grant from the reported grants',async()=>{
 const f=fixture('ask',{mode:'task',creditCeiling:8});try{
  await f.execute({action:'terminal',command:"printf ok # https://example.com"});
  const grants=f.runtime.status(f.c).grants;
  assert.equal(grants.length,1);
  assert.equal(grants[0].mode,'task');
  assert.equal(grants[0].reservedCredits,0);
 }finally{f.close();}
});

test('switching from ask to full during approval rechecks permission and continues the same operation',async()=>{
 const root=mkdtempSync('/tmp/cpclaw-permission-live-'),policy=createConversationPermissions();policy.set(context,'ask');
 let resolveApproval,requests=0;
 const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,getPermission:c=>policy.get(c),approve:()=>{requests++;return new Promise(r=>{resolveApproval=r;});}});
 try{const pending=runtime.execute({...context,taskId:'live-task',service:localService,workingDirectory:root},{action:'terminal',command:'printf continued # https://example.com'},new AbortController().signal);
  while(!resolveApproval)await new Promise(r=>setTimeout(r,1));policy.set(context,'full');runtime.revoke();resolveApproval(false);
  const result=await pending;assert.equal(result.stdout,'continued');assert.equal(requests,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

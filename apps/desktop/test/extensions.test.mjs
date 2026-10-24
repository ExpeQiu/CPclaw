import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionService } from '../extension-service.mjs';
function fixture(replies) {
 const calls=[];
 const service=createExtensionService({binary:'/fixed/cli',resolveBinary:path=>path,exists:()=>true,run:async(file,args,options)=>{
  calls.push({file,args,options});const reply=replies.shift();if(reply instanceof Error)throw reply;return {stdout:JSON.stringify(reply)};
 }});return {service,calls};
}
const version={ok:true,data:{version:'1.0.1'}};
const auth=loggedIn=>({ok:true,data:{loggedIn}});
test('missing CLI does not launch a process',async()=>{
 const s=createExtensionService({exists:()=>false,run:()=>{throw Error('must not run');}});assert.equal((await s.inspect()).state,'missing');
});
test('logged out stops before reading canvases',async()=>{
 const {service,calls}=fixture([version,auth(false)]);assert.equal((await service.inspect()).state,'login');assert.equal(calls.length,2);
});
test('nonzero exit with structured scope error overrides local login',async()=>{
 const e=Object.assign(Error('exit 11'),{stdout:JSON.stringify({ok:false,error:{reason:'oauth_scope_insufficient'}})});
 const {service}=fixture([version,auth(true),e]);assert.equal((await service.inspect()).state,'scope');
});
test('read success is required for ready and command arguments are fixed',async()=>{
 const {service,calls}=fixture([version,auth(true),{ok:true,data:{items:[]}}]);assert.equal((await service.inspect()).state,'ready');assert.deepEqual(calls[2].args,['--non-interactive','--format','json','canvas','ls','--limit','1']);assert.equal(calls[2].file,'/fixed/cli');assert.equal(calls[2].options.timeout,15000);
});
test('concurrent checks share one process sequence',async()=>{
 const {service,calls}=fixture([version,auth(false)]);const [a,b]=await Promise.all([service.inspect(),service.inspect()]);assert.deepEqual(a,b);assert.equal(calls.length,2);
});
test('process timeout gives bounded sanitized feedback',async()=>{
 const {service}=fixture([Error('private path and token')]);const r=await service.inspect();assert.equal(r.state,'error');assert.ok(!JSON.stringify(r).includes('token'));
});
test('network failure is not presented as logged out or ready',async()=>{
 const {service}=fixture([version,auth(true),{ok:false,error:{reason:'network_timeout'}}]);assert.equal((await service.inspect()).state,'unavailable');
});

test('real CLI scope error on stderr is classified instead of generic timeout',async()=>{
 const e=Object.assign(Error('exit 11'),{code:11,stdout:'',stderr:JSON.stringify({ok:false,error:{reason:'oauth_scope_insufficient'}})});
 const {service}=fixture([version,auth(true),e]);const r=await service.inspect();assert.equal(r.state,'scope');assert.equal(r.version,'1.0.1');
});
test('non-JSON stdout does not conceal structured stderr',async()=>{
 const e=Object.assign(Error('exit 11'),{stdout:'diagnostic text',stderr:JSON.stringify({ok:false,error:{reason:'oauth_scope_insufficient'}})});
 const {service}=fixture([version,auth(true),e]);assert.equal((await service.inspect()).state,'scope');
});
test('killed process cannot turn partial success output into ready',async()=>{
 const e=Object.assign(Error('timeout'),{killed:true,signal:'SIGTERM',stdout:JSON.stringify({ok:true,data:{items:[]}})});
 const {service}=fixture([version,auth(true),e]);assert.equal((await service.inspect()).state,'error');
});

test('authorization guard runs before every command and abort prevents execution',async()=>{
 let checks=0;
 const {service,calls}=fixture([version,auth(true),{ok:true,data:{items:[]}}]);
 const result=await service.inspect({beforeExecute:()=>{checks++;if(checks===2)throw Error('revoked');}});
 assert.equal(result.state,'error');assert.equal(calls.length,1);
});

test('displayed plan exactly matches actual executable arguments and cwd',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const folder=mkdtempSync(join(tmpdir(),'cpclaw-plan-'));const binary=join(folder,'cli');writeFileSync(binary,'fake program');
 try{
  const calls=[],replies=[version,auth(true),{ok:true,data:{items:[]}}];
  const service=createExtensionService({binary,cwd:folder,run:async(file,args,options)=>{calls.push([file,...args]);assert.equal(options.cwd,folder);return{stdout:JSON.stringify(replies.shift())};}});
  const plan=service.describeInspection();assert.equal((await service.inspect()).state,'ready');assert.deepEqual(calls,plan.commands);
  writeFileSync(binary,'changed program');assert.notEqual(service.describeInspection().fingerprint,plan.fingerprint);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

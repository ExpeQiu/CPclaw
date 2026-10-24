import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCommandAuthorization} from '../local-command-authorization.mjs';
function fixture(choices=['once']) {
 let context={actorId:'employee-a',chatId:'chat-a'},fingerprint='binary-and-command-a';
 const asked=[],executions=[];
 const gate=createCommandAuthorization({getContext:()=>({...context}),getPlan:()=>fingerprint?{fingerprint,cwd:'/project',commands:[['/cli','auth','status']]}:null,
  requestApproval:async(plan,options)=>{asked.push({plan,...options});const choice=choices.shift();return typeof choice==='function'?choice(options):choice;},
  execute:async(options)=>{options.beforeExecute();executions.push(options);return {ok:true,state:'ready'};}});
 return {gate,asked,executions,context:next=>{context=next;gate.revoke();},changePlan:value=>fingerprint=value};
}
test('denial and dialog close launch no commands',async()=>{
 for(const choice of ['deny',undefined,'renderer-approved']) {const f=fixture([choice]);assert.equal((await f.gate.run()).state,'denied');assert.equal(f.executions.length,0);}
});
test('command execution waits for actual approval',async()=>{
 let allow;const f=fixture([()=>new Promise(r=>allow=r)]);const pending=f.gate.run();await Promise.resolve();assert.equal(f.executions.length,0);allow('once');assert.equal((await pending).state,'ready');assert.equal(f.executions.length,1);
});
test('once permission is consumed and cannot silently authorize another run',async()=>{
 const f=fixture(['once','deny']);await f.gate.run();assert.equal((await f.gate.run()).state,'denied');assert.equal(f.asked.length,2);assert.equal(f.executions.length,1);
});
test('conversation grant covers only the exact command and binary fingerprint',async()=>{
 const f=fixture(['conversation','deny']);await f.gate.run();await f.gate.run();assert.equal(f.asked.length,1);f.changePlan('binary-or-arguments-changed');assert.equal((await f.gate.run()).state,'denied');assert.equal(f.executions.length,2);
});
test('changing working directory requires a new approval',async()=>{
 const f=fixture(['conversation','deny']);await f.gate.run();f.changePlan('different-working-directory');assert.equal((await f.gate.run()).state,'denied');
});
test('revoke and switching conversations discard the grant even after switching back',async()=>{
 const f=fixture(['conversation','deny']);await f.gate.run();f.context({actorId:'employee-a',chatId:'chat-b'});f.context({actorId:'employee-a',chatId:'chat-a'});assert.equal(f.gate.status().remembered,false);assert.equal((await f.gate.run()).state,'denied');
});
test('account changes invalidate an outstanding approval',async()=>{
 let allow;const f=fixture([()=>new Promise(r=>allow=r)]);const pending=f.gate.run();await Promise.resolve();f.context({actorId:'employee-b',chatId:'chat-a'});allow('conversation');assert.equal((await pending).state,'cancelled');assert.equal(f.executions.length,0);
});
test('changed commands while dialog is open are not executed',async()=>{
 let allow;const f=fixture([()=>new Promise(r=>allow=r)]);const pending=f.gate.run();await Promise.resolve();f.changePlan('changed');allow('once');assert.equal((await pending).state,'denied');assert.equal(f.executions.length,0);
});
test('concurrent requests do not share a pending approval',async()=>{
 let allow;const f=fixture([()=>new Promise(r=>allow=r)]);const pending=f.gate.run();assert.equal((await f.gate.run()).state,'busy');allow('once');await pending;assert.equal(f.executions.length,1);
});
test('missing CLI needs no execution permission',async()=>{
 const f=fixture();f.changePlan(null);assert.equal((await f.gate.run()).state,'missing');assert.equal(f.asked.length,0);assert.equal(f.executions.length,0);
});
test('empty conversations cannot acquire remembered permission',async()=>{
 const f=fixture(['conversation']);f.context({actorId:'employee-a',chatId:''});assert.equal((await f.gate.run()).state,'denied');assert.equal(f.asked[0].canRemember,false);assert.equal(f.executions.length,0);
});
test('new host instances have no persisted permission',async()=>{
 const f=fixture(['conversation']);await f.gate.run();assert.equal(f.gate.status().remembered,true);assert.equal(fixture().gate.status().remembered,false);
});

test('revoking an in-flight execution aborts its process signal',async()=>{
 let started,finish;const executing=new Promise(r=>started=r);let captured;
 const gate=createCommandAuthorization({getContext:()=>({actorId:'a',chatId:'c'}),getPlan:()=>({fingerprint:'same'}),requestApproval:async()=> 'once',
 execute:async options=>{captured=options;started();return new Promise(r=>finish=r);}});
 const pending=gate.run();await executing;gate.revoke();assert.equal(captured.signal.aborted,true);finish({ok:true,state:'ready'});assert.equal((await pending).state,'cancelled');
});

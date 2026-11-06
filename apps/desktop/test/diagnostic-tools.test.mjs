import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticTools} from '../diagnostic-tools.mjs';
import {fixture} from './fixtures/unified.mjs';
test('host action tokens bind actor and evidence, execute once and verify by readback',async()=>{
 let stamp='original',fixed=false,executions=0;
 const tools=createDiagnosticTools({fingerprint:()=>stamp,inspect:async()=>({ok:true,requestId:'r',repairActions:fixed?[]:[{code:'MEDIA_RESUME',runnable:true},{code:'ARBITRARY',runnable:true}]}),repair:async()=>{executions++;fixed=true;return {ok:true,repairs:[{verified:true}]};}});
 const call=(n,a={},actor='a')=>tools.call('diagnostic_'+n,actor,{chatId:'c',...a});
 const report=await call('inspect');assert.equal(report.repairActions[1].runnable,false);const actionId=report.repairActions[0].actionId;
 assert.equal((await call('repair',{actionId},'other')).ok,false);
 stamp='changed';assert.equal((await call('repair',{actionId})).code,'DIAGNOSTIC_EVIDENCE_CHANGED');stamp='original';
 const result=await call('repair',{actionId});assert.equal(executions,1);assert.equal((await call('repair',{actionId})).ok,false);
 assert.equal((await call('verify',{receiptId:result.receiptId})).verified,true);
 assert.equal((await call('verify',{receiptId:result.receiptId},'other')).ok,false);
});
test('Harness inspects a specific prior request while running without invoking service repairs',async t=>{
 let count=0,target,serviceCalls=0;
 const f=fixture(t,async i=>{i.onAccepted('accepted');if(++count===1)throw Error('original failure');
  const inspect=await i.pipeline.execute({name:'diagnostic_inspect',callId:'inspection',arguments:{requestId:target,scope:'model'}});
  assert.equal(inspect.ok,true,JSON.stringify(inspect));assert.equal(inspect.requestId,target);assert.equal(inspect.readOnly,true);assert.deepEqual(inspect.repairs,[]);
  assert.equal((await i.pipeline.execute({name:'diagnostic_repair',callId:'forged',arguments:{actionId:'invented'}})).code,'DIAGNOSTIC_ACTION_INVALID');
  return {finalResponse:'依据原请求证据解释'};
 },async()=>{serviceCalls++;return {ok:true};});
 try{const c=await f.create();target='original-request';await f.send(c,'original',target);const report=await f.service.dispatch('diagnostic.inspect',f.actor,{chatId:c,requestId:target});assert(report.ok);assert.equal((await f.service.dispatch('diagnostic.inspect','foreign',{chatId:c,requestId:target})).ok,false);assert.equal((await f.service.dispatch('diagnostic.inspect',f.actor,{chatId:c,requestId:'missing'})).ok,false);const result=await f.send(c,'解释');assert.equal(result.state,'done',result.error);assert.equal(serviceCalls,0);}finally{f.stop();}
});
test('expired actions and unresolved repairs cannot produce verified success',async()=>{
 let time=0;
 const tools=createDiagnosticTools({now:()=>time,fingerprint:()=> 'same',inspect:async()=>({ok:true,requestId:'r',repairActions:[{code:'MEDIA_RESUME',runnable:true}]}),repair:async()=>({ok:true,repairs:[{verified:true}]})});
 const call=(name,input={})=>tools.call('diagnostic_'+name,'a',{chatId:'c',...input});
 const first=await call('inspect');time=300001;assert.equal((await call('repair',{actionId:first.repairActions[0].actionId})).code,'DIAGNOSTIC_ACTION_INVALID');
 const second=await call('inspect'),r=await call('repair',{actionId:second.repairActions[0].actionId});assert.equal((await call('verify',{receiptId:r.receiptId})).verified,false);
});

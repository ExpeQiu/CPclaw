import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture} from './fixtures/unified.mjs';
test('a bridge permission change result does not abort the Harness conversation',async t=>{
 let calls=0;
 const f=fixture(t,async i=>{i.onAccepted('accepted');
  const first=await i.pipeline.execute({name:'terminal',callId:'changed',arguments:{command:'pwd'}});
  assert.equal(first.code,'PERMISSION_CHANGED');assert.equal(i.signal.aborted,false);
  assert.equal((await i.pipeline.execute({name:'terminal',callId:'new-policy',arguments:{command:'pwd'}})).ok,true);
  return {finalResponse:'按新权限继续完成'};
 },async()=>++calls===1?{ok:false,code:'PERMISSION_CHANGED',message:'权限已改变'}:{ok:true,stdout:'ok'});
 try{const r=await f.send(await f.create(),'检查');assert.equal(r.state,'done');assert.equal(calls,2);}finally{f.stop();}
});
test('connection failure issues retain visible technical details and preserved-evidence text',async t=>{
 const f=fixture(t,async i=>{i.onAccepted('accepted');i.onDiagnostic({modelCall:1,requestId:'loop-test',diagnostic:{code:'MODEL_CONNECTION_FAILED',stage:'model_connect',transportCode:'UND_ERR_SOCKET'}});throw Object.assign(Error('模型连接失败'),{code:'MODEL_CONNECTION_FAILED'});});
 try{const r=await f.send(await f.create(),'检查');assert.equal(r.state,'error');const issue=f.events.findLast(e=>e.type==='finish').issue;assert.match(issue.details,/UND_ERR_SOCKET/);assert.match(issue.details,/model_connect/);assert(issue.impact);assert(issue.preserved);
 const db=new DatabaseSync(join(f.root,'chat.sqlite'));const message=db.prepare("SELECT id FROM chat_messages WHERE chat=? AND role='assistant'").get(r.chatId);db.prepare('UPDATE chat_issues SET body=? WHERE message=?').run(JSON.stringify({code:'MODEL_CONNECTION_FAILED',title:'模型连接失败',summary:'失败'}),message.id);db.close();
 const history=await f.service.dispatch('chat.history',f.actor,{chatId:r.chatId});const old=history.messages.at(-1).issue;assert.match(old.details,/UND_ERR_SOCKET/);assert(old.impact);assert(old.preserved);}finally{f.stop();}
});

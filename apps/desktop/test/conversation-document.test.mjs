import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './fixtures/unified.mjs';

test('save document writes the conversation through this reply and keeps the file',async t=>{
  const f=fixture(t,async input=>{input.onAccepted('accepted');return {finalResponse:'这是回复正文'};});
  try{
    const chatId=await f.create();
    assert.equal((await f.send(chatId,'用户问题')).state,'done');
    const history=await f.service.dispatch('chat.history',f.actor,{chatId});
    const message=history.messages.find(row=>row.role==='assistant');
    const saved=await f.service.dispatch('document.create',f.actor,{chatId,messageId:message.id});
    assert.equal(saved.ok,true,JSON.stringify(saved));
    assert.match(saved.artifact.name,/\.md$/);
    const read=await f.service.dispatch('document.read',f.actor,{id:saved.artifact.id});
    const body=read.artifact.body;
    assert.ok(body.indexOf('用户问题')>=0&&body.indexOf('用户问题')<body.indexOf('这是回复正文'));
    assert.match(body,/## 你/);
    assert.match(body,/## CPclaw/);
    assert.equal(readFileSync(saved.artifact.path,'utf8'),body);
  }finally{f.stop();}
});

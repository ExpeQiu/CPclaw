import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createChatService} from '../chat-service.mjs';
import {writeAccountSession} from '@cpclaw/desktop-host/account-session';

test('三个对话可以同时回复，第四个和同一对话的重复发送被拒绝',async t=>{
  const root=mkdtempSync('/tmp/cpclaw-chat-parallel-'),actor='parallel-user',release=[];
  writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh'},{makeCurrent:true});
  writeFileSync(join(root,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh',accessToken:'fixture-access'});
    if(url.endsWith('/v1/me/model-access'))return Response.json({schemaVersion:1,mode:'mock',model:'MiniMax-M3',limitTokens:100000000});
    if(url.endsWith('/v1/market'))return Response.json({connectors:[],items:[]});
    throw Error('Unexpected route '+url);
  });
  const service=createChatService(root,()=>{},{runServiceLoop:()=>new Promise(resolve=>release.push(()=>resolve({finalResponse:'并行完成'})))});
  try{
    const ids=[];
    for(const name of ['一','二','三','四'])ids.push((await service.dispatch('chat.create',actor,{title:name})).chatId);
    const running=ids.slice(0,3).map((chatId,index)=>service.dispatch('chat.send',actor,{chatId,requestId:'run-'+index,text:'同时处理'}));
    const deadline=Date.now()+5000;while(release.length<3&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(release.length,3);
    assert.equal((await service.dispatch('chat.send',actor,{chatId:ids[3],requestId:'run-4',text:'超出'})).code,'SLOT_BUSY');
    assert.equal((await service.dispatch('chat.send',actor,{chatId:ids[0],requestId:'run-same',text:'重复'})).code,'SLOT_BUSY');
    assert.equal((await service.dispatch('chat.configure',actor,{chatId:ids[3],mode:'chat',service:''})).ok,true);
    for(const done of release)done();
    const finished=await Promise.all(running);
    assert.equal(finished.every(item=>item.state==='done'),true);
    assert.equal((await service.dispatch('chat.history',actor,{chatId:ids[3]})).messages.length,0);
  }finally{service.stop();rmSync(root,{recursive:true,force:true});}
});

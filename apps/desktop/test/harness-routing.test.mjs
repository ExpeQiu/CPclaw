import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createChatService} from '../chat-service.mjs';
import {writeAccountSession} from '@cpclaw/desktop-host/account-session';

test('one Harness loop chooses the local tool by default and can route to another discovered service',async t=>{
 const root=mkdtempSync('/tmp/cpclaw-harness-routing-'),actor='routing-user',calls=[];
 writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token'},{makeCurrent:true});
 writeFileSync(join(root,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
 t.mock.method(globalThis,'fetch',async url=>{
  if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token',accessToken:'fixture-access'});
  if(url.endsWith('/v1/market'))return Response.json({connectors:[],items:[]});
  if(url.endsWith('/v1/chat/stream'))return new Response(JSON.stringify({event:'service_request',request:{serviceId:''}})+'\n'+JSON.stringify({event:'done'})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  throw Error('Unexpected route');
 });
 let loops=0;
 const service=createChatService(root,()=>{},{executeService:async context=>{calls.push(context);return {ok:true,output:'real host fixture'};},runServiceLoop:async input=>{
  loops++;assert.match(input.service.context,/自主选择服务/);assert.match(input.service.context,/local-terminal/);
  await input.service.execute(JSON.stringify({action:'discover'}));
  await input.service.execute(JSON.stringify({action:'terminal',command:'pwd'}));
  await input.service.execute(JSON.stringify({serviceId:'dreamina',action:'discover'}));
  const denied=JSON.parse(await input.service.execute(JSON.stringify({serviceId:'unknown-service',action:'discover'})));assert.equal(denied.ok,false);
  return {finalResponse:'已完成真实工具检查'};
 }});
 try{
  const {chatId}=await service.dispatch('chat.create',actor,{});
  const result=await service.dispatch('chat.send',actor,{chatId,requestId:'routing-test',text:'检查当前环境，然后检查即梦'});
  assert.equal(result.state,'done');assert.equal(loops,1);assert.deepEqual(calls.map(c=>c.service.id),['local-terminal','local-terminal','dreamina']);
  assert(calls.every(c=>c.actorId===actor&&c.chatId===chatId&&c.taskId&&c.workingDirectory));
  const history=await service.dispatch('chat.history',actor,{chatId});assert.deepEqual(history.serviceSteps.map(s=>s.service.id),['local-terminal','local-terminal','dreamina']);
 }finally{service.stop();rmSync(root,{recursive:true,force:true});}
});

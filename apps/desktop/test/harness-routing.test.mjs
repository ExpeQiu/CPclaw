import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createChatService} from '../chat-service.mjs';
import {writeAccountSession} from '@cpclaw/desktop-host/account-session';

for(const warning of [null,{code:'HARNESS_CLEANUP_UNKNOWN',message:'fixture'}]) test(`Harness routing preserves answers with cleanup warning=${Boolean(warning)}`,async t=>{
 const root=mkdtempSync('/tmp/cpclaw-harness-routing-'),actor='routing-user',calls=[];
 writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token'},{makeCurrent:true});
 writeFileSync(join(root,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
 t.mock.method(globalThis,'fetch',async url=>{
  if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token',accessToken:'fixture-access'});
  if(url.endsWith('/v1/me/model-access'))return Response.json({schemaVersion:1,mode:'mock',model:'MiniMax-M3',limitTokens:100000000});
  if(url.endsWith('/v1/market'))return Response.json({connectors:[],items:[]});
  if(url.endsWith('/v1/chat/stream'))return new Response(JSON.stringify({event:'service_request',request:{serviceId:''}})+'\n'+JSON.stringify({event:'done'})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  throw Error('Unexpected route');
 });
 let loops=0;
 const service=createChatService(root,()=>{},{executeService:async context=>{calls.push(context);return {ok:true,output:'real host fixture'};},runServiceLoop:async input=>{
  loops++;assert(input.pipeline);input.onAccepted('accepted');
  for(const [index,serviceId] of ['local-terminal','local-terminal','dreamina'].entries())await input.pipeline.execute({name:index===1?'terminal':'discover_service',arguments:index===1?{command:'pwd'}:{serviceId},callId:'route-'+index});
  const denied=await input.pipeline.execute({name:'discover_service',arguments:{serviceId:'unknown-service'},callId:'denied'});assert.equal(denied.ok,false);
  return {finalResponse:'已完成真实工具检查',...(warning?{cleanupWarning:warning}:{})};
 }});
 try{
  const {chatId}=await service.dispatch('chat.create',actor,{});
  const result=await service.dispatch('chat.send',actor,{chatId,requestId:'routing-test',text:'检查当前环境，然后检查即梦'});
  assert.equal(result.state,'done');assert.equal(loops,1);assert.deepEqual(calls.map(c=>c.service.id),['local-terminal','local-terminal','dreamina']);
  assert(calls.every(c=>c.actorId===actor&&c.chatId===chatId&&c.taskId&&c.workingDirectory));
  const history=await service.dispatch('chat.history',actor,{chatId});
  const reply=history.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(reply.state,'done');assert.match(reply.content,/已完成真实工具检查/);
  if(warning)assert(history.messages.at(-1).activities.some(a=>a.step==='cleanup'&&a.state==='error'));
  assert.deepEqual(history.serviceSteps.map(s=>s.service.id),['local-terminal','local-terminal','dreamina']);
 }finally{service.stop();rmSync(root,{recursive:true,force:true});}
});

test('chat bindings survive restart, isolate histories and share a project directory',async t=>{
 const root=mkdtempSync('/tmp/cpclaw-session-binding-'),actor='session-user',inputs=[],calls=[];
 writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh'},{makeCurrent:true});
 writeFileSync(join(root,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
 t.mock.method(globalThis,'fetch',async url=>{
  if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh',accessToken:'fixture-access'});
  if(url.endsWith('/v1/me/model-access'))return Response.json({schemaVersion:1,mode:'mock',model:'MiniMax-M3',limitTokens:100000000});
  if(url.endsWith('/v1/market'))return Response.json({connectors:[],items:[]});
  if(url.endsWith('/v1/chat/stream'))return new Response(JSON.stringify({event:'service_request',request:{serviceId:''}})+'\n'+JSON.stringify({event:'done'})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  throw Error('Unexpected route');
 });
 const options={executeService:async context=>{calls.push(context);return {ok:true};},runServiceLoop:async input=>{
  inputs.push(input);input.onAccepted('accepted');await input.pipeline.execute({name:'discover_service',arguments:{serviceId:'local-terminal'},callId:input.parentRequestId});const r=await input.pipeline.execute({name:'list_resources',arguments:{},callId:'resources-'+input.parentRequestId});input.boundResources=r.resources;const k=await input.pipeline.execute({name:'read_resource',arguments:{kind:'knowledge',id:r.resources.knowledge[0].id,path:'shared.md'},callId:'knowledge-'+input.parentRequestId});input.readKnowledge=k.content;return {finalResponse:'binding reply'};
 }};
 let service=createChatService(root,()=>{},options);
 try{
  const {project}=await service.dispatch('project.create',actor,{folder:root});
  assert(project);
  const libraryDir=join(root,'knowledge');mkdirSync(libraryDir);
  writeFileSync(join(libraryDir,'shared.md'),'共享资料：shared-resource-7264');
  const {link}=await service.dispatch('knowledge.link',actor,{scope:'personal',kind:'local',target:libraryDir,name:'共享知识库'});assert(link);
  const a=await service.dispatch('chat.create',actor,{projectId:project.id});
  const b=await service.dispatch('chat.create',actor,{projectId:project.id});
  for(const chat of [a,b])assert.equal((await service.dispatch('knowledge.choose',actor,{chatId:chat.chatId,ids:[link.id]})).ok,true);
  const send=(chatId,text,requestId)=>service.dispatch('chat.send',actor,{chatId,text,requestId});
  assert.equal((await send(a.chatId,'共享资料 only A secret','bind-a1')).state,'done');
  assert.equal((await send(a.chatId,'共享资料 continue A','bind-a2')).state,'done');
  assert.equal(inputs[0].sessionId,inputs[1].sessionId);
  assert.equal(inputs[1].goal,'共享资料 continue A');assert.match(inputs[1].readKnowledge,/shared-resource-7264/);
  assert(!inputs[1].goal.includes('only A secret'));
  assert.equal((await send(b.chatId,'共享资料 only B secret','bind-b1')).state,'done');
  assert.notEqual(inputs[0].sessionId,inputs[2].sessionId);
  assert(!inputs[2].goal.includes('only A secret'));
  assert.match(inputs[2].readKnowledge,/shared-resource-7264/);
  writeFileSync(join(libraryDir,'shared.md'),'共享资料：updated-resource-7264');
  assert.equal((await service.dispatch('knowledge.update',actor,{id:link.id})).ok,true);
  assert(calls.every(c=>c.workingDirectory===realpathSync(root)));
  service.stop();service=createChatService(root,()=>{},options);
  assert.equal((await send(a.chatId,'共享资料 after restart','bind-a3')).state,'done');
  assert.equal(inputs[3].sessionId,inputs[0].sessionId);
  assert.match(inputs[3].readKnowledge,/updated-resource-7264/);
  assert(!inputs[3].goal.includes('only B secret'));
  const foreign=await service.dispatch('chat.send','another-account',{chatId:a.chatId,text:'read',requestId:'foreign'});
  assert.equal(foreign.ok,false);assert.equal(inputs.length,4);
 }finally{service.stop();rmSync(root,{recursive:true,force:true});}
});

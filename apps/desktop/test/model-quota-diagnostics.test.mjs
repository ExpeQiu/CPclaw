import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {writeAccountSession} from '@cpclaw/desktop-host/account-session';
import {createChatService} from '../chat-service.mjs';
import {analyzeChat} from '../chat-diagnostics.mjs';
import {serviceReplaySafe} from '../service-replay.mjs';

const read=args=>({service:{id:'dreamina'},request:{action:'call',args},result:{ok:true}});
test('real 429 after four successful read tools is diagnosed separately from tool failures',()=>{
 const steps=[{service:{id:'dreamina'},request:{action:'discover'},result:{ok:true}},read(['model','list','--type','image']),read(['model','find','5.0pro']),read(['canvas','current'])];
 assert(analyzeChat({content:'已恢复4条回执',state:'error',error:'远程 Harness 网关返回 429'},steps).some(f=>f.code==='HARNESS_RATE_LIMIT'));
 assert.equal(serviceReplaySafe(steps),true);
 assert.equal(serviceReplaySafe([read(['node','run','--node-id','node_test'])]),false);
 assert.equal(serviceReplaySafe([read(['node','create','image'])]),false);
 assert.equal(serviceReplaySafe([read(['resource','download','existing'])]),false);
 assert.equal(serviceReplaySafe([{service:{id:'local-terminal'},request:{action:'terminal',command:'pwd'}}]),false);
});

test('quota exhaustion stops new model work; read-only preparation can resume after quota recovers',async t=>{
 const root=mkdtempSync('/tmp/cpclaw-quota-diag-'),actor='quota-user';
 writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token'},{makeCurrent:true});
 writeFileSync(join(root,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
 let available=10000,loopCalls=0,tools=0;
 t.mock.method(globalThis,'fetch',async url=>{
  if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token',accessToken:'fixture-access'});
  if(url.endsWith('/v1/me/quota'))return Response.json({quota:{model:'MiniMax-M3',limitTokens:2000000,settledKnown:2000000-available,unsettledUnknown:0,openReserved:0,availableTokens:available,concurrentInUse:0,concurrentLimit:1}});
  if(url.endsWith('/v1/market'))return Response.json({connectors:[],items:[]});
  if(url.endsWith('/v1/chat/stream'))return new Response(JSON.stringify({event:'service_request',request:{serviceId:'dreamina'}})+'\n'+JSON.stringify({event:'done'})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  if(url.endsWith('/health'))return Response.json({serviceTypes:['CLI','MCP']});
  throw Error('Unexpected route');
 });
 const service=createChatService(root,()=>{},{executeService:async()=>{tools++;return {ok:true};},runServiceLoop:async input=>{
  loopCalls++;
  await input.service.execute(JSON.stringify({action:'discover'}));
  if(loopCalls===1){available=0;throw Error('远程 Harness 网关返回 429');}
  return {finalResponse:'连接检查已完成'};
 }});
 try{
  const {chatId}=await service.dispatch('chat.create',actor,{});
  const first=await service.dispatch('chat.send',actor,{chatId,requestId:'first',text:'检查即梦连接'});assert.equal(first.state,'error');
  const diagnosis=await service.dispatch('chat.diagnose',actor,{chatId});
  assert(diagnosis.findings.some(f=>f.code==='MODEL_QUOTA_EXHAUSTED'));assert.equal(diagnosis.modelQuota.availableTokens,0);
  assert.equal(diagnosis.task.status,'unknown');assert.equal(diagnosis.safeToRetry,true);
  const blocked=await service.dispatch('chat.send',actor,{chatId,retry:true,requestId:'blocked'});assert.equal(blocked.state,'error');assert.match((await service.dispatch('chat.history',actor,{chatId})).messages.at(-1).error,/模型额度不足/);assert.equal(loopCalls,1);assert.equal(tools,1);
  available=10000;
  const resumed=await service.dispatch('chat.send',actor,{chatId,retry:true,requestId:'resumed'});assert.equal(resumed.state,'done');assert.equal(loopCalls,2);
  const history=await service.dispatch('chat.history',actor,{chatId});assert.equal(history.serviceSteps.length,2);assert.deepEqual(history.serviceSteps.map(s=>s.step),[1,2]);
 }finally{service.stop();rmSync(root,{recursive:true,force:true});}
});

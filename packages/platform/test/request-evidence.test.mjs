import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {openPlatform,listenPlatform,fixtureEmployees} from '../dist/index.js';
import {createChatService} from '../../../apps/desktop/chat-service.mjs';import {writeAccountSession} from '@cpclaw/desktop-host/account-session';import {DatabaseSync} from 'node:sqlite';

test('cloud to desktop failures preserve each attempt, diagnose exact cause and isolate accounts',async()=>{
 const root=mkdtempSync('/tmp/cpclaw-request-evidence-'),cloud=join(root,'cloud'),desktop=join(root,'desktop');
 const upstream=createServer(async(req,res)=>{for await(const _ of req){}res.writeHead(200,{'content-type':'text/event-stream','x-request-id':'supplier-7264'});res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'tool',function:{name:'deliver_document',arguments:'{"content":"private-tool-7264'}}]},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const opened=openPlatform({dataDir:cloud,port:0,listenHost:'127.0.0.1',sessionSecret:'request-evidence-fixture-0123456789',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:true,now:()=>Date.now()});assert(opened.ok);
 const server=await listenPlatform(opened.app,{dataDir:cloud,port:0,aiMockMode:false,reportGateway:{mode:'real',baseUrl:'http://127.0.0.1:'+upstream.address().port,apiKey:'private-key-7264',timeoutMs:2000}});
 const base='http://127.0.0.1:'+server.port,login=opened.app.login({employeeId:'employee-a',password:'fixture-employee-a',deviceLabel:'test'});assert(login.ok);
 writeAccountSession(desktop,{schemaVersion:1,employeeId:'employee-a',sessionId:login.sessionId,refreshToken:login.refreshToken},{makeCurrent:true});writeFileSync(join(desktop,'desktop-connection.json'),JSON.stringify({platformUrl:base}));
 const service=createChatService(desktop,()=>{});
 try{
  const {chatId}=await service.dispatch('chat.create','employee-a',{});
  const send=(id,retry=false)=>service.dispatch('chat.send','employee-a',{chatId,requestId:id,text:'private-prompt-7264',retry});
  assert.equal((await send('evidence-first')).state,'error');
  assert.equal((await send('evidence-retry',true)).ok,false);assert.equal((await send('evidence-followup')).state,'error');
  const db=new DatabaseSync(join(desktop,'chat.sqlite'),{readOnly:true}),rows=db.prepare('SELECT body FROM chat_request_evidence ORDER BY updated').all().map(r=>JSON.parse(r.body));db.close();
  assert.equal(rows.length,2);assert.equal(rows[0].code,'MODEL_OUTPUT_LIMIT');assert.equal(rows[1].retryOf,'');assert.notEqual(rows[0].traceId,rows[1].traceId);assert.equal(rows[1].diagnostic.finishReason,'length');assert(!JSON.stringify(rows).includes('private-tool'));assert(!JSON.stringify(rows).includes('private-prompt'));
  const report=await service.dispatch('chat.diagnose','employee-a',{chatId});assert(report.ok);assert(report.findings.some(f=>f.code==='MODEL_OUTPUT_LIMIT'&&f.detail.includes('长度上限')));
  const duplicate=await send('evidence-first');assert.equal(duplicate.code,'CONFLICT');
  const nativeId=rows[0].modelCalls.find(r=>r.requestId.startsWith('loop-')).requestId;
  const own=await fetch(base+'/v1/me/request-traces/'+nativeId,{headers:{authorization:'Bearer '+login.accessToken}});assert.equal(own.status,200);const evidence=(await own.json()).evidence;assert.equal(evidence.diagnostic.code,'MODEL_OUTPUT_LIMIT');assert.equal(evidence.diagnostic.providerRequestId,'supplier-7264');
  const other=opened.app.login({employeeId:'employee-b',password:'fixture-employee-b',deviceLabel:'test'});assert(other.ok);
  assert.equal((await fetch(base+'/v1/me/request-traces/'+nativeId,{headers:{authorization:'Bearer '+other.accessToken}})).status,404);
  const log=readFileSync(join(cloud,'logs/platform.log'),'utf8');assert(!log.includes('private-tool'));assert(!log.includes('private-key'));assert(!log.includes('private-prompt'));
 }finally{service.stop();await server.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(root,{recursive:true,force:true});}
});

test('cloud evidence survives store reopen and marks requests left running as interrupted',async()=>{
 const {requestTraces}=await import('../dist/request-traces.js');const root=mkdtempSync('/tmp/cpclaw-cloud-evidence-restart-');let store;
 try{store=requestTraces(root);store.save('a','request-a',{requestId:'request-a',state:'running',stage:'model_stream'});store.save('b','request-b',{requestId:'request-b',state:'done'});store.close();store=requestTraces(root);assert.equal(store.read('a','request-a').code,'PLATFORM_PROCESS_INTERRUPTED');assert.equal(store.read('a','request-a').stage,'model_stream');assert.equal(store.read('b','request-b').state,'done');assert.equal(store.read('b','request-a'),undefined);}finally{store?.close();rmSync(root,{recursive:true,force:true});}
});

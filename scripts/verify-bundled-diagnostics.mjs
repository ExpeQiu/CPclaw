// Actual packaged services; deterministic local model fault, no external model calls.
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const bundle=process.argv[2];if(!bundle)throw Error('需要 CPclaw.app 路径');
const app=join(bundle,'Contents/Resources/app');
const {openPlatform,listenPlatform,fixtureEmployees}=await import(pathToFileURL(join(app,'node_modules/@cpclaw/platform/dist/index.js')));
const {createChatService}=await import(pathToFileURL(join(app,'chat-service.mjs')));const {writeAccountSession}=await import(pathToFileURL(join(app,'node_modules/@cpclaw/desktop-host/dist/account-session.js')));import {DatabaseSync} from 'node:sqlite';

async function verify(){
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
  assert.equal((await send('evidence-retry',true)).state,'error');
  const db=new DatabaseSync(join(desktop,'chat.sqlite'),{readOnly:true}),rows=db.prepare('SELECT body FROM chat_request_evidence ORDER BY updated').all().map(r=>JSON.parse(r.body));db.close();
  assert.equal(rows.length,2);assert.equal(rows[0].code,'MODEL_OUTPUT_LIMIT');assert.equal(rows[1].retryOf,'evidence-first');assert.equal(rows[0].traceId,rows[1].traceId);assert.equal(rows[1].diagnostic.finishReason,'length');assert(!JSON.stringify(rows).includes('private-tool'));assert(!JSON.stringify(rows).includes('private-prompt'));
  const report=await service.dispatch('chat.diagnose','employee-a',{chatId});assert(report.ok);assert(report.findings.some(f=>f.code==='MODEL_OUTPUT_LIMIT'&&f.detail.includes('长度上限')));
  const replay=await fetch(base+'/v1/chat/stream',{method:'POST',headers:{authorization:'Bearer '+login.accessToken,'content-type':'application/json'},body:JSON.stringify({requestId:'evidence-first',messages:[{role:'user',content:'replay'}]})});assert.equal(replay.status,409);
  const own=await fetch(base+'/v1/me/request-traces/evidence-first',{headers:{authorization:'Bearer '+login.accessToken}});assert.equal(own.status,200);const evidence=(await own.json()).evidence;assert.equal(evidence.diagnostic.code,'MODEL_OUTPUT_LIMIT');assert.equal(evidence.diagnostic.providerRequestId,'supplier-7264');
  const other=opened.app.login({employeeId:'employee-b',password:'fixture-employee-b',deviceLabel:'test'});assert(other.ok);
  assert.equal((await fetch(base+'/v1/me/request-traces/evidence-first',{headers:{authorization:'Bearer '+other.accessToken}})).status,404);
  const log=readFileSync(join(cloud,'logs/platform.log'),'utf8');assert(!log.includes('private-tool'));assert(!log.includes('private-key'));assert(!log.includes('private-prompt'));
 }finally{service.stop();await server.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(root,{recursive:true,force:true});}
}
await verify();console.log(JSON.stringify({packaged:true,model:'local-fixture',diagnosticRootCause:true,retryEvidencePreserved:true,cloudAccountIsolation:true,noPromptOrToolBodyInEvidence:true}));

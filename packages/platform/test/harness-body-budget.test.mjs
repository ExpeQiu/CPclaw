import {test} from 'node:test';import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';
import {openPlatform,listenPlatform,fixtureEmployees} from '../dist/index.js';
async function fixture(limit){
 const dataDir=mkdtempSync('/tmp/cpclaw-body-budget-');let calls=0,lastContent='';
 const upstream=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));calls++;lastContent=body.messages[0].content;res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'完成'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})+'\n\ndata: [DONE]\n\n');});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'body-budget-fixture-secret-12345',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:true,now:()=>Date.now()});assert(opened.ok);
 const server=await listenPlatform(opened.app,{dataDir,port:0,harnessMaxBodyBytes:limit,aiMockMode:false,reportGateway:{mode:'real',baseUrl:'http://127.0.0.1:'+upstream.address().port,apiKey:'fixture',timeoutMs:3000}});
 const login=opened.app.login({employeeId:'employee-a',password:'fixture-employee-a',deviceLabel:'body-budget'});
 return {get calls(){return calls;},get lastContent(){return lastContent;},base:'http://127.0.0.1:'+server.port,headers:{authorization:'Bearer '+login.accessToken,'content-type':'application/json','x-cpclaw-pipeline':'v1'},close:async()=>{await server.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(dataDir,{recursive:true,force:true});}};
}
const body=content=>JSON.stringify({model:'MiniMax-M3',messages:[{role:'user',content}],tools:[{type:'function',function:{name:'list_resources',parameters:{type:'object',properties:{}}}}]});
test('default Harness budget transmits UTF-8 context larger than 256KiB without dropping content',async()=>{
 const f=await fixture();try{const content='资料'.repeat(70000),raw=body(content);assert(Buffer.byteLength(raw)>262144);const r=await fetch(f.base+'/v1/harness/completions',{method:'POST',headers:{...f.headers,'x-request-id':'large-context'},body:raw});assert.equal(r.status,200);assert((await r.text()).includes('完成'));assert.equal(f.lastContent,content);assert.equal(f.calls,1);}finally{await f.close();}
});
test('non-harness routes still cap at 16KiB and return 413 after the body finishes',async()=>{
 const f=await fixture(262144);try{
  const raw='{"pad":"'+ 'x'.repeat(20000) +'"}';
  const response=await new Promise((resolve,reject)=>{const req=request(f.base+'/v1/not-a-route',{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw)}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(raw);});
  assert.equal(response.status,413);assert.equal(response.body.code,'REQUEST_BODY_TOO_LARGE');assert.equal(response.body.diagnostic.requestLimitBytes,16384);assert(response.body.diagnostic.requestBytes>16384);assert.equal(f.calls,0);
 }finally{await f.close();}
});
test('oversized chunked upload returns readable 413 and does not call a model; server accepts next request',async()=>{
 const f=await fixture(262144);try{
  const raw=body('x'.repeat(300000));const response=await new Promise((resolve,reject)=>{const req=request(f.base+'/v1/harness/completions',{method:'POST',headers:{...f.headers,'x-request-id':'too-large'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);for(let i=0;i<raw.length;i+=16000)req.write(raw.slice(i,i+16000));req.end();});
  assert.equal(response.status,413);assert.equal(response.body.code,'REQUEST_BODY_TOO_LARGE');assert.equal(response.body.diagnostic.requestLimitBytes,262144);assert(response.body.diagnostic.requestBytes>262144);assert.equal(f.calls,0);
  const next=await fetch(f.base+'/v1/harness/completions',{method:'POST',headers:{...f.headers,'x-request-id':'after-rejection'},body:body('continue')});assert.equal(next.status,200);await next.text();assert.equal(f.calls,1);
 }finally{await f.close();}
});

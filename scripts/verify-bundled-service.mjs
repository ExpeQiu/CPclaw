// 包内真实 Node + worker RPC + Harness + CLI；模型只用本地确定性夹具，无真实平台或积分消费。
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const bundle=resolve(process.argv[2]),resources=join(bundle,'Contents/Resources'),desktop=join(resources,'app');
if(!process.argv.includes('--child')){
 const home=mkdtempSync('/tmp/cpclaw-packaged-service-');
 const result=spawnSync(join(resources,'runtime/bin/node'),[import.meta.filename,bundle,'--child'],{cwd:home,env:{HOME:home,PATH:'/usr/bin:/bin',TMPDIR:'/tmp',CPCLAW_NODE_BINARY:join(resources,'runtime/bin/node')},encoding:'utf8',timeout:120000});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');if(result.error)throw result.error;process.exit(result.status??1);
}
const {openPlatform,listenPlatform,fixtureEmployees}=await import(pathToFileURL(join(desktop,'node_modules/@cpclaw/platform/dist/index.js')));
const {createWorkspaceClient}=await import(pathToFileURL(join(desktop,'workspace-client.mjs')));
const {createServiceRuntime}=await import(pathToFileURL(join(desktop,'service-runtime.mjs')));
let serviceId='',modelCalls=0,approvals=0,toolCalls=0,expectedChat='';
const upstream=createServer(async(req,res)=>{
 try{
 let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);modelCalls++;
 const initial=body.tools.some(t=>t.function.name==='request_service');
 const prior=body.messages.filter(m=>m.role==='tool').length;
 let call;
 if(initial)call={name:'request_service',arguments:JSON.stringify({serviceId,purpose:'验证已配置 CLI 的版本'})};
 else if(prior<2)call={name:'service_action',arguments:JSON.stringify({request:JSON.stringify(prior===0?{action:'discover'}:{action:'call',args:['--version'],purpose:'读取程序版本'})})};
 else {assert(JSON.stringify(body.messages).includes('v22.23.3'));}
 const chunk=(delta,finish_reason)=>'data: '+JSON.stringify({id:'fixture-'+modelCalls,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
 res.writeHead(200,{'content-type':'text/event-stream'});res.write(chunk(call?{role:'assistant',tool_calls:[{index:0,id:'call-'+modelCalls,type:'function',function:call}]}:{role:'assistant',content:'已读取所选 CLI 的真实版本 v22.23.3。'},null));res.end(chunk({},call?'tool_calls':'stop')+'data: [DONE]\n\n');
 }catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const platformData=mkdtempSync('/tmp/cpclaw-package-platform-');
const opened=openPlatform({dataDir:platformData,port:0,listenHost:'127.0.0.1',sessionSecret:'bundled-service-fixture-0123456789abcdef',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:true,now:()=>Date.now()});assert(opened.ok);
const server=await listenPlatform(opened.app,{dataDir:platformData,port:0,aiMockMode:false,reportGateway:{mode:'real',baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:'fixture-no-real-secret',timeoutMs:5000}});
const dataDir=mkdtempSync('/tmp/cpclaw-package-workspace-');
const runtime=createServiceRuntime({dataDir,isCurrent:c=>c.actorId==='employee-a'&&c.chatId===expectedChat,approve:async plan=>{approvals++;assert.match(plan.detail,/当前电脑/);return true;}});
const events=[];const worker=createWorkspaceClient(dataDir,desktop,{onEvent:event=>events.push(event),onService:async(request,signal)=>{toolCalls++;assert.equal(request.service.id,serviceId);return runtime.execute(request,request.request,signal);}});
const call=(method,input={})=>worker.request({method,actorId:'employee-a',input});
try{
 assert((await call('account.login',{platformUrl:`http://127.0.0.1:${server.port}`,employeeId:'employee-a',password:'fixture-employee-a'})).ok);
 const connected=await call('market.call',{action:'connector-save',input:{title:'包内 CLI 验证夹具',type:'CLI',target:process.execPath}});assert(connected.ok);serviceId=connected.connector.id;
 const chat=await call('chat.create');expectedChat=chat.chatId;
 const result=await call('chat.send',{chatId:expectedChat,text:'请调用已配置服务读取程序版本',requestId:'packaged-service-1'});assert.equal(result.state,'done',JSON.stringify(result));
 const history=await call('chat.history',{chatId:expectedChat});assert.match(history.messages.at(-1).content,/v22.23.3/);assert.equal(history.artifacts.length,0);assert.equal(history.serviceSteps.length,2);assert.equal(toolCalls,2);assert.equal(approvals,2);assert.equal(modelCalls,4);assert(events.some(e=>e.type==='service'));
 const other=await worker.request({method:'chat.history',actorId:'employee-b',input:{chatId:expectedChat}});assert.equal(other.ok,false);
 console.log(JSON.stringify({ok:true,naturalRequest:true,workerRPC:true,harnessLoop:true,realLocalCLI:true,model:'local deterministic fixture',modelCalls,toolCalls,approvals,documentFallback:false,accountIsolation:true,externalCalls:false}));
}finally{worker.stop();await server.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}

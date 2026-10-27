import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {createServer} from 'node:http';
import {openPlatform,listenPlatform,fixtureEmployees} from '../dist/index.js';
import {createChatService} from '../../../apps/desktop/chat-service.mjs';
test('natural conversation routes actual SaaS work without a mode switch; ordinary chat and document delivery still work',async()=>{
 let target='',selection=false,modelRequests=[];
 const upstream=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);modelRequests.push(body);
  const prompt=body.messages.at(-1).content;
  const skillRequest=!body.tools;
  const choice=skillRequest?null:prompt.includes('你好')?null:prompt.includes('写文档')?{name:'deliver_document',args:{filename:'结果说明.md',content:'# 测试文档\n明确要求撰写文档。',sourceId:''}}:{name:'request_service',args:{serviceId:selection?'':target,purpose:'查询 SaaS 待办工单'}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{delta:choice?{tool_calls:[{index:0,id:'tool-1',type:'function',function:{name:choice.name,arguments:JSON.stringify(choice.args)}}]}:{content:skillRequest?'# 可复用工作流\n## 输入参数\n任务目标。\n## 步骤\n发现能力并授权后查询。\n## 验收\n核对真实回执。':'你好，我可以帮你操作应用。'},finish_reason:choice?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const dataDir=mkdtempSync('/tmp/cpclaw-mode-platform-'),desktop=mkdtempSync('/tmp/cpclaw-mode-chat-');
 const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'mode-test-session-0123456789abcdef',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:true,now:()=>Date.now()});assert(opened.ok);
 const server=await listenPlatform(opened.app,{dataDir,port:0,aiMockMode:false,reportGateway:{mode:'real',baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:'fixture',timeoutMs:2000}});let local=0,choices=0;const events=[];
 const chat=createChatService(desktop,e=>events.push(e),{executeService:async ({service,request,services})=>{
   if(request.action==='select'){choices++;assert(services.some(s=>s.id===target));return {ok:true,serviceId:target};}
   local++;assert.equal(service.title,'工单系统');assert.equal(request.tool,'tickets_list');return {ok:true,tickets:[{title:'待办工单'}]};
 },runServiceLoop:async options=>{
   assert(options.service.context.includes('网页/SaaS'));assert(!options.service.context.includes('deliver_document'));
   const result=JSON.parse(await options.service.execute(JSON.stringify({action:'call',tool:'tickets_list',arguments:{}})));assert.equal(result.tickets[0].title,'待办工单');return {finalResponse:'已查询工单系统，找到待办工单。'};
 }});
 const call=(method,input={})=>chat.dispatch(method,'employee-a',input);
 try{
  assert((await call('account.login',{platformUrl:`http://127.0.0.1:${server.port}`,employeeId:'employee-a',password:'fixture-employee-a'})).ok);
  const connector=await call('market.call',{action:'connector-save',input:{title:'工单系统',type:'MCP',target:'https://saas.example/mcp'}});assert(connector.ok);target=connector.connector.id;
  const {chatId}=await call('chat.create'),other=await call('chat.create');
  assert.equal((await call('chat.configure',{chatId,mode:'chat',service:'missing'})).ok,false);
  const result=await call('chat.send',{chatId,requestId:'saas-1',text:'去工单系统查询待办工单'});assert.equal(result.state,'done');assert.equal(local,1);assert.equal(choices,0);
  const h=await call('chat.history',{chatId});assert.equal(h.execution.service,target);assert.equal(h.artifacts.length,0);assert.equal(h.serviceSteps.length,1);assert.match(h.messages.at(-1).content,/已查询/);assert(events.some(e=>e.type==='service'));assert(!events.some(e=>e.artifact));assert(!modelRequests[0].messages[0].content.includes('需要选择模式'));
  assert.equal(h.messages.at(-1).hasServiceSteps,1);
  const messageId=h.messages.at(-1).id;
  const process=await call('document.create',{chatId,messageId,kind:'process'});assert(process.ok);assert.equal(process.artifact.name,'创作过程.md');
  const processDoc=await call('document.read',{id:process.artifact.id});assert.match(processDoc.artifact.body,/tickets_list/);assert.match(processDoc.artifact.body,/待办工单/);
  assert.equal((await call('chat.distill-skill',{chatId,messageId})).ok,false,'单轮不提供提炼 Skill');
  const liked=await call('chat.feedback',{chatId,messageId,liked:true});assert.equal(liked.liked,true);
  assert.equal((await call('chat.history',{chatId})).messages.find(m=>m.id===messageId).liked,true);
  await call('chat.send',{chatId,requestId:'chat-2',text:'你好'});assert.equal(local,1,'普通对话不能因为已绑定服务就强制执行');
  const distilled=await call('chat.distill-skill',{chatId,messageId});assert(distilled.ok,JSON.stringify(distilled));
  const snapshot=await call('market.call',{action:'list'}),skill=snapshot.items.find(s=>s.id===distilled.skillId);assert.equal(skill.status,'draft');assert.equal(skill.source,'ai');assert.match(skill.body,/disable-model-invocation: true/);assert.match(skill.body,/version: "1.0.0"/);assert(!snapshot.installs.some(i=>i.id===skill.id));
  const callsBefore=modelRequests.length,reused=await call('chat.distill-skill',{chatId,messageId});assert.equal(reused.skillId,skill.id);assert.equal(modelRequests.length,callsBefore);
  assert.equal((await chat.dispatch('chat.distill-skill','employee-b',{chatId,messageId})).ok,false);
  assert.equal((await call('chat.history',{chatId:other.chatId})).execution.service,'');
  await call('chat.send',{chatId:other.chatId,requestId:'same-goal-skill',text:'去工单系统查询待办工单'});
  await call('chat.send',{chatId:other.chatId,requestId:'same-goal-followup',text:'再确认一次待办'});
  const sameGoal=await call('chat.history',{chatId:other.chatId});
  const serviceMessage=sameGoal.messages.find(m=>m.role==='assistant'&&m.hasServiceSteps);
  const secondSkill=await call('chat.distill-skill',{chatId:other.chatId,messageId:serviceMessage.id});assert(secondSkill.ok,JSON.stringify(secondSkill));const after=await call('market.call',{action:'list'});assert.notEqual(after.items.find(s=>s.id===secondSkill.skillId).title,skill.title);

  const localBeforeDoc=local;
  const doc=await call('chat.send',{chatId,requestId:'doc-3',text:'请写文档'});assert.equal(doc.state,'done');assert(doc.artifact);assert.equal(local,localBeforeDoc);
  selection=true;const autonomous=await call('chat.send',{chatId:other.chatId,requestId:'choose-4',text:'查询待办工单'});assert.equal(autonomous.state,'done');assert.equal(choices,0,'沿用当前服务，不强制弹窗选择');assert.equal(local,localBeforeDoc+1);
 }finally{chat.stop();await server.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
test('Harness gateway forwards service tool results, rejects arbitrary tools and unauthenticated requests',async()=>{
 const upstream=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);assert.equal(b.tools[0].function.name,'service_action');res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'服务回执已收到'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})+'\n\ndata: [DONE]\n\n');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const dataDir=mkdtempSync('/tmp/cpclaw-mode-gateway-');const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'mode-test-session-0123456789abcdef',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:true,now:()=>Date.now()});assert(opened.ok);const login=opened.app.login({employeeId:'employee-a',password:'fixture-employee-a',deviceLabel:'test'});
 const server=await listenPlatform(opened.app,{dataDir,port:0,aiMockMode:false,reportGateway:{mode:'real',baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:'fixture',timeoutMs:2000}});
 const request=(name,token=login.accessToken)=>fetch(`http://127.0.0.1:${server.port}/v1/harness/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-request-id':crypto.randomUUID()},body:JSON.stringify({model:'MiniMax-M3',messages:[{role:'user',content:'执行服务'}],tools:[{type:'function',function:{name,parameters:{type:'object',properties:{request:{type:'string'}},required:['request']}}}]})});
 try{assert.equal((await request('service_action','bad')).status,401);assert.equal((await request('bash')).status,400);const r=await request('service_action');assert.equal(r.status,200);assert.match(await r.text(),/服务回执已收到/);}finally{await server.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});

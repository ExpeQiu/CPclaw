import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {createServiceRuntime,dreaminaService,publicServices,sanitizeServiceResult} from '../service-runtime.mjs';
const schema=JSON.parse(readFileSync(new URL('./fixtures/dreamina-schema.json',import.meta.url)));
function setup({approve=async()=>true,run,fetcher,readBinary=()=>Buffer.from('fixed'),service={id:'other',title:'测试服务',type:'CLI',target:'/fixed/cli'},isCurrent=()=>true}={}){
 const calls=[],approvals=[],dataDir=mkdtempSync('/tmp/cpclaw-runtime-');
 const runtime=createServiceRuntime({dataDir,binaryPath:x=>x,readBinary,isCurrent,approve:async p=>{approvals.push(p);return approve(p);},run:async(file,args,options)=>{calls.push({file,args,options});return run?run(file,args,options):{stdout:'{"ok":true,"value":"real"}'};},fetcher});
 return {runtime,calls,approvals,context:{actorId:'actor-a',chatId:'chat-a',service},dataDir};
}
const signal=()=>new AbortController().signal;
test('registry includes CLI and SaaS MCP; disabled connectors excluded',()=>{
 assert.deepEqual(publicServices([{id:'x',enabled:true,type:'MCP'},{id:'off',enabled:false,type:'CLI'}]).map(s=>s.id),['dreamina','local-terminal','browser-page','x']);
});
test('denial prevents any child command',async()=>{const f=setup({approve:async()=>false});await assert.rejects(()=>f.runtime.execute(f.context,{action:'discover'},signal()),e=>e.code==='DENIED');assert.equal(f.calls.length,0);});
test('generic CLI uses reviewed argv with shell false, supports non-media operations',async()=>{const f=setup();const result=await f.runtime.execute(f.context,{action:'call',args:['list','--query','x; $(echo injected)'],purpose:'检索 SaaS 任务'},signal());assert.equal(result.value,'real');assert.equal(f.calls[0].options.shell,false);assert.equal(f.calls[0].args[2],'x; $(echo injected)');assert.match(f.approvals[0].detail,/x; \$\(echo injected\)/);});
test('context change while approval open prevents execution',async()=>{let current=true;const f=setup({isCurrent:()=>current,approve:async()=>{current=false;return true;}});await assert.rejects(()=>f.runtime.execute(f.context,{action:'discover'},signal()),/已变化/);assert.equal(f.calls.length,0);});
test('aborting approval prevents execution',async()=>{const c=new AbortController();const f=setup({approve:async()=>{c.abort();return true;}});await assert.rejects(()=>f.runtime.execute(f.context,{action:'discover'},c.signal));assert.equal(f.calls.length,0);});
function jimeng(options={}){return setup({...options,service:dreaminaService,run:async(file,args,opts)=>{
 const a=args.slice(3);if(a[0]==='schema')return {stdout:JSON.stringify({ok:true,data:schema})};
 if(a[0]==='version')return {stdout:'{"ok":true,"data":{"version":"fixture"}}'};
 if(a.join(' ')==='auth status')return {stdout:'{"ok":true,"data":{"loggedIn":true}}'};
 if(a.join(' ')==='auth account')return {stdout:'{"ok":true,"data":{"userId":1}}'};
 if(a.join(' ')==='canvas current')return {stdout:'{"ok":true,"data":{}}'};
 if(a.join(' ').startsWith('node quote'))return {stdout:'{"ok":true,"data":{"totalMaxCredits":8,"confirmable":true,"items":[{"nodeId":"node_test","maxCredits":8}]}}'};
 if(a.join(' ').startsWith('node confirm'))return {stdout:'{"ok":true,"data":{"creditConfirmationToken":"PRIVATE_TOKEN","creditCeiling":8}}'};
 return options.actual?options.actual(a):{stdout:'{"ok":true,"data":{"items":[{"nodeId":"node_test","submitId":"public-id","state":"accepted"}]}}'};
 }});}
const request={action:'call',args:['node','run','--project-id','00000000-0000-4000-8000-000000000001','--node-id','node_test']};
test('Jimeng capability discovery is required and unknown flags rejected',async()=>{const f=jimeng();await assert.rejects(()=>f.runtime.execute(f.context,request,signal()),/先 discover/);await f.runtime.execute(f.context,{action:'discover'},signal());await assert.rejects(()=>f.runtime.execute(f.context,{action:'call',args:['model','list','--guessed','true']},signal()),/未声明该参数/);});
test('model cannot bypass quote approval with run flags or confirm',async()=>{const f=jimeng();await f.runtime.execute(f.context,{action:'discover'},signal());for(const args of [['node','confirm'],['node','create','image','--run'],['node','run','--credit-token','bad']])await assert.rejects(()=>f.runtime.execute(f.context,{action:'call',args},signal()));assert(!f.calls.some(c=>c.args.includes('confirm')));});
test('credit denial never confirms or submits',async()=>{const f=jimeng({approve:async p=>p.title!=='生成积分授权'});await f.runtime.execute(f.context,{action:'discover'},signal());await assert.rejects(()=>f.runtime.execute(f.context,request,signal()),e=>e.code==='DENIED');assert(f.calls.some(c=>c.args.includes('quote')));assert(!f.calls.some(c=>c.args.includes('confirm')||c.args.includes('run')));});
test('approved generation uses live quote, keeps token local, and persists recovery before submission',async()=>{
 const f=jimeng();await f.runtime.execute(f.context,{action:'discover'},signal());const result=await f.runtime.execute(f.context,request,signal());assert.equal(result.ok,true);assert(!JSON.stringify(result).includes('PRIVATE_TOKEN'));assert.match(f.approvals.at(-1).message,/8/);
 const submission=f.calls.find(c=>c.args.includes('--credit-token'));assert.equal(submission.args.at(-1),'PRIVATE_TOKEN');const retry=await f.runtime.execute(f.context,request,signal());assert.equal(retry.requiredAction,'resume');assert.equal(f.calls.filter(c=>c.args[3]==='node'&&c.args[4]==='run').length,1);
});
test('submission failure keeps original identities; no automatic replay',async()=>{const f=jimeng({actual:async()=>{throw Object.assign(Error('timeout'),{killed:true});}});await f.runtime.execute(f.context,{action:'discover'},signal());await assert.rejects(()=>f.runtime.execute(f.context,request,signal()),e=>Boolean(e.recovery?.items?.[0]?.submitId));const result=await f.runtime.execute(f.context,request,signal());assert.equal(result.requiredAction,'resume');assert(result.items[0].submitId);});
test('MCP discovers real tools, sends initialized notification, then calls selected SaaS tool',async()=>{
 const methods=[];const fetcher=async(url,options)=>{const body=JSON.parse(options.body);methods.push(body.method);const results={initialize:{protocolVersion:'2024-11-05',serverInfo:{name:'SaaS fixture'}},'tools/list':{tools:[{name:'tickets_list',inputSchema:{type:'object'}}]},'tools/call':{content:[{type:'text',text:'真实工单结果'}]}};return body.method==='notifications/initialized'?new Response(null,{status:202}):new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:results[body.method]}),{headers:{'content-type':'application/json','mcp-session-id':'session-fixture'}});};
 const f=setup({service:{id:'saas',title:'工单系统',type:'MCP',target:'https://saas.example/mcp'},fetcher});await f.runtime.execute(f.context,{action:'discover'},signal());const result=await f.runtime.execute(f.context,{action:'call',tool:'tickets_list',arguments:{}},signal());assert.match(JSON.stringify(result),/真实工单/);assert.deepEqual(methods,['initialize','notifications/initialized','tools/list','tools/call']);assert.equal(f.approvals.length,2);
});
test('MCP unknown tools are never called',async()=>{const f=setup({service:{id:'saas',type:'MCP',title:'SaaS',target:'https://saas.example/mcp'},fetcher:()=>{throw Error('must not call');}});await assert.rejects(()=>f.runtime.execute(f.context,{action:'call',tool:'invented',arguments:{}},signal()),/先发现/);});
test('service results redact secrets and signed URLs while retaining official canvas identity URLs',()=>{
 const r=sanitizeServiceResult({creditConfirmationToken:'private',access_token:'private',url:'https://media.example/image?signature=private',webUrl:'https://jimeng.jianying.com/canvas?draft_id=public',nested:{password:'private'}});assert(!JSON.stringify(r).includes('private'));assert.match(r.webUrl,/draft_id=public/);
});
test('one task approval covers different terminal commands, then a new task asks again',async()=>{
 const f=setup({approve:async()=>({mode:'task',creditCeiling:0})});f.context.taskId='task-1';
 for(const args of [['list'],['write','draft'],['status'],['download']])await f.runtime.execute(f.context,{action:'call',args},signal());
 assert.equal(f.approvals.length,1);assert.equal(f.calls.length,4);
 await f.runtime.execute({...f.context,taskId:'task-2'},{action:'call',args:['list']},signal());assert.equal(f.approvals.length,2);
});
test('Auto covers subsequent tasks; once always asks again',async()=>{
 for(const mode of ['auto','once']){
  const f=setup({approve:async()=>({mode,creditCeiling:0})});
  for(const taskId of ['task-1','task-1','task-2'])await f.runtime.execute({...f.context,taskId},{action:'call',args:['list']},signal());
  assert.equal(f.approvals.length,mode==='auto'?1:3);
 }
});
test('Auto is isolated by actor, chat, service target and binary fingerprint',async()=>{
 let binary='original';const f=setup({readBinary:()=>Buffer.from(binary),approve:async()=>({mode:'auto',creditCeiling:0})});
 const call=context=>f.runtime.execute(context,{action:'call',args:['list']},signal());
 await call(f.context);await call(f.context);assert.equal(f.approvals.length,1);
 await call({...f.context,actorId:'actor-b'});await call({...f.context,chatId:'chat-b'});
 await call({...f.context,service:{...f.context.service,target:'/changed/cli'}});
 binary='updated';await call(f.context);assert.equal(f.approvals.length,5);
});
test('revoke clears grants and invalidates an outstanding approval',async()=>{
 const f=setup({approve:async()=>({mode:'auto',creditCeiling:0})});
 const call=()=>f.runtime.execute(f.context,{action:'call',args:['list']},signal());
 await call();f.runtime.revoke();assert.deepEqual(f.runtime.status(f.context).grants,[]);await call();assert.equal(f.approvals.length,2);
 const g=setup({approve:async()=>{g.runtime.revoke();return {mode:'auto',creditCeiling:0};}});
 await assert.rejects(()=>g.runtime.execute(g.context,{action:'discover'},signal()),/撤销/);assert.equal(g.calls.length,0);
});
test('task credit ceiling covers discovery, terminal commands and multiple generations cumulatively',async()=>{
 const f=jimeng({approve:async()=>({mode:'task',creditCeiling:16})});f.context.taskId='task-1';
 await f.runtime.execute(f.context,{action:'discover'},signal());
 await f.runtime.execute(f.context,{action:'call',args:['model','list']},signal());
 for(const node of ['node_first','node_second'])await f.runtime.execute(f.context,{...request,args:[...request.args.slice(0,-1),node]},signal());
 assert.equal(f.approvals.length,1);assert.equal(f.runtime.status(f.context).grants[0].reservedCredits,16);
 // Refusing to increase the total ceiling must not submit the third node.
 f.runtime.clear();assert.deepEqual(f.runtime.status(f.context).grants,[]);
});
test('exhausted budget asks to increase the cumulative cap; denial never submits',async()=>{
 let n=0;const f=jimeng({approve:async()=>++n===1?{mode:'auto',creditCeiling:8}:false});f.context.taskId='task-1';
 await f.runtime.execute(f.context,{action:'discover'},signal());await f.runtime.execute(f.context,request,signal());
 await assert.rejects(()=>f.runtime.execute({...f.context,taskId:'task-2'},{...request,args:[...request.args.slice(0,-1),'node_second']},signal()),e=>e.code==='DENIED');
 assert.equal(f.approvals.length,2);assert.equal(f.approvals[1].budgetExceeded,true);assert.equal(f.approvals[1].reservedCredits,8);
 assert.equal(f.calls.filter(c=>c.args[3]==='node'&&c.args[4]==='run').length,1);
});
test('invalid or insufficient credit grant does not run a command',async()=>{
 const f=setup({approve:async()=>({mode:'auto',creditCeiling:-1})});
 await assert.rejects(()=>f.runtime.execute(f.context,{action:'discover'},signal()),e=>e.code==='BUDGET_EXCEEDED');assert.equal(f.calls.length,0);
});
test('MCP task approval covers discovery and subsequent tool calls',async()=>{
 const f=setup({service:{id:'saas',title:'工单系统',type:'MCP',target:'https://saas.example/mcp'},approve:async()=>({mode:'task',creditCeiling:0}),fetcher:async(_url,options)=>{
  const body=JSON.parse(options.body);if(body.method==='notifications/initialized')return new Response(null,{status:202});
  const result=body.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'fixture'}}:body.method==='tools/list'?{tools:[{name:'tickets_write'}]}:{content:[]};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});
 }});f.context.taskId='task-1';
 await f.runtime.execute(f.context,{action:'discover'},signal());
 await f.runtime.execute(f.context,{action:'call',tool:'tickets_write',arguments:{body:'first'}},signal());
 await f.runtime.execute(f.context,{action:'call',tool:'tickets_write',arguments:{body:'second'}},signal());assert.equal(f.approvals.length,1);
});

function scopeFailureFixture({denyRecovery=false}={}) {
 const error={code:'service.10000',class:'auth_required',reason:'oauth_scope_insufficient',requiredAction:'login',retryable:false};
 const notifications=[];
 const f=setup({service:dreaminaService,approve:async p=>denyRecovery&&p.title==='重新授权即梦账号'?false:{mode:'task',creditCeiling:0},run:async(_file,args)=>{
  const a=args.slice(3),path=a.join(' ');
  if(a[0]==='schema')return {stdout:JSON.stringify({ok:true,data:schema})};
  if(a[0]==='version')return {stdout:'{"ok":true,"data":{"version":"1.1.1"}}'};
  if(path==='auth status')return {stdout:'{"ok":true,"data":{"loggedIn":true}}'};
  if(path==='auth account'||path==='canvas current')return {stdout:JSON.stringify({ok:false,error})};
  if(path==='auth login --force')return {stdout:JSON.stringify({ok:true,data:{challenge:{deviceCode:'PRIVATE_CHALLENGE',verificationUri:'https://jimeng.jianying.com/ai-tool/cli-auth',userCode:'PUBLIC_CODE'}}})};
  throw Error('unexpected command '+path);
 }});
 f.context.taskId="scope-recovery-task";
 return {...f,notifications};
}
test('scope failure overrides local login and prevents discover from claiming connected',async()=>{
 const f=scopeFailureFixture();const result=await f.runtime.execute(f.context,{action:'discover'},signal());
 assert.equal(result.ok,false);assert.equal(result.error.reason,'oauth_scope_insufficient');assert.equal(result.requiredAction,'login');
});
test('host offers reviewed reauthorization only for structured scope failure and never repeats an active challenge',async()=>{
 const f=scopeFailureFixture();await f.runtime.execute(f.context,{action:'discover'},signal());
 const result=await f.runtime.execute(f.context,{action:'call',args:['auth','login']},signal());
 assert.equal(result.status,'awaiting_login');assert(!JSON.stringify(result).includes('PRIVATE_CHALLENGE'));
 assert.equal(f.approvals.at(-1).title,'重新授权即梦账号');
 assert(f.calls.some(c=>c.args.slice(3).join(' ')==='auth login --force'));
 await f.runtime.execute(f.context,{action:'call',args:['auth','login']},signal());
 assert.equal(f.calls.filter(c=>c.args.slice(3,5).join(' ')==='auth login').length,1);
});
test('denied reauthorization preserves credential and does not run forced login',async()=>{
 const f=scopeFailureFixture({denyRecovery:true});await f.runtime.execute(f.context,{action:'discover'},signal());
 await assert.rejects(()=>f.runtime.execute(f.context,{action:'call',args:['auth','login']},signal()),e=>e.code==='DENIED');
 assert(!f.calls.some(c=>c.args.includes('--force')));
});

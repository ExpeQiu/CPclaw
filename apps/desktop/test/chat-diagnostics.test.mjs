import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeAccountSession } from '@cpclaw/desktop-host/account-session';
import { createChatService } from '../chat-service.mjs';
import { analyzeChat, analyzeKernel, analyzeSkillHealth, buildTimeline, serviceRecoveryText, compactServiceChatText } from '../chat-diagnostics.mjs';
import { desktopLog, readRecentLogs } from '../desktop-log.mjs';

test('diagnosis repairs real stored evidence, keeps failure, blocks replay and isolates accounts', async t => {
  const root=mkdtempSync('/tmp/cpclaw-diagnostics-'), actor='diagnostic-user';
  writeAccountSession(root,{schemaVersion:1,employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token'},{makeCurrent:true});
  writeFileSync(join(root,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
  let serviceCalls=0,offline=false,holdRefresh=false,releaseRefresh;
  const refreshGate=new Promise(resolve=>{releaseRefresh=resolve;});
  t.mock.method(globalThis,'fetch',async url=>{
    if(offline)throw Error('offline');
    if(holdRefresh&&url.endsWith('/v1/session/refresh'))await refreshGate;
    if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:actor,sessionId:'fixture-session',refreshToken:'fixture-refresh-token',accessToken:'fixture-access'});
    if(url.endsWith('/v1/market'))return Response.json({connectors:[],items:[]});
    if(url.endsWith('/v1/chat/stream'))return new Response(JSON.stringify({event:'service_request',request:{serviceId:'dreamina'}})+'\n'+JSON.stringify({event:'done'})+'\n',{headers:{'content-type':'application/x-ndjson'}});
    throw Error('Unexpected route');
  });
  const service=createChatService(root,()=>{},{
    runServiceLoop:async input=>{await input.service.execute(JSON.stringify({action:'discover'}));throw Error('Harness 子进程未回收');},
    executeService:async()=>{serviceCalls++;return {ok:true};}
  });
  const db=new DatabaseSync(join(root,'chat.sqlite'));
  const call=(method,input={},who=actor)=>service.dispatch(method,who,input);
  try {
    const {chatId}=await call('chat.create');
    const sent=await call('chat.send',{chatId,requestId:'original',text:'检查即梦 CLI 连接'});
    assert.equal(sent.state,'error');assert.equal(serviceCalls,1);
    let history=await call('chat.history',{chatId}), message=history.messages.at(-1);
    assert.match(message.content,/已恢复 1 条应用执行记录/);assert.match(message.content,/右侧「自动工作流」/);assert.doesNotMatch(message.content,/^- 步骤 /m);assert.match(message.error,/Harness 子进程未回收/);
    // Reproduce an empty reply persisted by an older desktop build.
    db.prepare("UPDATE chat_messages SET content='' WHERE id=?").run(message.id);
    db.prepare("INSERT INTO chat_activity VALUES(?,?,?,?)").run(message.id,'stale','遗留步骤','running');
    const report=await call('chat.diagnose',{chatId});
    assert.equal(report.ok,true);assert(report.repairs.every(r=>r.verified));assert.equal(report.repairs.length,2);
    assert(report.findings.some(f=>f.code==='HARNESS_CLEANUP'));
    assert(report.findings.some(f=>f.code==='PLATFORM_SESSION'&&f.status==='ok'));
    assert(report.findings.some(f=>f.code==='KERNEL_OK'||f.code==='KERNEL_UNAVAILABLE'));
    assert(Array.isArray(report.timeline)&&report.timeline.some(t=>t.id==='platform'));
    assert(Array.isArray(report.logs));
    assert(report.kernel&&typeof report.kernel.ready==='boolean');
    assert(Array.isArray(report.repairActions));
    history=await call('chat.history',{chatId});message=history.messages.at(-1);
    assert(message.content.trim());assert.equal(message.state,'error');assert(!message.activities.some(s=>s.state==='running'));
    const again=await call('chat.diagnose',{chatId});assert.equal(again.repairs.length,0);assert(again.repeated.every(r=>r.count===1));
    const retry=await call('chat.send',{chatId,retry:true,requestId:'retry'});
    assert.equal(retry.code,'SERVICE_REPLAY_BLOCKED');assert.equal(serviceCalls,1);
    const other=await call('chat.diagnose',{chatId},'other-user');assert.equal(other.ok,false);assert(!other.findings);
    holdRefresh=true;
    const pending=call('chat.diagnose',{chatId});
    assert.equal((await call('chat.send',{chatId,requestId:'during-diagnosis',text:'查询状态'})).code,'SLOT_BUSY');
    assert.equal((await call('account.logout')).code,'SLOT_BUSY');
    assert.equal((await call('chat.diagnose',{chatId})).code,'SLOT_BUSY');
    releaseRefresh();await pending;holdRefresh=false;
    offline=true;const disconnected=await call('chat.diagnose',{chatId});assert(disconnected.findings.some(f=>f.code==='PLATFORM_SESSION'&&f.status==='error'));
    offline=false;
    await call('chat.send',{chatId,requestId:'next',text:'再次检查连接'});
    const second=await call('chat.history',{chatId});
    assert.equal(second.messages.at(-1).state,'error');
    const recurring=await call('chat.diagnose',{chatId});
    assert.equal(recurring.repeated.find(r=>r.code==='HARNESS_CLEANUP').count,2);
    assert(JSON.parse(db.prepare('SELECT codes FROM chat_diagnostics WHERE message=?').get(message.id).codes).includes('EMPTY_REPLY'));
  } finally {service.stop();db.close();rmSync(root,{recursive:true,force:true});}
});

test('service recovery text stays a chat pointer; historical step lists collapse for display',()=>{
  const steps=[{step:1,service:{title:'即梦画布'},result:{ok:true}},{step:2,service:{title:'即梦画布'},result:{ok:false}}];
  const text=serviceRecoveryText(steps);
  assert.match(text,/已恢复 2 条应用执行记录（1 条明确返回失败）/);
  assert.match(text,/右侧「自动工作流」/);
  assert.doesNotMatch(text,/^- 步骤 /m);
  const legacy='本轮回复未完成，已恢复 2 条应用执行记录（1 条明确返回失败）。\n\n- 步骤 1 · 即梦画布：已收到回执，任务终态仍需核实\n- 步骤 2 · 即梦画布：操作未完成\n\n请在应用操作面板核对回执；继续对话时先查询已有任务状态，避免重复提交。';
  const compact=compactServiceChatText(legacy);
  assert.match(compact,/右侧「自动工作流」/);
  assert.doesNotMatch(compact,/^- 步骤 /m);
  assert.equal(serviceRecoveryText([]),'');
});

test('no matching project material is informational; cancelled and empty replies are diagnosed',()=>{
  const result=analyzeChat({content:'已回复',state:'done',retrievalStatus:'no-match'});
  assert.equal(result.find(f=>f.code==='SEARCH_NO_MATCH').status,'info');
  assert(!result.some(f=>f.status==='error'));
  const empty=analyzeChat({content:'',state:'cancelled',error:'已停止生成'});
  assert(empty.some(f=>f.code==='EMPTY_REPLY'));assert(empty.some(f=>f.code==='REPLY_INCOMPLETE'));
  assert.equal(analyzeChat(null)[0].code,'NO_REPLY');
});

test('real incident pattern: nested scope denial is diagnosed even when old discover reported success',()=>{
  const scope={ok:false,error:{code:'service.10000',reason:'oauth_scope_insufficient',requiredAction:'login',requestId:'incident-request'}};
  const steps=[{step:1,service:{id:'dreamina',title:'即梦画布'},request:{action:'discover'},result:{ok:true,auth:{ok:true,data:{loggedIn:true}},account:scope,current:scope}}];
  const report=analyzeChat({content:'',state:'error',error:'Harness 子进程未回收'},steps);
  assert(report.some(f=>f.code==='DREAMINA_AUTH_SCOPE'&&f.status==='error'));
  assert(report.find(f=>f.code==='DREAMINA_AUTH_SCOPE').detail.includes('重新授权'));
});

test('kernel skill timeline and log helpers',()=>{
  const ready=analyzeKernel({ok:true,name:'deepseek-harness',ready:true,source:'bundle',version:'0.1.6'});
  assert.equal(ready.finding.code,'KERNEL_OK');
  const down=analyzeKernel({ok:true,name:'未配置',ready:false,source:'none',version:''});
  assert.equal(down.finding.code,'KERNEL_UNAVAILABLE');
  const skill=analyzeSkillHealth({id:'skill-a',title:'示例',version:'1.0.0',resources:[{storageSkill:'skill-a',version:'1.0.0'}]},[{storageSkill:'skill-a',ok:false,message:'缺少 SKILL.md',code:'DIGEST'}],null);
  assert(skill.findings.some(f=>f.code==='SKILL_INSTALL_MISSING'));
  assert(skill.repairActions.some(a=>a.code==='SKILL_INSTALL_MISSING'&&a.runnable));
  const stale=analyzeSkillHealth({id:'skill-a',account:'other',title:'示例',resources:[]},[{ok:false,code:'ACCOUNT_MISMATCH',message:'绑定账号与当前不一致'}],null);
  assert(stale.findings.some(f=>f.code==='SKILL_BINDING_STALE'));
  const timeline=buildTimeline({
    accountOk:true,
    platformFinding:{status:'ok',detail:'平台正常'},
    kernelSegment:ready.segment,
    message:{state:'done',error:'',retrievalStatus:'ok',activities:[{step:'model',label:'模型',state:'done'}]},
    records:[{step:1,result:{ok:true}}],
    skillSegment:skill.segment,
    hasArtifact:true,
  });
  assert(timeline.some(t=>t.id==='kernel'&&t.status==='ok'));
  assert(timeline.some(t=>t.id==='tools'));
  const root=mkdtempSync('/tmp/cpclaw-diag-log-');
  mkdirSync(join(root,'logs'),{recursive:true});
  desktopLog(root,'cpclaw-desktop-worker','info','chat_diagnosed','自诊断完成',{chatId:'chat-1',issues:0});
  const logs=readRecentLogs(root,{chatId:'chat-1',limit:10});
  assert(logs.some(l=>l.event==='chat_diagnosed'));
  rmSync(root,{recursive:true,force:true});
});

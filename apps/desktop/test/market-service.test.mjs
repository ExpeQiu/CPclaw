import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openPlatform,fixtureEmployees} from '@cpclaw/platform';
import {writeAccountSession} from '@cpclaw/desktop-host/account-session';
import {createChatService} from '../chat-service.mjs';
const baseDraft={title:'固定方法',kind:'skill',description:'核对后列出结论与来源',body:'# 固定旧版方法\n必须核对材料。',source:'manual',version:'1.0.0',members:[],sections:['结论','来源'],examples:[{title:'合成',input:'样本',output:'示例'}]};
function setup(t,options={}){
 const platformDir=mkdtempSync('/tmp/cpclaw-market-desktop-platform-'),desktopDir=mkdtempSync('/tmp/cpclaw-market-desktop-'),otherDir=mkdtempSync('/tmp/cpclaw-market-desktop-other-');
 const opened=openPlatform({dataDir:platformDir,port:0,listenHost:'127.0.0.1',sessionSecret:'desktop-market-fixture-0123456789',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()});assert.ok(opened.ok);const app=opened.app,tokens={};
 for(const id of ['employee-a','admin']){const login=app.login({employeeId:id,password:'fixture-'+id,deviceLabel:'desktop-market'});tokens[id]=login.accessToken;}
 for(const dir of [desktopDir,otherDir]){writeAccountSession(dir,{schemaVersion:1,employeeId:'employee-a',sessionId:'fixture-session',refreshToken:'fixture-refresh'},{makeCurrent:true});writeFileSync(join(dir,'desktop-connection.json'),JSON.stringify({platformUrl:'https://market-fixture.invalid'}));}
 const modelRequests=[];let route='text',target='';
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:'employee-a',sessionId:'fixture-session',refreshToken:'fixture-refresh',accessToken:tokens['employee-a']});
  if(url.endsWith('/v1/market')){const {action,input={}}=JSON.parse(init.body);return Response.json(app.market(tokens['employee-a'],action,input));}
  if(url.endsWith('/v1/chat/stream')){const body=JSON.parse(init.body);modelRequests.push(body);const events=[{event:'start',mode:'mock'}];if(route==='service')events.push({event:'service_request',request:{serviceId:target,purpose:'受控测试'}});else if(route==='document')events.push({event:'document',document:{filename:'核对报告.md',sourceId:'',content:'## 结论\n已核对\n## 来源\n明确材料'}});else events.push({event:'delta',text:'## 结论\n已核对\n## 来源\n明确材料'});events.push({event:'done'});return new Response(events.map(e=>JSON.stringify(e)).join('\n')+'\n',{headers:{'content-type':'application/x-ndjson'}});}
  throw Error('未知测试请求 '+url);
 });
 const service=createChatService(desktopDir,()=>{},options),other=createChatService(otherDir,()=>{},options);
 const call=(method,input={})=>service.dispatch(method,'employee-a',input);
 const market=(who,action,input={})=>app.market(tokens[who],action,input);
 const save=(input={})=>{const r=market('employee-a','save',{...baseDraft,...input});assert.ok(r.ok,r.message);return r.item;};
 const publish=x=>{assert.ok(market('employee-a','submit',{id:x.id}).ok);assert.ok(market('admin','review',{id:x.id,decision:'approve'}).ok);};
 return {service,other,call,market,save,publish,modelRequests,setRoute:(v,id='')=>{route=v;target=id;},close:()=>{service.stop();other.stop();app.close();for(const dir of [platformDir,desktopDir,otherDir])rmSync(dir,{recursive:true,force:true});}};
}

test('安装真实落盘，另一设备不伪报安装；当前对话绑定、结果检查和解除',async t=>{const f=setup(t);try{
 const x=f.save();f.publish(x);const first=await f.call('market.call',{action:'install',input:{id:x.id}});assert.ok(first.ok,first.message);assert.ok((await f.call('market.call',{action:'list'})).localInstalls[0].valid);
 assert.equal((await f.other.dispatch('market.call','employee-a',{action:'list'})).localInstalls.length,0);
 const {chatId}=await f.call('chat.create');assert.ok((await f.call('market.use',{id:x.id,chatId,values:{}})).ok);
 const sent=await f.call('chat.send',{chatId,requestId:'market-bound-text',text:'核对这份材料'});assert.equal(sent.state,'done');assert.equal(sent.skillValidation.status,'passed');assert.equal(sent.skillValidation.mode,'mock');assert.match(f.modelRequests[0].messages.at(-1).content,/# 固定旧版方法/);
 const history=await f.call('chat.history',{chatId});assert.equal(history.skillBinding.id,x.id);assert.equal(history.skillResults.length,1);
 assert.ok((await f.call('market.unbind',{chatId})).ok);assert.equal((await f.call('chat.history',{chatId})).skillBinding,null);assert.equal((await f.call('chat.history',{chatId})).messages.length,2);
 assert.equal((await f.service.dispatch('market.call','employee-b',{action:'list'})).ok,false);
}finally{f.close();}});

test('新版安装不热替换聊天快照；旧版文件与文档交付均可追溯',async t=>{const f=setup(t);try{
 const old=f.save();f.publish(old);await f.call('market.call',{action:'install',input:{id:old.id}});const bound=await f.call('market.use',{id:old.id,values:{}});assert.ok(bound.ok,bound.message);
 const next=f.save({parentId:old.id,version:'1.0.1',body:'# 新版方法\n增加核对'});f.publish(next);assert.ok((await f.call('market.call',{action:'install',input:{id:next.id}})).ok);
 f.setRoute('document');const result=await f.call('chat.send',{chatId:bound.chatId,requestId:'market-doc-old',text:'请写文档'});assert.equal(result.state,'done');assert.ok(result.artifact);assert.equal(result.skillValidation.status,'passed');const prompt=f.modelRequests.at(-1).messages.at(-1).content;assert.match(prompt,/固定旧版方法/);assert.doesNotMatch(prompt,/# 新版方法/);
 assert.equal((await f.call('chat.history',{chatId:bound.chatId})).skillResults[0].snapshot.version,'1.0.0');
 assert.ok((await f.call('market.call',{action:'install',input:{id:old.id}})).ok,'可以切回已获准旧版');
}finally{f.close();}});

test('草稿试用固定修订；上传清单只加载 SKILL.md，缺输入在建聊天前拦截',async t=>{const f=setup(t);try{
 const x=f.save({source:'upload',body:JSON.stringify({files:[{path:'demo/SKILL.md',body:'# 入口方法\n只核对本次材料'},{path:'demo/references/a.md',body:'不能无条件加载的参考正文'}]}),inputs:[{name:'materials',label:'材料',required:true,example:'合成记录'}]});
 const missing=await f.call('market.trial',{id:x.id,values:{}});assert.equal(missing.code,'INPUT_REQUIRED');assert.equal((await f.call('chat.list')).chats.length,0);
 const trial=await f.call('market.trial',{id:x.id,values:{materials:'合成记录'}});assert.ok(trial.ok,trial.message);assert.equal((await f.call('chat.send',{chatId:trial.chatId,requestId:'trial-1',text:'核对'})).state,'done');const prompt=f.modelRequests.at(-1).messages.at(-1).content;assert.match(prompt,/# 入口方法/);assert.doesNotMatch(prompt,/不能无条件加载的参考正文/);
 const trials=await f.call('market.trials',{id:x.id});assert.equal(trials.trials.length,1);assert.equal(trials.trials[0].result.mode,'mock');
 const updated=f.market('employee-a','save',{...x,revision:x.revision,body:JSON.stringify({files:[{path:'SKILL.md',body:'# 改后方法'}]})});assert.ok(updated.ok);
 const stale=await f.call('chat.send',{chatId:trial.chatId,requestId:'trial-stale',text:'继续'});assert.equal(stale.state,'error');assert.match((await f.call('chat.history',{chatId:trial.chatId})).messages.at(-1).error,/修订已改变/);
}finally{f.close();}});

test('服务执行保留技能方法，紧急停用后下一次工具调用被阻断',async t=>{
 let f,calls=0,skill;
 f=setup(t,{executeService:async()=>{calls++;f.market('admin','withdraw',{id:skill.id,note:'测试停用'});return {ok:true};},runServiceLoop:async options=>{assert.match(JSON.parse(options.goal).conversation.at(-1).content,/固定旧版方法/);await options.service.execute(JSON.stringify({action:'discover'}));await assert.rejects(options.service.execute(JSON.stringify({action:'call',args:['--version']})),/不可使用|停用/);return {finalResponse:'## 结论\n后续调用已阻断\n## 来源\n实际回执'};}});
 try{skill=f.save();f.publish(skill);await f.call('market.call',{action:'install',input:{id:skill.id}});const bound=await f.call('market.use',{id:skill.id,values:{}});const c=await f.call('market.call',{action:'connector-save',input:{title:'测试 CLI',type:'CLI',target:process.execPath}});f.setRoute('service',c.connector.id);await f.call('chat.send',{chatId:bound.chatId,requestId:'service-disable',text:'检查服务'});assert.equal(calls,1);}finally{f.close();}
});

test('必需依赖缺失阻断选用，组合卸载保留用户独立安装的成员',async t=>{const f=setup(t);try{
 const x=f.save({dependencies:[{service:'missing-service',title:'未配置工具',required:true,type:'CLI'}]});f.publish(x);await f.call('market.call',{action:'install',input:{id:x.id}});const missing=await f.call('market.use',{id:x.id,values:{}});assert.equal(missing.code,'DEPENDENCY_MISSING');assert.equal((await f.call('chat.list')).chats.length,0);
 const member=f.save({title:'独立成员'});f.publish(member);await f.call('market.call',{action:'install',input:{id:member.id}});
 const expert=f.market('admin','save',{...baseDraft,title:'组合',kind:'expert',members:[member.id]});assert.ok(expert.ok);f.market('admin','submit',{id:expert.item.id});f.market('admin','review',{id:expert.item.id,decision:'approve'});assert.ok((await f.call('market.call',{action:'install',input:{id:expert.item.id}})).ok);
 assert.ok((await f.call('market.call',{action:'uninstall',input:{id:expert.item.id}})).ok);const locals=(await f.call('market.call',{action:'list'})).localInstalls;assert.ok(locals.some(i=>i.release===member.id));assert.ok(!locals.some(i=>i.release===expert.item.id));
}finally{f.close();}});

test('下载中取消安装保留原版，操作记录为取消而非成功或中断',async t=>{const f=setup(t);try{
 const old=f.save();f.publish(old);await f.call('market.call',{action:'install',input:{id:old.id}});const next=f.save({parentId:old.id,version:'1.0.1',body:'# 新版'});f.publish(next);
 const original=globalThis.fetch;let started;const downloadStarted=new Promise(r=>{started=r;});
 t.mock.method(globalThis,'fetch',(url,init)=>{if(url.endsWith('/v1/market')){const request=JSON.parse(init.body);if(request.action==='download'&&request.input.id===next.id){started();return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});}}return original(url,init);});
 const pending=f.call('market.call',{action:'install',input:{id:next.id}});await downloadStarted;assert.ok((await f.call('market.cancel-install',{id:next.id})).ok);const cancelled=await pending;assert.equal(cancelled.code,'INSTALL_CANCELLED');
 const locals=(await f.call('market.call',{action:'list'})).localInstalls;assert.ok(locals.some(i=>i.release===old.id&&i.valid&&i.current));assert.ok(!locals.some(i=>i.release===next.id));assert.ok((await f.call('market.operations')).operations.some(o=>o.release===next.id&&o.state==='cancelled'));
}finally{f.close();}});

test('专家选择具体任务后仅加载所选成员的方法',async t=>{const f=setup(t);try{
 const a=f.save({title:'方案比较',body:'# 比较成员方法'}),b=f.save({title:'报告整理',body:'# 报告成员方法'});f.publish(a);f.publish(b);
 const saved=f.market('admin','save',{...baseDraft,title:'工作助手',kind:'expert',body:'# 专家入口',members:[a.id,b.id],inputs:[{name:'materials',label:'材料',required:true,example:'样本'}]});assert.ok(saved.ok);f.market('admin','submit',{id:saved.item.id});f.market('admin','review',{id:saved.item.id,decision:'approve'});assert.ok((await f.call('market.call',{action:'install',input:{id:saved.item.id}})).ok);
 const use=await f.call('market.use',{id:saved.item.id,taskMember:a.id,values:{materials:'合成材料'}});assert.ok(use.ok,use.message);await f.call('chat.send',{chatId:use.chatId,requestId:'expert-one-task',text:'比较方案'});const prompt=f.modelRequests.at(-1).messages.at(-1).content;assert.match(prompt,/比较成员方法/);assert.doesNotMatch(prompt,/报告成员方法/);assert.equal((await f.call('chat.history',{chatId:use.chatId})).skillBinding.resources.length,2);
}finally{f.close();}});

test('共享提交附带当前修订的宿主试用摘要，Mock 不冒充真实验证',async t=>{const f=setup(t);try{
 const x=f.save();const trial=await f.call('market.trial',{id:x.id,values:{}});await f.call('chat.send',{chatId:trial.chatId,requestId:'trial-evidence',text:'核对'});const submitted=await f.call('market.call',{action:'submit',input:{id:x.id,strict:true}});assert.ok(submitted.ok,submitted.message);
 const detail=f.market('admin','detail',{id:x.id});assert.equal(detail.submissionEvidence.mode,'mock');assert.equal(detail.submissionEvidence.digest,x.digest);assert.equal(detail.submissionEvidence.source,'author-host-report');assert.equal(detail.submissionEvidence.status,'passed');
}finally{f.close();}});

test('技能新聊天继承明确选定的项目，发送时读取真实材料',async t=>{const f=setup(t),folder=mkdtempSync('/tmp/cpclaw-market-material-');try{
 writeFileSync(join(folder,'source.md'),'# 合成试点材料\n10 人参与，8 人完成，失败原因尚未提供。');const project=await f.call('project.create',{folder});assert.ok(project.ok,project.message);
 const x=f.save({inputs:[{name:'materials',label:'材料',required:true,example:'选择项目文件'}]});f.publish(x);await f.call('market.call',{action:'install',input:{id:x.id}});
 const bound=await f.call('market.use',{id:x.id,projectId:project.project.id,values:{materials:'已选择 source.md'}});assert.ok(bound.ok,bound.message);assert.equal((await f.call('chat.list')).chats.find(c=>c.id===bound.chatId).projectId,project.project.id);
 const result=await f.call('chat.send',{chatId:bound.chatId,requestId:'project-skill-material',text:'根据所选材料核对',projectFile:'source.md'});assert.equal(result.state,'done');assert.match(f.modelRequests.at(-1).messages.at(-1).content,/10 人参与，8 人完成/);
}finally{f.close();rmSync(folder,{recursive:true,force:true});}});

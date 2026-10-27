import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {openPlatform,fixtureEmployees} from '../dist/index.js';
import {skillInstruction} from '@cpclaw/contracts';
function fixture(){
 const dataDir=mkdtempSync('/tmp/cpclaw-market-lifecycle-');const config={dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'market-lifecycle-secret-0123456789',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()};
 const opened=openPlatform(config);assert.ok(opened.ok);const app=opened.app;const tokens={};for(const id of ['admin','employee-a','employee-b','employee-c']){const r=app.login({employeeId:id,password:'fixture-'+id,deviceLabel:'lifecycle'});assert.ok(r.ok);tokens[id]=r.accessToken;}
 return {app,dataDir,config,call:(who,action,input={})=>app.market(tokens[who],action,input),tokens,close:()=>{app.close();rmSync(dataDir,{recursive:true,force:true});}};
}
const draft={kind:'skill',title:'材料核对',description:'只据材料回答',body:'# 核对\n说明结论与来源。',source:'manual',version:'1.0.0',members:[],examples:[{title:'合成',input:'记录一',output:'结论一'}]};
function create(f,who='employee-a',input={}){const r=f.call(who,'save',{...draft,...input});assert.ok(r.ok,r.message);return r.item;}
function publish(f,x,who='employee-a'){assert.ok(f.call(who,'submit',{id:x.id,strict:true}).ok);const r=f.call('admin','review',{id:x.id,digest:x.digest,decision:'approve'});assert.ok(r.ok,r.message);}

test('官方内容显式导入、幂等、检查后发布；两个专家锁定具体成员',()=>{const f=fixture();try{
 assert.equal(f.call('employee-a','official-import').ok,false);assert.equal(f.call('employee-a','catalog').total,0);
 const imported=f.call('admin','official-import');assert.ok(imported.ok);assert.equal(imported.imported.length,6);assert.equal(f.call('admin','official-import').imported.length,0);assert.equal(f.call('employee-a','catalog').total,0);
 for(const id of imported.imported){const x=f.call('admin','detail',{id}).item;assert.equal(x.source,'builtin');assert.equal(x.inputs[0].required,true);assert.equal(f.call('admin','validate',{id}).checks.some(c=>c.status==='error'),false);publish(f,x,'admin');}
 const listed=f.call('employee-a','catalog',{q:'汇报材料',source:'builtin'});assert.equal(listed.total,1);assert.equal('body' in listed.items[0],false);assert.ok(f.call('employee-a','detail',{id:listed.items[0].id}).item.body);
 assert.equal(f.call('employee-a','catalog',{excludeSource:'builtin'}).total,0);assert.equal(f.call('employee-c','catalog').total,0);
 const experts=f.call('admin','expert-import');assert.ok(experts.ok);assert.equal(experts.imported.length,2);
 for(const id of experts.imported){const x=f.call('admin','detail',{id}).item;assert.equal(x.members.length,3);publish(f,x,'admin');assert.equal(f.call('employee-a','resolve',{id}).resources.length,4);}
 assert.equal(f.call('admin','expert-import').imported.length,0);
}finally{f.close();}});

test('个人冻结快照、固定审核修订、稳定版本身份及更新差异',()=>{const f=fixture();try{
 const x=create(f);assert.ok(f.call('employee-a','personal',{id:x.id}).ok);assert.ok(f.call('employee-a','install',{id:x.id}).ok);assert.ok(f.call('employee-a','submit',{id:x.id,strict:true}).ok);
 assert.ok(f.call('employee-a','resolve',{id:x.id}).ok,'提交不打断个人快照');assert.equal(f.call('employee-b','detail',{id:x.id}).ok,false);
 assert.equal(f.call('admin','review',{id:x.id,digest:'stale',decision:'approve'}).ok,false);
 assert.ok(f.call('admin','review',{id:x.id,decision:'reject',note:'补充范围'}).ok);assert.ok(f.call('employee-a','resolve',{id:x.id}).ok);
 assert.equal(f.call('employee-a','save',{...draft,id:x.id,revision:1,body:'改写'}).ok,false,'冻结正文不可覆盖');
 const revised=create(f,'employee-a',{parentId:x.id,version:'1.0.1',body:'# 新版\n新方法',changelog:'补充范围'});assert.equal(revised.skillId,x.skillId);publish(f,revised);
 const versions=f.call('employee-a','detail',{id:revised.id}).versions;assert.equal(versions.length,2);assert.equal(versions[0].version,'1.0.1');assert.equal(f.call('employee-b','catalog').items[0].id,revised.id);
 assert.equal(f.call('employee-b','save',{...draft,parentId:x.id,version:'2.0.0'}).ok,false);
 const conflict=create(f,'employee-a',{title:'冲突草稿'});assert.equal(f.call('employee-a','save',{...draft,id:conflict.id,revision:99}).code,'CONFLICT');
}finally{f.close();}});

test('常规下架保留既有使用，紧急停用阻断；通知按组织与员工隔离',()=>{const f=fixture();try{
 const x=create(f);publish(f,x);assert.ok(f.call('employee-b','install',{id:x.id}).ok);assert.ok(f.call('admin','retire',{id:x.id,note:'新用户改用新版'}).ok);
 assert.equal(f.call('employee-b','catalog').total,0);assert.ok(f.call('employee-b','resolve',{id:x.id}).ok);assert.equal(f.call('employee-a','install',{id:x.id}).ok,false);
 assert.ok(f.call('admin','withdraw',{id:x.id,note:'紧急修正'}).ok);assert.equal(f.call('employee-b','resolve',{id:x.id}).ok,false);
 assert.ok(f.call('employee-b','notifications').notifications.some(n=>n.message==='紧急修正'));assert.equal(f.call('employee-c','notifications').notifications.length,0);
 assert.equal(f.call('employee-b','review',{id:x.id,decision:'approve'}).ok,false);
}finally{f.close();}});

test('旧市场与旧企业发布迁移可重入，旧 item ID/安装/冻结内容保留',()=>{const f=fixture();const {dataDir,config}=f;f.app.close();const db=new DatabaseSync(dataDir+'/platform.sqlite');
 const old={id:'old-market',owner:'employee-a',kind:'skill',title:'旧市场技能',description:'旧说明',body:'# 旧方法',version:'1.0.0',source:'manual',origin:'',members:[],status:'withdrawn',note:'旧撤回',updated:1};
 db.prepare('INSERT INTO market_items VALUES(?,?,?,?)').run(old.id,'org-demo',old.owner,JSON.stringify(old));db.prepare('INSERT INTO market_installs VALUES(?,?,?,?)').run('org-demo','employee-a',old.id,1);
 db.prepare('INSERT INTO skills VALUES(?,?,?)').run('enterprise-old','org-demo','旧企业技能');const body='# 已发布内容';db.prepare('INSERT INTO skill_releases(skill_id,version,org_id,content_sha256,platforms,package_body,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run('enterprise-old','1.0.0','org-demo',createHash('sha256').update(body).digest('hex'),'["darwin-arm64"]',body,'published',1);db.close();
 let app;try{for(let pass=0;pass<2;pass++){const opened=openPlatform(config);assert.ok(opened.ok);app=opened.app;const r=app.login({employeeId:'employee-a',password:'fixture-employee-a',deviceLabel:'migration'});const list=app.market(r.accessToken,'list',{});assert.equal(list.items.length,2);assert.ok(list.installs.some(i=>i.id==='old-market'));assert.equal(app.market(r.accessToken,'resolve',{id:'old-market'}).ok,false);const imported=list.items.find(i=>i.skillId==='enterprise-old');assert.equal(imported.body,body);app.close();app=null;}}finally{app?.close();rmSync(dataDir,{recursive:true,force:true});}
});

test('旧企业 API 和新市场共享发布模型，发布后修订产生下一版本',()=>{const f=fixture();try{
 const submitted=f.app.submitSkill(f.tokens['employee-a'],{skillId:'legacy-method',version:'1.0.0',platforms:['darwin-arm64'],packageBody:'# 旧接口正文'});assert.ok(submitted.ok,submitted.message);
 assert.ok(f.app.reviewSkillSubmission(f.tokens.admin,{submissionId:submitted.submissionId,decision:'approve'}).ok);
 const x=f.call('employee-a','catalog').items[0];assert.equal(x.skillId,'legacy-method');const revised=f.app.reviseSkillSubmission(f.tokens['employee-a'],{submissionId:submitted.submissionId,packageBody:'# 新正文',platforms:['darwin-arm64']});assert.ok(revised.ok);assert.equal(f.call('employee-a','detail',{id:x.id}).item.body,'# 旧接口正文');
 const pending=f.call('admin','catalog',{scope:'review'}).items[0];assert.equal(pending.version,'1.0.1');assert.ok(f.call('admin','review',{id:pending.id,decision:'approve'}).ok);assert.equal(f.app.listAvailableSkills(f.tokens['employee-a']).skills.length,2);
}finally{f.close();}});

test('上传的 SKILL.md 入口解析、文件清单和上下文限制不能被绕过',()=>{const f=fixture();try{
 const x=create(f,'employee-a',{source:'upload',body:JSON.stringify({files:[{path:'demo/SKILL.md',body:'# 实际入口\n按材料工作。'},{path:'demo/references/example.md',body:'参考材料'}]})});assert.ok(f.call('employee-a','personal',{id:x.id}).ok);const resolved=f.call('employee-a','resolve',{id:x.id});assert.ok(resolved.ok);assert.equal(skillInstruction(resolved.item),'# 实际入口\n按材料工作。');assert.equal(JSON.parse(resolved.resources[0].packageBody).files.length,2);
 assert.equal(f.call('employee-a','save',{...draft,source:'upload',body:JSON.stringify({files:[{path:'../SKILL.md',body:'bad'}]})}).ok,false);
 const huge=create(f,'employee-a',{title:'超限',body:'字'.repeat(6001)});assert.equal(f.call('employee-a','personal',{id:huge.id}).ok,false);
 const large=create(f,'employee-a',{title:'元数据超限',examples:Array.from({length:10},()=>({title:'合成',input:'a'.repeat(8000),output:'b'.repeat(12000)})),inputs:Array.from({length:20},(_,i)=>({name:'field'+i,label:'参数'+i,required:false,example:'c'.repeat(4000)}))});assert.equal(f.call('employee-a','personal',{id:large.id}).ok,false,'安装前拒绝超限制品');
 const noExample=create(f,'employee-a',{title:'缺示例',examples:[]});assert.equal(f.call('employee-a','submit',{id:noExample.id,strict:true}).ok,false);
}finally{f.close();}});

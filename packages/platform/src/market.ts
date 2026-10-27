import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkSkill, compareSkillVersions, readSkillMetadata, skillFiles, skillInstruction, skillPackage, skillVersionPattern } from '@cpclaw/contracts';
import type { MarketItem } from '@cpclaw/contracts';
import type { PlatformFailure } from './app.js';
import { officialSkills } from './market-content.js';

type Actor = { orgId: string; employeeId: string; role: string };
export type MarketResult = { ok: true; [key: string]: unknown } | PlatformFailure;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const fail=(message:string,code:PlatformFailure['code']='CONFIG_INVALID'):PlatformFailure=>({ok:false,code,message});
const defaults=readSkillMetadata({});
function normalize(value: Partial<MarketItem>): MarketItem {
  const item={...defaults,...value,skillId:value.skillId??value.id??randomUUID(),revision:value.revision??1,personalAvailable:value.personalAvailable??value.status==='personal',featured:value.featured??0} as MarketItem;
  item.digest=value.digest??hash(skillPackage(item));return item;
}
/** 唯一技能领域服务。旧 enterprise API 与市场 API 均经此处写入发布和审核表。 */
export function createMarket(db: DatabaseSync, now: () => number) {
  db.exec(`CREATE TABLE IF NOT EXISTS market_items(id TEXT PRIMARY KEY, org TEXT NOT NULL, owner TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS market_installs(org TEXT NOT NULL, employee TEXT NOT NULL, id TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(org,employee,id));
    CREATE TABLE IF NOT EXISTS market_connectors(id TEXT PRIMARY KEY, org TEXT NOT NULL, employee TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS market_feedback(id TEXT PRIMARY KEY,org TEXT NOT NULL,employee TEXT NOT NULL,item TEXT NOT NULL,kind TEXT NOT NULL,note TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS market_notifications(id TEXT PRIMARY KEY,org TEXT NOT NULL,employee TEXT NOT NULL,item TEXT NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,seen INTEGER NOT NULL DEFAULT 0);`);
  for(const [table,column,definition] of [['skill_releases','release_id','TEXT'],['skill_releases','market_payload','TEXT'],['skill_submissions','item_id','TEXT'],['skill_submissions','market_payload','TEXT']] as const){
    if(!db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(table))throw Error('技能市场需要企业资源 schema');
    if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  const tx=<T>(fn:()=>T):T=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
  const save=(org:string,item:MarketItem)=>db.prepare('INSERT INTO market_items VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(item.id,org,item.owner,JSON.stringify(item));
  const key=(org:string,id:string)=>hash(org).slice(0,16)+':'+id;
  function release(org:string,item:MarketItem,status:string){
    const existing=db.prepare('SELECT * FROM skill_releases WHERE release_id=? AND org_id=?').get(item.id,org);
    const body=skillPackage(item);const digest=hash(body);
    if(existing){if(existing.content_sha256!==item.digest&&existing.content_sha256!==digest)throw Error('不可覆盖已冻结版本，请创建新版本');db.prepare('UPDATE skill_releases SET status=? WHERE release_id=? AND org_id=?').run(status,item.id,org);return;}
    db.prepare('INSERT OR IGNORE INTO skills VALUES(?,?,?)').run(key(org,item.skillId),org,item.title);
    item.digest=digest;
    db.prepare('INSERT INTO skill_releases(skill_id,version,org_id,content_sha256,platforms,package_body,status,created_at,release_id,market_payload) VALUES(?,?,?,?,?,?,?,?,?,?)').run(key(org,item.skillId),item.version,org,digest,JSON.stringify(item.platforms),body,status,now(),item.id,JSON.stringify(item));
  }
  // 增量迁移保留旧 item ID、账号安装及聊天引用；绝不按标题合并资源。
  tx(()=>{
    for(const row of db.prepare('SELECT * FROM market_items').all()){
      const raw=JSON.parse(String(row.payload)) as Partial<MarketItem>,item=normalize(raw);
      if(!raw.skillId){save(String(row.org),item);if(['published','personal','withdrawn'].includes(item.status))release(String(row.org),item,item.status==='withdrawn'?'disabled':item.status);}
    }
    for(const row of db.prepare('SELECT * FROM skill_releases WHERE market_payload IS NULL').all()){
      const id='legacy-'+hash(String(row.org_id)+'\0'+String(row.skill_id)+'\0'+String(row.version)).slice(0,32);
      const sub=db.prepare('SELECT * FROM skill_submissions WHERE skill_id=? AND version=? AND org_id=? ORDER BY created_at DESC LIMIT 1').get(row.skill_id!,row.version!,row.org_id!);
      const def=db.prepare('SELECT title FROM skills WHERE skill_id=? AND org_id=?').get(row.skill_id!,row.org_id!);
      const item=normalize({id,skillId:String(row.skill_id),owner:sub?String(sub.author_id):'platform',title:String(def?.title??row.skill_id),kind:'skill',description:'从企业技能发布记录迁移',body:String(row.package_body),source:'manual',origin:'',version:String(row.version),members:[],status:row.status==='published'?'published':'withdrawn',note:'',updated:Number(row.created_at),digest:String(row.content_sha256),platforms:JSON.parse(String(row.platforms))});
      save(String(row.org_id),item);db.prepare('UPDATE skill_releases SET release_id=?,market_payload=? WHERE skill_id=? AND version=? AND org_id=?').run(id,JSON.stringify(item),row.skill_id!,row.version!,row.org_id!);
    }
    for(const row of db.prepare('SELECT * FROM skill_submissions WHERE item_id IS NULL').all()){
      const id='submission-'+String(row.submission_id);const item=normalize({id,skillId:String(row.skill_id),owner:String(row.author_id),title:String(row.skill_id),kind:'skill',description:'从企业技能提交记录迁移',body:String(row.package_body),source:'manual',origin:'',version:String(row.version),members:[],status:String(row.status),note:String(row.review_note??''),updated:Number(row.created_at),platforms:JSON.parse(String(row.platforms))});
      if(item.status!=='published')save(String(row.org_id),item);
      db.prepare('UPDATE skill_submissions SET item_id=?,market_payload=? WHERE submission_id=?').run(id,JSON.stringify(item),row.submission_id!);
    }
  });
  function items(org:string):MarketItem[]{
    return db.prepare('SELECT payload FROM market_items WHERE org=?').all(org).map(r=>normalize(JSON.parse(String(r.payload)) as Partial<MarketItem>));
  }
  function notify(org:string,item:MarketItem,message:string,ownerOnly=false){
    const employees=ownerOnly?[item.owner]:[...new Set([item.owner,...db.prepare('SELECT employee FROM market_installs WHERE org=? AND id=?').all(org,item.id).map(r=>String(r.employee))])];
    for(const employee of employees)db.prepare('INSERT INTO market_notifications(id,org,employee,item,message,created) VALUES(?,?,?,?,?,?)').run(randomUUID(),org,employee,item.id,message,now());
  }
  return function marketCommand(actor:Actor,action:string,input:Record<string,unknown>):MarketResult {
    const all=items(actor.orgId);
    const installs=db.prepare('SELECT id,enabled FROM market_installs WHERE org=? AND employee=?').all(actor.orgId,actor.employeeId);
    const installedIds=new Set(installs.map(r=>String(r.id)));
    const visible=all.filter(x=>x.owner===actor.employeeId||actor.role==='admin'||x.status==='published'||(['retired','withdrawn'].includes(x.status)&&installedIds.has(x.id)));
    let item=visible.find(x=>x.id===input.id);
    const owned=(x:MarketItem)=>x.owner===actor.employeeId;
    const accessible=(x:MarketItem,existing=false)=>x.status==='published'||(owned(x)&&x.personalAvailable&&x.status!=='withdrawn')||(existing&&x.status==='retired'&&installedIds.has(x.id));
    const connectors=()=>db.prepare('SELECT payload FROM market_connectors WHERE org=? AND employee=?').all(actor.orgId,actor.employeeId).map(r=>JSON.parse(String(r.payload)) as Record<string,unknown>);
    const summary=(x:MarketItem)=>{const {body,...meta}=x;return {...meta,owned:owned(x),checks:checkSkill(x),entryLength:(()=>{try{return skillInstruction(x).length;}catch{return 0;}})()};};
    const full=(x:MarketItem)=>({...x,owned:owned(x),checks:checkSkill(x)});
    const resolve=(x:MarketItem,trial=false):MarketResult=>{
      if(!accessible(x,true)&&!(trial&&owned(x)&&!['published','withdrawn','retired'].includes(x.status)))return fail('此版本不可使用，请查看状态或解除技能绑定','FORBIDDEN');
      const members=x.members.map(id=>all.find(m=>m.id===id));
      if(members.some(m=>!m||!accessible(m,true)))return fail('专家组合含不可用成员');
      const resources=[x,...members as MarketItem[]];
      const checks=resources.flatMap(checkSkill);if(checks.some(c=>c.status==='error'))return fail(checks.filter(c=>c.status==='error').map(c=>c.message).join('；'));if(resources.map(skillInstruction).join('\n\n').length>6000)return fail('技能组合超过 6000 字上下文限制');
      if(checks.some(c=>c.status==='error'))return fail(checks.filter(c=>c.status==='error').map(c=>c.message).join('；'));
      return {ok:true,item:full(x),resources:resources.map(r=>{const row=db.prepare('SELECT package_body,content_sha256 FROM skill_releases WHERE release_id=? AND org_id=?').get(r.id,actor.orgId);return {item:full(r),packageBody:row?String(row.package_body):skillPackage(r),digest:row?String(row.content_sha256):hash(skillPackage(r))};})};
    };
    if(action.startsWith('legacy-')){
      if(action==='legacy-list')return {ok:true,skills:all.filter(x=>x.status==='published').map(x=>({skillId:x.skillId,version:x.version,contentSha256:x.digest,platforms:x.platforms,status:'published'}))};
      if(action==='legacy-review'){
        const row=db.prepare('SELECT item_id FROM skill_submissions WHERE submission_id=? AND org_id=?').get(String(input.submissionId),actor.orgId);
        return row?marketCommand(actor,'review',{...input,id:row.item_id}):fail('没有这个 Skill 提交','NOT_FOUND');
      }
      if(action==='legacy-download'){
        const x=all.find(x=>x.skillId===input.skillId&&x.version===input.version&&x.status==='published');
        if(!x)return fail('没有这个已发布 Skill','NOT_FOUND');
        const row=db.prepare('SELECT package_body,content_sha256 FROM skill_releases WHERE release_id=? AND org_id=?').get(x.id,actor.orgId);
        return row?{ok:true,packageBody:row.package_body,contentSha256:row.content_sha256,platforms:x.platforms}:fail('发布包不存在','NOT_FOUND');
      }
      if(action==='legacy-revise'){
        const row=db.prepare('SELECT * FROM skill_submissions WHERE submission_id=? AND org_id=? AND author_id=?').get(String(input.submissionId),actor.orgId,actor.employeeId);
        const old=row?all.find(x=>x.id===row.item_id):undefined;
        if(!old)return fail('没有这个 Skill 提交','NOT_FOUND');
        if(typeof input.packageBody!=='string'||input.packageBody.includes('..'))return fail('Skill 包路径不合法');
        let revision=old.revision+1;
        let version=old.version;
        if(['published','personal','retired','withdrawn'].includes(old.status)||old.personalAvailable){const bits=version.split('.').map(Number);bits[2]=(bits[2]??0)+1;version=bits.join('.');while(all.some(x=>x.skillId===old.skillId&&x.version===version)){bits[2]=(bits[2]??0)+1;version=bits.join('.');}}
        else {old.status='draft';save(actor.orgId,old);db.prepare("UPDATE skill_submissions SET status='cancelled' WHERE submission_id=?").run(String(input.submissionId));}
        const saved=marketCommand(actor,'save',{...old,...(version===old.version?{id:old.id}:{id:undefined,parentId:old.id}),body:input.packageBody,platforms:input.platforms,version});
        if(!saved.ok)return saved;
        const next=saved.item as MarketItem;const submitted=marketCommand(actor,'submit',{id:next.id});
        return submitted.ok?{...submitted,status:'pending',approvedRevision:revision}:submitted;
      }
      if(action==='legacy-publish'||action==='legacy-submit'){
        if(action==='legacy-publish'&&actor.role!=='admin')return fail('员工不能调用管理接口','FORBIDDEN');
        if(typeof input.skillId!=='string'||!/^[-a-zA-Z0-9_.]{1,100}$/.test(input.skillId)||input.skillId.includes('..')||typeof input.packageBody!=='string'||input.packageBody.includes('..')||!Array.isArray(input.platforms)||!input.platforms.includes('darwin-arm64'))return fail('Skill 参数或路径不合法');
        const existing=all.find(x=>x.skillId===input.skillId);
        if(existing&&!owned(existing)&&actor.role!=='admin')return fail('不能覆盖其他人的技能','FORBIDDEN');
        if(all.some(x=>x.skillId===input.skillId&&x.version===input.version))return fail('此版本已存在','CONFLICT');
        const saved=marketCommand(actor,'save',{title:input.title??input.skillId,kind:'skill',description:'企业技能',body:input.packageBody,source:'manual',version:input.version,platforms:input.platforms});
        if(!saved.ok)return saved;
        const next=saved.item as MarketItem;next.skillId=String(input.skillId);next.digest=hash(skillPackage(next));save(actor.orgId,next);
        const submitted=marketCommand(actor,'submit',{id:next.id});if(!submitted.ok)return submitted;
        if(action==='legacy-submit')return {...submitted,status:'pending'};
        const reviewed=marketCommand(actor,'review',{id:next.id,decision:'approve'});if(!reviewed.ok)return reviewed;
        return {ok:true,release:{skillId:next.skillId,version:next.version,contentSha256:next.digest,platforms:next.platforms,status:'published'}};
      }
      return fail('未知旧版技能操作');
    }
    if(action==='list')return {ok:true,items:visible.map(x=>input.summary?summary(x):full(x)),installs,connectors:connectors(),role:actor.role};
    if(action==='catalog'){
      let found=visible.filter(x=>input.scope==='studio'?owned(x):input.scope==='review'?actor.role==='admin'&&(input.status==='retired'?['retired','withdrawn'].includes(x.status):x.status===(input.status??'pending')):input.scope==='mine'?installedIds.has(x.id)||(owned(x)&&x.personalAvailable):x.status==='published');
      if(input.kind)found=found.filter(x=>x.kind===input.kind);
      if(input.source)found=found.filter(x=>x.source===input.source);
      if(input.excludeSource)found=found.filter(x=>x.source!==input.excludeSource);
      if(input.category)found=found.filter(x=>x.category===input.category);
      const q=String(input.q??'').toLowerCase().trim();if(q)found=found.filter(x=>[x.title,x.description,x.category,x.outputType,x.applicability,...x.tags].join(' ').toLowerCase().includes(q));
      if(input.installed==='yes')found=found.filter(x=>installedIds.has(x.id));
      if(input.installed==='no')found=found.filter(x=>!installedIds.has(x.id));
      // 普通目录一个稳定技能展示最新发布版；创作和本人库保留版本历史。
      if(!['studio','review'].includes(String(input.scope))){const latest=new Map<string,MarketItem>();for(const x of found){const old=latest.get(x.skillId);const preferred=Array.isArray(input.preferredIds)?input.preferredIds:[];if(!old||(preferred.includes(x.id)&&!preferred.includes(old.id))||(!preferred.includes(old.id)&&compareSkillVersions(x.version,old.version)>0))latest.set(x.skillId,x);}found=[...latest.values()];}
      found.sort((a,b)=>input.sort==='name'?a.title.localeCompare(b.title,'zh-CN'):input.sort==='updated'?b.updated-a.updated:b.featured-a.featured||b.updated-a.updated);
      const offset=Math.max(0,Number(input.offset)||0),limit=Math.min(100,Math.max(1,Number(input.limit)||30));
      return {ok:true,items:found.slice(offset,offset+limit).map(summary),total:found.length,offset,next:offset+limit<found.length?offset+limit:null,categories:[...new Set(visible.filter(x=>x.status==='published').map(x=>x.category))],installs,role:actor.role};
    }
    if(action==='notifications')return {ok:true,notifications:db.prepare('SELECT id,item,message,created,seen FROM market_notifications WHERE org=? AND employee=? ORDER BY created DESC LIMIT 100').all(actor.orgId,actor.employeeId)};
    if(action==='notification-read'){db.prepare('UPDATE market_notifications SET seen=1 WHERE id=? AND org=? AND employee=?').run(String(input.id),actor.orgId,actor.employeeId);return {ok:true};}
    if(action==='official-import'){
      if(actor.role!=='admin')return fail('需要管理员权限','FORBIDDEN');
      const imported:string[]=[];
      tx(()=>{for(const content of officialSkills){if(all.some(x=>x.origin===content.origin&&x.version===content.version))continue;const id=randomUUID();const x=normalize({...content,id,skillId:id,owner:actor.employeeId,status:'draft',note:'',updated:now()});save(actor.orgId,x);imported.push(id);}});
      return {ok:true,imported,message:'已导入精选草稿，请检查、试用后审核发布；尚未启用'};
    }
    if(action==='expert-import'){
      if(actor.role!=='admin')return fail('需要管理员权限','FORBIDDEN');
      const imported:string[]=[];
      for(const [slug,title,names] of [['office','办公材料助手',['material-report','meeting-notes','weekly-report']],['product','产品工作助手',['product-requirements','proposal-comparison','evidence-summary']]] as const){
        if(all.some(x=>x.origin==='cpclaw:expert:'+slug))continue;
        const members=names.map(name=>all.filter(x=>x.origin==='cpclaw:official:'+name&&x.status==='published').sort((a,b)=>compareSkillVersions(b.version,a.version))[0]);
        if(members.some(x=>!x))return fail('请先发布六个官方基础技能，再创建专家组合');
        const saved=marketCommand(actor,'save',{kind:'expert',title,description:'选择具体任务，复用经过维护的工作方法。',body:'# '+title+'\n先明确本次工作目标，根据成员方法完成任务；不授予新的工具权限，结果需检查。',version:'1.0.0',source:'builtin',origin:'cpclaw:expert:'+slug,members:members.map(x=>x!.id),category:slug==='office'?'文档报告':'产品与运营',inputs:[{name:'materials',label:'任务与材料',required:true,example:'请说明目标并提供选定材料'}],examples:[{title:'组合使用说明',input:'提供当前任务与对应材料。',output:'选择成员中适合的方法，输出对应成果与待确认事项。'}]});
        if(!saved.ok)return saved;imported.push((saved.item as MarketItem).id);
      }
      return {ok:true,imported,message:'专家草稿已创建，请分别试用并审核发布'};
    }
    if(action==='save'){
      if(input.id&&(!item||!owned(item)))return fail('不能修改其他人的技能','FORBIDDEN');
      if(item&&['pending','published','withdrawn','retired'].includes(item.status))return fail('此版本不可覆盖，请另存新版本');
      if(item&&input.revision!==undefined&&input.revision!==item.revision)return fail('草稿已被修改，请比较最新修订后再保存','CONFLICT');
      const {title,description,body,kind,version,source,origin}=input;
      if(typeof title!=='string'||!title.trim()||title.length>100||typeof description!=='string'||description.length>1000||typeof body!=='string'||!body.trim()||Buffer.byteLength(body)>150000||!['skill','expert'].includes(String(kind))||typeof version!=='string'||!skillVersionPattern.test(version)||!['manual','ai','upload','opensource','builtin'].includes(String(source)))return fail('请填写名称、说明、正文及有效版本（如 1.0.0）');
      if(source==='builtin'&&actor.role!=='admin')return fail('只有管理员可维护官方技能','FORBIDDEN');
      if(kind==='expert'&&actor.role!=='admin')return fail('专家组合由管理员维护','FORBIDDEN');
      if(source==='opensource'&&(typeof origin!=='string'||!/^https:\/\/[^\s]+$/.test(origin)))return fail('开源引入需要 HTTPS 来源');
      let metadata;try{metadata=readSkillMetadata(input);skillFiles(body,String(source));}catch(e){return fail(e instanceof Error?e.message:'内容无效');}
      const parent=input.parentId?visible.find(x=>x.id===input.parentId):undefined;
      if(input.parentId&&(!parent||!owned(parent)))return fail('新版本必须关联本人的技能','FORBIDDEN');
      const id=item?.id??randomUUID(),skillId=parent?.skillId??item?.skillId??id;
      if(all.some(x=>x.id!==id&&x.skillId===skillId&&x.version===version))return fail('此技能版本已存在，请升级版本号','CONFLICT');
      if(!parent&&all.some(x=>x.id!==id&&owned(x)&&x.title===title.trim()&&x.version===version))return fail('此名称与版本已存在，请升级版本号');
      const members=Array.isArray(input.members)?input.members:[];
      if(members.length>20||members.some(m=>typeof m!=='string'||!all.some(x=>x.id===m&&x.kind==='skill'&&x.status==='published'))||new Set(members).size!==members.length)return fail('组合只能引用不同的本组织已发布技能');
      if(kind==='expert'&&!members.length)return fail('请选择组合成员');
      const next=normalize({...metadata,id,skillId,owner:actor.employeeId,kind:kind as 'skill'|'expert',title:title.trim(),description,body,version,source:String(source),origin:typeof origin==='string'?origin:'',members:members as string[],status:'draft',note:'',updated:now(),revision:(item?.revision??0)+1,personalAvailable:item?.personalAvailable??false,featured:item?.featured??0});
      if(item?.personalAvailable&&item.digest!==next.digest)return fail('个人可用版本已冻结，请另存新版本');
      save(actor.orgId,next);return {ok:true,item:full(next)};
    }
    if(action==='connector-save'){
      const {title,type,target}=input;if(typeof title!=='string'||!title.trim()||title.length>100||typeof target!=='string'||target.length>1000||!['MCP','CLI'].includes(String(type)))return fail('连接器配置无效');
      if(type==='MCP'){try{const u=new URL(target);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)return fail('地址不能包含凭据或查询参数');}catch{return fail('请输入 HTTP(S) 服务地址');}}else if(!target.startsWith('/')||/[\n\r\0]/.test(target))return fail('CLI 需要程序绝对路径');
      const old=connectors().find(c=>c.id===input.id);if(input.id&&!old)return fail('连接器不存在');
      const c={id:old?.id??randomUUID(),title,type,target,enabled:input.enabled!==false,status:'未检测',revision:Number(old?.revision??0)+1,updated:now()};
      db.prepare('INSERT OR REPLACE INTO market_connectors VALUES(?,?,?,?)').run(String(c.id),actor.orgId,actor.employeeId,JSON.stringify(c));return {ok:true,connector:c};
    }
    if(action==='connector-remove'){db.prepare('DELETE FROM market_connectors WHERE id=? AND org=? AND employee=?').run(String(input.id),actor.orgId,actor.employeeId);return {ok:true};}
    if(action==='uninstall'){db.prepare('DELETE FROM market_installs WHERE org=? AND employee=? AND id=?').run(actor.orgId,actor.employeeId,String(input.id));return {ok:true};}
    if(!item)return fail('资源不存在或无权访问','NOT_FOUND');
    if(action==='detail')return {ok:true,item:full(item),submissionEvidence:(()=>{const row=db.prepare('SELECT market_payload FROM skill_submissions WHERE item_id=? AND org_id=? ORDER BY created_at DESC LIMIT 1').get(item!.id,actor.orgId);return row?JSON.parse(String(row.market_payload)).submissionEvidence??null:null;})(),versions:visible.filter(x=>x.skillId===item!.skillId).sort((a,b)=>compareSkillVersions(b.version,a.version)).map(summary),feedback:actor.role==='admin'?db.prepare('SELECT kind,note,created FROM market_feedback WHERE org=? AND item=? ORDER BY created DESC LIMIT 30').all(actor.orgId,item.id):[]};
    if(action==='validate')return {ok:true,checks:checkSkill(item),digest:item.digest,revision:item.revision};
    if(action==='resolve'||action==='download')return resolve(item,input.trial===true);
    if(action==='feedback'){
      if(!['useful','problem'].includes(String(input.kind))||typeof input.note!=='string'||input.note.length>1000)return fail('反馈内容无效');
      db.prepare('INSERT INTO market_feedback VALUES(?,?,?,?,?,?,?)').run(randomUUID(),actor.orgId,actor.employeeId,item.id,String(input.kind),input.note,now());return {ok:true};
    }
    if(action==='feature'){
      if(actor.role!=='admin'||item.status!=='published')return fail('只能管理已发布资源的精选排序','FORBIDDEN');
      item.featured=Math.max(0,Math.min(100,Number(input.rank)||0));save(actor.orgId,item);return {ok:true};
    }
    if(['personal','submit','delete','cancel-submit'].includes(action)){
      if(!owned(item))return fail('只有作者可操作','FORBIDDEN');
      if(action==='cancel-submit'){
        if(item.status!=='pending')return fail('当前没有待审提交');
        tx(()=>{db.prepare("UPDATE skill_submissions SET status='cancelled' WHERE item_id=? AND org_id=? AND status='pending'").run(item!.id,actor.orgId);item!.status=item!.personalAvailable?'personal':'draft';save(actor.orgId,item!);});return {ok:true};
      }
      if(['pending','published','retired','withdrawn'].includes(item.status))return fail('此状态不可操作，请创建新版本');
      if(action==='delete'){
        if(item.personalAvailable)return fail('个人快照已被冻结，停用或另存新版本即可');
        db.prepare('DELETE FROM market_items WHERE id=? AND org=?').run(item.id,actor.orgId);return {ok:true};
      }
      const errors=checkSkill(item).filter(c=>c.status==='error');if(errors.length)return fail(errors.map(c=>c.message).join('；'));
      if(action==='personal'&&item.kind==='expert')return fail('专家组合需要审核发布');
      if(action==='submit'&&input.strict===true&&(!item.description.trim()||!item.examples.length||(item.source==='opensource'&&!item.license)))return fail('组织共享需补充用途、样例及开源许可');
      let submissionEvidence:Record<string,unknown>|null=null;
      if(input.evidence&&typeof input.evidence==='object'){
        const evidence=input.evidence as Record<string,unknown>;
        if(evidence.digest!==item.digest)return fail('试用报告对应旧修订，请重新试用','CONFLICT');
        if(!['passed','failed','unverified'].includes(String(evidence.status))||!['mock','real'].includes(String(evidence.mode))||typeof evidence.runRef!=='string'||evidence.runRef.length>100)return fail('试用报告格式无效');
        submissionEvidence={digest:item.digest,status:evidence.status,mode:evidence.mode,runRef:evidence.runRef,checkedAt:Number(evidence.checkedAt)||0,source:'author-host-report'};
      }
      const submissionId=randomUUID();
      tx(()=>{
        if(action==='personal'){item!.personalAvailable=true;item!.status='personal';release(actor.orgId,item!,'personal');}
        else {item!.status='pending';db.prepare('INSERT INTO skill_submissions(submission_id,skill_id,version,org_id,author_id,content_sha256,platforms,package_body,status,approved_revision,created_at,item_id,market_payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(submissionId,key(actor.orgId,item!.skillId),item!.version,actor.orgId,actor.employeeId,item!.digest,JSON.stringify(item!.platforms),skillPackage(item!),'pending',item!.revision,now(),item!.id,JSON.stringify({...item,submissionEvidence}));}
        item!.note='';item!.updated=now();save(actor.orgId,item!);
      });return {ok:true,submissionId};
    }
    if(action==='review'){
      if(actor.role!=='admin')return fail('需要管理员权限','FORBIDDEN');
      if(item.status==='published'&&input.decision==='approve')return {ok:true,duplicate:true};
      const row=db.prepare("SELECT * FROM skill_submissions WHERE item_id=? AND org_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(item.id,actor.orgId);
      if(item.status!=='pending'||!row||!['approve','reject'].includes(String(input.decision)))return fail('审核状态或结论无效','CONFLICT');
      if(input.digest!==undefined&&input.digest!==item.digest)return fail('提交修订已变化，请刷新审核','CONFLICT');
      if(input.decision==='reject'&&(typeof input.note!=='string'||!input.note.trim()))return fail('请填写可执行的修订意见');
      tx(()=>{item!.status=input.decision==='approve'?'published':'rejected';item!.note=String(input.note??'').slice(0,2000);item!.updated=now();if(item!.status==='published')release(actor.orgId,item!,'published');save(actor.orgId,item!);db.prepare('UPDATE skill_submissions SET status=?,review_note=? WHERE submission_id=?').run(item!.status,item!.note,row.submission_id!);notify(actor.orgId,item!,item!.status==='published'?'审核通过，技能已发布':'技能需修订：'+item!.note,true);if(item!.status==='published'){for(const old of all.filter(x=>x.skillId===item!.skillId&&x.id!==item!.id)){notify(actor.orgId,old,'技能 '+item!.title+' 有新版本 '+item!.version+'，可查看更新说明');}}});return {ok:true};
    }
    if(action==='withdraw'||action==='retire'){
      if(actor.role!=='admin')return fail('需要管理员权限','FORBIDDEN');
      if(!['published','retired'].includes(item.status))return fail('只能处理已发布版本');
      tx(()=>{item!.status=action==='retire'?'retired':'withdrawn';item!.note=String(input.note??(action==='retire'?'维护者已下架此版本':'管理员紧急停用')).slice(0,2000);item!.updated=now();save(actor.orgId,item!);db.prepare('UPDATE skill_releases SET status=? WHERE release_id=? AND org_id=?').run(action==='retire'?'retired':'disabled',item!.id,actor.orgId);notify(actor.orgId,item!,item!.note);});return {ok:true};
    }
    if(action==='install'||action==='toggle'){
      if(!accessible(item,installedIds.has(item.id)))return fail('此版本尚不可安装或已停用');
      if(action==='install'&&item.status==='retired'&&!installedIds.has(item.id))return fail('此版本已下架');
      const checked=resolve(item);if(!checked.ok)return checked;
      if(action==='toggle'&&!installedIds.has(item.id))return fail('请先安装');
      db.prepare('INSERT OR REPLACE INTO market_installs VALUES(?,?,?,?)').run(actor.orgId,actor.employeeId,item.id,input.enabled===false?0:1);return {ok:true};
    }
    return fail('未知市场操作');
  };
}

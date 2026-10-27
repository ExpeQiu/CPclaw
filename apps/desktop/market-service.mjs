import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,accessSync,constants} from 'node:fs';
import {join} from 'node:path';
import {installSkillPackage,readInstalledSkill,readCurrentSkill,activateInstalledSkill} from '@cpclaw/desktop-host';
import {checkSkillOutput,skillInstruction} from '@cpclaw/contracts';
import {publicServices} from './service-runtime.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(code,message,extra={})=>({ok:false,code,message,...extra});
/** 本机安装/运行事实只在宿主保存；平台安装记录仅是账号偏好。 */
export function createMarketService({db,dataDir,scope,remote,owns,assertCurrent,isActive,createChat,emit,executeService}){
  db.exec(`CREATE TABLE IF NOT EXISTS local_skill_installs(account TEXT NOT NULL,release TEXT NOT NULL,skill TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,enabled INTEGER NOT NULL,explicit INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(account,release));
    CREATE TABLE IF NOT EXISTS local_skill_members(account TEXT NOT NULL,expert TEXT NOT NULL,member TEXT NOT NULL,PRIMARY KEY(account,expert,member));
    CREATE TABLE IF NOT EXISTS skill_bindings(chat TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS skill_run_snapshots(message TEXT PRIMARY KEY,chat TEXT NOT NULL,body TEXT NOT NULL,result TEXT);
    CREATE TABLE IF NOT EXISTS skill_operations(account TEXT NOT NULL,id TEXT NOT NULL,release TEXT NOT NULL,state TEXT NOT NULL,message TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(account,id));
    UPDATE skill_operations SET state='interrupted',message='应用退出时尚未完成，请重新检查后安装' WHERE state NOT IN ('done','failed','cancelled');`);
  const installing=new Map(),installControllers=new Map();
  const account=actor=>hash(scope(actor));
  function ensureScope(actor,expected){assertCurrent(actor);if(scope(actor)!==expected)throw Error('平台或账号已变化，请重新打开技能市场');}
  const folder=actor=>{const base=join(dataDir,'skill-accounts'),target=join(base,account(actor));for(const p of [base,target])if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('技能账号安装区不能是链接');return target;};
  const installed=(actor,id)=>db.prepare('SELECT * FROM local_skill_installs WHERE account=? AND release=?').get(account(actor),id);
  function localState(actor,items=[]){return db.prepare('SELECT * FROM local_skill_installs WHERE account=?').all(account(actor)).map(r=>{const check=readInstalledSkill(folder(actor),r.skill,r.version,r.digest);return {...r,valid:check.ok,error:check.ok?'':check.message,current:readCurrentSkill(folder(actor),r.skill).installed?.version===r.version};});}
  function status(actor,snapshot){const local=localState(actor);return {...snapshot,localInstalls:local,items:snapshot.items.map(item=>({...item,local:local.find(x=>x.release===item.id)??null,hasUpdate:local.some(x=>x.skill===item.skillId&&x.version!==item.version)}))};}
  function operation(actor,id,release,state,message,savedAccount=account(actor)){db.prepare('INSERT INTO skill_operations VALUES(?,?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET state=excluded.state,message=excluded.message,updated=excluded.updated').run(savedAccount,id,release,state,message,Date.now());emit({channel:'market',actorId:actor,type:'installation',operationId:id,releaseId:release,state,message});}
  async function install(actor,id){
    const startingScope=scope(actor),installAccount=account(actor);
    const key=installAccount+':'+id;if(installing.has(key))return installing.get(key);if([...installing.keys()].some(k=>k.startsWith(account(actor)+':')))return fail('SLOT_BUSY','已有技能正在安装，请完成或取消后继续');
    const promise=(async()=>{
      const controller=new AbortController();installControllers.set(key,controller);
      const operationId=randomUUID();const report=(state,message)=>operation(actor,operationId,id,state,message,installAccount);report('downloading','获取固定版本');
      try{
        const resolved=await remote(actor,'download',{id},controller.signal);ensureScope(actor,startingScope);
        if(!resolved.ok)throw Error(resolved.message);
        report('checking','检查发布摘要、平台和文件');
        // 所有成员先校验及落盘，最后一次提交本机引用；失败不会使组合显示为完整安装。
        for(const resource of resolved.resources){
          controller.signal.throwIfAborted();
          report('installing','安装 '+resource.item.title);
          const result=installSkillPackage({dataDir:folder(actor),skillId:resource.item.skillId,version:resource.item.version,expectedSha256:resource.digest,packageBody:resource.packageBody,platforms:resource.item.platforms,activate:false});if(!result.ok)throw Error(result.message);
        }
        const preferred=await remote(actor,'install',{id},controller.signal);ensureScope(actor,startingScope);if(!preferred.ok)throw Error(preferred.message);
        controller.signal.throwIfAborted();const root=resolved.resources[0];const activated=activateInstalledSkill(folder(actor),root.item.skillId,root.item.version,root.digest);if(!activated.ok)throw Error(activated.message);
        db.exec('BEGIN IMMEDIATE');try{
          for(const {item,digest} of resolved.resources){db.prepare('INSERT INTO local_skill_installs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account,release) DO UPDATE SET enabled=1,explicit=MAX(explicit,excluded.explicit),digest=excluded.digest,updated=excluded.updated').run(account(actor),item.id,item.skillId,item.version,digest,1,item.id===id?1:0,Date.now());if(item.id!==id)db.prepare('INSERT OR IGNORE INTO local_skill_members VALUES(?,?,?)').run(account(actor),id,item.id);}
          db.exec('COMMIT');
        }catch(e){db.exec('ROLLBACK');throw e;}
        report('done','固定版本已安装，执行前将检查所需条件');return {ok:true,operationId,installed:resolved.resources.map(r=>r.item.id)};
      }catch(e){report(controller.signal.aborted?'cancelled':'failed',e.message);return fail(controller.signal.aborted?'INSTALL_CANCELLED':'INSTALL_FAILED',e.message,{operationId});}
    })();installing.set(key,promise);try{return await promise;}finally{installing.delete(key);installControllers.delete(key);}
  }
  function binding(chatId){return JSON.parse(db.prepare('SELECT body FROM skill_bindings WHERE chat=?').get(chatId)?.body??'null');}
  function readiness(resources,snapshot){
    const services=publicServices(snapshot.connectors),checks=[];
    for(const {item} of resources){
      if(!item.platforms.includes(process.platform+'-'+process.arch))checks.push({title:item.title,state:'incompatible',required:true,message:'当前平台不兼容'});
      for(const dep of item.dependencies){
        if(dep.type==='internal'){checks.push({title:dep.title,state:'available',required:dep.required,message:'使用现有宿主能力；材料和访问权在本次任务检查'});continue;}
        const matches=services.filter(s=>s.type===dep.type&&(s.id===dep.service||s.title===dep.service||s.title===dep.title));
        let state='needs_check',message='将在开始执行时发现工具并检查账号';
        if(!matches.length){state='missing';message='请先在连接器中配置 '+dep.title;}
        else if(matches.length>1){state='ambiguous';message='找到多个服务，请使用明确的服务标识';}
        else if(matches[0].type==='CLI'){try{accessSync(matches[0].target,constants.X_OK);}catch{state='missing';message='未找到可执行程序，请检查安装和程序路径';}}
        checks.push({...dep,state,message,instanceId:matches[0]?.id});
      }
    }
    const blocked=checks.some(c=>c.required&&['missing','ambiguous','incompatible'].includes(c.state));
    return {checks,canUse:!blocked,ready:!blocked&&!checks.some(c=>c.required&&c.state==='needs_check'),checkedAt:Date.now()};
  }
  async function use(actor,input,trial=false,migrating=false){
    const startingScope=scope(actor);
    if(!migrating&&isActive())return fail('SLOT_BUSY','请等待或停止当前执行后再选用技能');
    const resolved=await remote(actor,'resolve',{id:input.id,trial});ensureScope(actor,startingScope);if(!resolved.ok)return resolved;
    const taskMember=resolved.item.kind==='expert'?resolved.resources.find(r=>r.item.id===input.taskMember&&r.item.id!==resolved.item.id):null;
    if(resolved.item.kind==='expert'&&resolved.item.inputs.length&&!taskMember)return fail('INPUT_REQUIRED','请选择本次专家任务');
    if(taskMember)resolved.resources=[resolved.resources[0],taskMember];
    const inputFields=[...new Map([...resolved.item.inputs,...(taskMember?.item.inputs??[])].map(p=>[p.name,p])).values()];
    const values=input.values??{};if(!values||typeof values!=='object'||Array.isArray(values)||Object.entries(values).some(([k,v])=>typeof v!=='string'||v.length>8000))return fail('INPUT_INVALID','技能输入无效');
    const missing=inputFields.filter(p=>p.required&&!String(values[p.name]??'').trim());if(missing.length)return fail('INPUT_REQUIRED','请补充：'+missing.map(p=>p.label).join('、'),{missing});
    if(Object.values(values).join('\n').length>6000)return fail('INPUT_INVALID','技能输入合计超过 6000 字，请精简');
    const snapshot=await remote(actor,'list',{summary:true});ensureScope(actor,startingScope);
    const ready=readiness(resolved.resources,snapshot);if(!ready.canUse)return fail('DEPENDENCY_MISSING','必需依赖尚未就绪',{readiness:ready});
    if(input.chatId&&!owns(actor,input.chatId))return fail('NOT_FOUND','无权访问当前聊天');
    if(!trial){
      if(!installed(actor,input.id)){
        // 旧账号仅有市场偏好时，明确补做本机安装，绝不把偏好当制品。
        if(!snapshot.installs.some(x=>x.id===input.id&&x.enabled))return fail('NOT_INSTALLED','请先安装并启用技能');
        const result=await install(actor,input.id);if(!result.ok)return result;
      }
      if(!installed(actor,input.id)?.enabled)return fail('DISABLED','技能已停用，请先启用');
    }
    const resources=[];
    for(const resource of resolved.resources){
      const storageSkill=trial?'trial-'+resource.item.id+'-r'+resource.item.revision:resource.item.skillId;
      if(trial){const result=installSkillPackage({dataDir:folder(actor),skillId:storageSkill,version:resource.item.version,expectedSha256:resource.digest,packageBody:resource.packageBody,platforms:resource.item.platforms});if(!result.ok)return result;}
      const checked=readInstalledSkill(folder(actor),storageSkill,resource.item.version,resource.digest);if(!checked.ok)return fail('INSTALL_CORRUPT','本机技能文件需重新校验或安装：'+checked.message);
      resources.push({id:resource.item.id,skillId:resource.item.skillId,storageSkill,version:resource.item.version,digest:resource.digest,title:resource.item.title,revision:resource.item.revision});
    }
    ensureScope(actor,startingScope);if(!migrating&&isActive())return fail('SLOT_BUSY','当前执行状态已变化，请稍后再选用');
    const chatId=input.chatId||createChat(actor,resolved.item.title,input.projectId);
    const value={account:account(actor),id:resolved.item.id,skillId:resolved.item.skillId,title:resolved.item.title,version:resolved.item.version,resources,values,trial,taskMember:taskMember?.item.id??null,created:Date.now()};
    db.prepare('INSERT INTO skill_bindings VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET body=excluded.body').run(chatId,JSON.stringify(value));
    db.prepare('INSERT INTO chat_skills VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET skill=excluded.skill').run(chatId,resolved.item.id);
    return {ok:true,chatId,binding:value,readiness:ready,prompt:inputFields.map(p=>p.label+'：'+(values[p.name]??'')).join('\n')};
  }
  async function prepareRun(actor,chatId,messageId,signal){
    const startingScope=scope(actor);
    let selected=binding(chatId);
    if(!selected){const old=db.prepare('SELECT skill FROM chat_skills WHERE chat=?').get(chatId);if(!old)return null;const migrated=await use(actor,{id:old.skill,chatId},false,true);if(!migrated.ok)throw Error(migrated.message);selected=migrated.binding;}
    if(selected.account&&selected.account!==account(actor))throw Error('技能绑定所属平台或账号已变化，请重新选择');
    const resolved=await remote(actor,'resolve',{id:selected.id,trial:selected.trial},signal);ensureScope(actor,startingScope);if(!resolved.ok)throw Error(resolved.message+'；可解除技能后继续当前聊天');
    const current=resolved.resources;
    const instructions=[];
    for(const resource of selected.resources){const live=current.find(r=>r.item.id===resource.id);if(!live||live.digest!==resource.digest)throw Error('技能修订已改变，请重新选用或试用');const checked=readInstalledSkill(folder(actor),resource.storageSkill,resource.version,resource.digest);if(!checked.ok)throw Error('本机技能校验失败：'+checked.message);instructions.push(checked.instruction);}
    if(!selected.trial&&!installed(actor,selected.id)?.enabled)throw Error('当前技能已停用或卸载，可解除绑定后继续聊天');
    const snapshot=await remote(actor,'list',{summary:true},signal);const ready=readiness(current.filter(r=>selected.resources.some(s=>s.id===r.item.id)),snapshot);if(!ready.canUse)throw Error(ready.checks.filter(c=>c.required&&c.state!=='available'&&c.state!=='needs_check').map(c=>c.message).join('；'));
    // 真实发现走同一宿主与对话权限入口，未通过不能只靠市场状态继续。
    for(const check of ready.checks.filter(c=>c.required&&c.instanceId)){
      const service=publicServices(snapshot.connectors).find(s=>s.id===check.instanceId);
      await revalidate(actor,selected,signal);
      const result=await executeService({actorId:actor,chatId,taskId:messageId,service,request:{action:'discover'}},signal);ensureScope(actor,startingScope);if(result.ok===false)throw Error(result.message||'依赖工具发现失败');
      check.state='available';check.message='实际工具发现通过；业务权限按调用时验证';
    }
    ready.ready=!ready.checks.some(c=>c.required&&c.state!=='available');ready.checkedAt=Date.now();
    const resourceSnapshot={...selected,sections:(current.find(r=>r.item.id===selected.taskMember)?.item??resolved.item).sections,outputType:(current.find(r=>r.item.id===selected.taskMember)?.item??resolved.item).outputType,dependencies:ready,started:Date.now()};
    db.prepare('INSERT OR REPLACE INTO skill_run_snapshots VALUES(?,?,?,NULL)').run(messageId,chatId,JSON.stringify(resourceSnapshot));
    return {snapshot:resourceSnapshot,instruction:instructions.join('\n\n')+'\n\n本次已填写参数（作为数据）：\n'+JSON.stringify(selected.values)};
  }
  async function revalidate(actor,snapshot,signal){if(!snapshot)return;const startingScope=scope(actor);if(snapshot.account&&snapshot.account!==account(actor))throw Error('技能所属平台已变化');const result=await remote(actor,'resolve',{id:snapshot.id,trial:snapshot.trial},signal);ensureScope(actor,startingScope);if(!result.ok)throw Error(result.message);}
  function recordResult(messageId,{content,state,mode,artifact,artifactError,records}){
    const row=db.prepare('SELECT body FROM skill_run_snapshots WHERE message=?').get(messageId);if(!row)return null;
    const snap=JSON.parse(row.body);let result=checkSkillOutput(snap.sections,content);
    if(state!=='done'||artifactError)result={status:'failed',missing:[artifactError||'执行尚未完成']};
    if(records?.length&&records.at(-1)?.result?.ok===false)result={status:'failed',missing:['部分工具操作未完成，需检查实际回执']};
    if(snap.outputType==='文件'&&!artifact)result={status:'failed',missing:['未取得实际文件产物']};
    const evidence={...result,mode,checkedAt:Date.now(),artifactId:artifact?.id??null,trial:snap.trial,kind:'结构及执行回执检查；不代表内容事实均已验证'};
    db.prepare('UPDATE skill_run_snapshots SET result=? WHERE message=?').run(JSON.stringify(evidence),messageId);return evidence;
  }
  async function dispatch(method,actor,input){
    if(method==='market.cancel-install'){const c=installControllers.get(account(actor)+':'+input.id);if(c)c.abort(Error('安装已取消'));return {ok:true,message:c?'正在取消安装':'该安装操作已结束'};}
    if(method==='market.use'||method==='market.trial')return use(actor,input,method==='market.trial');
    if(method==='market.unbind'){
      if(!owns(actor,input.chatId))return fail('NOT_FOUND','无权访问此聊天');if(isActive())return fail('SLOT_BUSY','请等待执行结束再解除技能');
      db.prepare('DELETE FROM skill_bindings WHERE chat=?').run(input.chatId);db.prepare('DELETE FROM chat_skills WHERE chat=?').run(input.chatId);return {ok:true};
    }
    if(method==='market.check'){
      const resolved=await remote(actor,'resolve',{id:input.id,trial:input.trial});if(!resolved.ok)return resolved;const snapshot=await remote(actor,'list',{summary:true});return {ok:true,readiness:readiness(resolved.resources,snapshot)};
    }
    if(method==='market.operations')return {ok:true,operations:db.prepare('SELECT id,release,state,message,updated FROM skill_operations WHERE account=? ORDER BY updated DESC LIMIT 30').all(account(actor))};
    if(method==='market.trials'){
      const rows=db.prepare('SELECT r.message,r.body,r.result FROM skill_run_snapshots r JOIN chats c ON c.id=r.chat WHERE c.actor=? ORDER BY r.rowid DESC LIMIT 100').all(actor);
      return {ok:true,trials:rows.filter(r=>{const s=JSON.parse(r.body);return s.id===input.id&&s.account===account(actor);}).map(r=>({message:r.message,snapshot:JSON.parse(r.body),result:r.result?JSON.parse(r.result):null}))};
    }
    if(method!=='market.call')return undefined;
    const {action,input:params={}}=input;
    if(action==='submit'){
      const reports=db.prepare('SELECT r.message,r.body,r.result FROM skill_run_snapshots r JOIN chats c ON c.id=r.chat WHERE c.actor=? AND r.result IS NOT NULL ORDER BY r.rowid DESC').all(actor);
      const report=reports.find(r=>{const s=JSON.parse(r.body);return s.id===params.id&&s.account===account(actor);});
      if(report){const snap=JSON.parse(report.body),result=JSON.parse(report.result);params.evidence={digest:snap.resources[0].digest,status:result.status,mode:result.mode,runRef:report.message,checkedAt:result.checkedAt};}
    }
    if(action==='catalog'&&params.scope==='mine')params.preferredIds=localState(actor).filter(r=>r.current).map(r=>r.release);
    if(action==='install')return install(actor,params.id);
    if(action==='uninstall'){
      const result=await remote(actor,action,params);if(!result.ok)return result;const a=account(actor);
      db.exec('BEGIN IMMEDIATE');try{
        const members=db.prepare('SELECT member FROM local_skill_members WHERE account=? AND expert=?').all(a,params.id);db.prepare('DELETE FROM local_skill_members WHERE account=? AND expert=?').run(a,params.id);
        db.prepare('UPDATE local_skill_installs SET explicit=0 WHERE account=? AND release=?').run(a,params.id);
        for(const id of [params.id,...members.map(x=>x.member)])if(!db.prepare('SELECT 1 FROM local_skill_members WHERE account=? AND member=?').get(a,id))db.prepare('DELETE FROM local_skill_installs WHERE account=? AND release=? AND explicit=0').run(a,id);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      return {ok:true,message:'已移除安装引用；历史任务所需制品保留'};
    }
    if(action==='toggle'){
      if(!installed(actor,params.id))return fail('NOT_INSTALLED','当前设备尚未安装此版本');
      const result=await remote(actor,action,params);if(result.ok)db.prepare('UPDATE local_skill_installs SET enabled=? WHERE account=? AND release=?').run(params.enabled===false?0:1,account(actor),params.id);return result;
    }
    const result=await remote(actor,action,params);assertCurrent(actor);
    if(result.ok&&['list','catalog'].includes(action))return status(actor,result);
    if(result.ok&&action==='detail')return {...result,local:localState(actor).find(x=>x.release===params.id)};
    return result;
  }
  /** 诊断用：检查绑定技能本机制品是否可读。 */
  function inspectBinding(actor,chatId){
    const selected=binding(chatId);if(!selected)return {binding:null,checks:[]};
    const checks=[];
    for(const resource of selected.resources||[]){
      const checked=readInstalledSkill(folder(actor),resource.storageSkill,resource.version,resource.digest);
      checks.push({storageSkill:resource.storageSkill,version:resource.version,digest:resource.digest,ok:checked.ok,message:checked.ok?'':checked.message,code:checked.ok?'':checked.code});
    }
    if(selected.account&&selected.account!==account(actor))checks.push({storageSkill:selected.skillId||selected.id,ok:false,message:'绑定账号与当前不一致',code:'ACCOUNT_MISMATCH'});
    return {binding:selected,checks};
  }
  function unbindChat(actor,chatId){
    if(!owns(actor,chatId))return fail('NOT_FOUND','无权访问此聊天');
    if(isActive())return fail('SLOT_BUSY','请等待执行结束再解除技能');
    db.prepare('DELETE FROM skill_bindings WHERE chat=?').run(chatId);
    db.prepare('DELETE FROM chat_skills WHERE chat=?').run(chatId);
    return {ok:true};
  }
  return {dispatch,binding,prepareRun,revalidate,recordResult,install,inspectBinding,unbindChat,isBusy:()=>installing.size>0,stop:()=>{for(const c of installControllers.values())c.abort(Error('应用正在退出，安装已停止'));}};
}

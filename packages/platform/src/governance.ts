import { appendAuthorityRevocation } from './authority-ledger.js';
import { ensureConnectorPolicySchema } from './connector-policy.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AdminResult } from './admin.js';
import { managementCatalog } from './management-catalog.js';
import { PLATFORM_SCHEMA_SUPPORTED } from './compat-constants.js';
type Actor = {orgId:string;employeeId:string};
const fail=(message:string,code:'CONFIG_INVALID'|'NOT_FOUND'|'CONFLICT'='CONFIG_INVALID'):AdminResult=>({ok:false,code,message});
/** Admin-only org queries; no raw SQL or private file body is accepted from the client. */
export function createGovernance(db:DatabaseSync,dataDir:string,now:()=>number,audit:(org:string,actor:string,action:string,target:string)=>void){
 ensureConnectorPolicySchema(db);
 function page(sql:string,args:SQLInputValue[],input:Record<string,unknown>):AdminResult{
  const n=input.page??1,size=input.pageSize??25;
  if(!Number.isInteger(n)||Number(n)<1||Number(n)>100000||!Number.isInteger(size)||Number(size)<1||Number(size)>100)return fail('页码或每页数量无效');
  const total=Number(db.prepare('SELECT COUNT(*) AS n FROM ('+sql+')').get(...args)?.n??0);
  return {ok:true,rows:db.prepare(sql+' LIMIT ? OFFSET ?').all(...args,Number(size),(Number(n)-1)*Number(size)),page:n,pageSize:size,total};
 }
 return (actor:Actor,action:string,input:Record<string,unknown>):AdminResult|undefined=>{
  const q=typeof input.q==='string'?input.q.trim():'';
  if(q.length>100)return fail('搜索内容最多 100 字');
  const like='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
  if(action==='catalog')return {ok:true,modules:managementCatalog,schemaVersion:db.prepare('SELECT version FROM schema_meta').get()?.version,supportedSchema:PLATFORM_SCHEMA_SUPPORTED,ports:[{name:'云端业务 API 与管理台',value:3928,scope:'cloud'},{name:'本地开发健康探针',value:3927,scope:'development-only'}]};
  if(action==='audit-query'){
   const args:SQLInputValue[]=[actor.orgId];let where='org_id=?';
   for(const [key,column]of [['actor','actor_id'],['action','action']] as const){const v=input[key];if(v!==undefined&&v!==''){if(typeof v!=='string'||v.length>100)return fail('审计筛选无效');where+=' AND '+column+'=?';args.push(v);}}
   for(const [key,op]of [['from','>='],['to','<=']] as const){const v=input[key];if(v!==undefined&&v!==''){if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))return fail('审计日期无效');where+=' AND at_ms'+op+'?';args.push(Date.parse(v));}}
   if(q){where+=" AND target LIKE ? ESCAPE '\\'";args.push(like);}
   return page('SELECT id,at_ms,actor_id,action,target FROM audit_log WHERE '+where+' ORDER BY id DESC',args,input);
  }
  if(action==='usage')return page(`SELECT r.request_id,r.employee_id,r.model,r.status,r.reserved_tokens,r.input_tokens,r.output_tokens,r.created_at FROM reservations r JOIN employees e ON e.employee_id=r.employee_id WHERE e.org_id=? AND r.employee_id LIKE ? ESCAPE '\\' ORDER BY r.created_at DESC,r.request_id DESC`,[actor.orgId,like],input);
  if(action==='quota-requests')return page(`SELECT r.* FROM quota_requests r JOIN employees e ON e.employee_id=r.employee_id WHERE e.org_id=? AND r.employee_id LIKE ? ESCAPE '\\' ORDER BY r.created_at DESC,r.request_id DESC`,[actor.orgId,like],input);
  if(action==='uploads')return page(`SELECT upload_id,employee_id,purpose,byte_size,status,created_at FROM upload_sessions WHERE org_id=? AND employee_id LIKE ? ESCAPE '\\' ORDER BY created_at DESC,upload_id DESC`,[actor.orgId,like],input);
  if(action==='log-receipts')return page(`SELECT batch_id,employee_id,device_epoch,cursor_from,cursor_to,event_count,created_at FROM log_batches WHERE org_id=? AND employee_id LIKE ? ESCAPE '\\' ORDER BY created_at DESC,batch_id DESC`,[actor.orgId,like],input);
  if(action==='connectors'){
   const result=page(`SELECT c.id,c.employee,c.payload,COALESCE(p.blocked,0) AS blocked,COALESCE(p.revision,0) AS policyRevision FROM market_connectors c LEFT JOIN org_connector_controls p ON p.org=c.org AND p.id=c.id WHERE c.org=? AND c.employee LIKE ? ESCAPE '\\' ORDER BY c.employee,c.id`,[actor.orgId,like],input);
   if(!result.ok)return result;
   return {...result,rows:(result.rows as Record<string,unknown>[]).map(row=>{const c=JSON.parse(String(row.payload));return {id:row.id,employee:row.employee,title:c.title,type:c.type,ownerEnabled:c.enabled!==false,blocked:Boolean(row.blocked),policyRevision:row.policyRevision,updated:c.updated,probeLayer:c.probe?.layer??'未检测',checkedAt:c.probe?.checkedAt??null};})};
  }
  if(action==='connector-control'){
   if(typeof input.id!=='string'||typeof input.blocked!=='boolean'||!Number.isInteger(input.revision))return fail('连接器治理参数无效');
   if(!db.prepare('SELECT id FROM market_connectors WHERE id=? AND org=?').get(input.id,actor.orgId))return fail('连接器不存在','NOT_FOUND');
   const old=db.prepare('SELECT revision FROM org_connector_controls WHERE org=? AND id=?').get(actor.orgId,input.id);
   if(Number(old?.revision??0)!==input.revision)return fail('管理策略已改变，请刷新','CONFLICT');
   db.exec('BEGIN IMMEDIATE');try{
    db.prepare('INSERT INTO org_connector_controls VALUES(?,?,?,?,?) ON CONFLICT(org,id) DO UPDATE SET blocked=excluded.blocked,revision=excluded.revision,updated=excluded.updated').run(actor.orgId,input.id,input.blocked?1:0,Number(input.revision)+1,now());
    appendAuthorityRevocation(dataDir,{kind:'connector_policy',id:input.id,orgId:actor.orgId,actorId:actor.employeeId,blocked:input.blocked,revision:Number(input.revision)+1,at:now()});
    audit(actor.orgId,actor.employeeId,input.blocked?'connector_block':'connector_unblock',input.id);db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}return {ok:true};
  }
  if(action==='learning-candidates')return page(`SELECT candidate_id,author_id,kind,title,version,status,created_at FROM learning_candidates WHERE org_id=? AND title LIKE ? ESCAPE '\\' ORDER BY created_at DESC,candidate_id DESC`,[actor.orgId,like],input);
  if(action==='resources')return page(`SELECT resource_id,kind,title,version,status,created_at FROM org_resources WHERE org_id=? AND title LIKE ? ESCAPE '\\' ORDER BY created_at DESC,resource_id DESC`,[actor.orgId,like],input);
  if(action==='wiki-revisions')return page(`SELECT page_id,revision,title,status,author_id,created_at FROM wiki_pages WHERE org_id=? AND title LIKE ? ESCAPE '\\' ORDER BY created_at DESC,page_id DESC,revision DESC`,[actor.orgId,like],input);
  if(action==='originals')return page(`SELECT doc_id,title,format,version,acl_group,status,created_at FROM knowledge_docs WHERE org_id=? AND title LIKE ? ESCAPE '\\' ORDER BY created_at DESC,doc_id DESC`,[actor.orgId,like],input);
  if(['candidate-read','resource-read','wiki-read','original-read'].includes(action)){
   const [sql,args]=action==='candidate-read'?['SELECT candidate_id,title,body,kind,version,status FROM learning_candidates WHERE org_id=? AND candidate_id=?',[actor.orgId,String(input.id)]]:action==='resource-read'?['SELECT resource_id,title,body,kind,version,status FROM org_resources WHERE org_id=? AND resource_id=?',[actor.orgId,String(input.id)]]:action==='wiki-read'?['SELECT page_id,title,body,revision,status,source_doc_ids FROM wiki_pages WHERE org_id=? AND page_id=? AND revision=?',[actor.orgId,String(input.id),Number(input.revision)||0]]:['SELECT doc_id,title,body,version,acl_group,status FROM knowledge_docs WHERE org_id=? AND doc_id=?',[actor.orgId,String(input.id)]];
   const row=db.prepare(String(sql)).get(...args as SQLInputValue[]);if(!row)return fail('记录不存在','NOT_FOUND');
   audit(actor.orgId,actor.employeeId,action,String(input.id));return {ok:true,item:row};
  }
  if(action==='integrations')return {ok:true,desktopStatus:'reserved',installations:db.prepare('SELECT installation_id,channel,status,created_at FROM channel_installations WHERE org_id=?').all(actor.orgId),devices:db.prepare('SELECT device_id,employee_id,remote_enabled,online,last_seen_at FROM device_endpoints WHERE org_id=? ORDER BY last_seen_at DESC LIMIT 100').all(actor.orgId),bindings:db.prepare('SELECT binding_id,employee_id,channel,status,revision FROM identity_bindings WHERE org_id=? ORDER BY created_at DESC LIMIT 100').all(actor.orgId),deliveries:db.prepare('SELECT delivery_id,command_id,channel,status,attempts,created_at FROM outbound_deliveries WHERE org_id=? ORDER BY created_at DESC LIMIT 100').all(actor.orgId)};
  return undefined;
 };
}

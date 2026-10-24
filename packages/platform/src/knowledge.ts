import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformFailure } from './app.js';
type Actor = {orgId:string;employeeId:string;role:string};
export type KnowledgeResult = {ok:true;[key:string]:unknown}|PlatformFailure;
const fail=(message:string,code:PlatformFailure['code']='CONFIG_INVALID'):PlatformFailure=>({ok:false,code,message});
/** 独立知识库容器；原有需审核的 Wiki 发布链路保持原样。 */
export function createKnowledge(db:DatabaseSync,now:()=>number){
 db.exec(`CREATE TABLE IF NOT EXISTS kb_libraries(id TEXT PRIMARY KEY,org TEXT NOT NULL,owner TEXT NOT NULL,scope TEXT NOT NULL,name TEXT NOT NULL,members TEXT NOT NULL,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS kb_documents(id TEXT PRIMARY KEY,library TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL);`);
 return (actor:Actor,action:string,input:Record<string,unknown>):KnowledgeResult=>{
  const rows=db.prepare('SELECT * FROM kb_libraries WHERE org=?').all(actor.orgId);
  const visible=rows.filter(r=>r.scope==='personal'?r.owner===actor.employeeId:actor.role==='admin'||r.owner===actor.employeeId||JSON.parse(String(r.members)).includes(actor.employeeId));
  const view=(r:typeof rows[number])=>({...r,members:JSON.parse(String(r.members)),editable:r.scope==='personal'?r.owner===actor.employeeId:actor.role==='admin',count:db.prepare('SELECT COUNT(*) AS n FROM kb_documents WHERE library=?').get(String(r.id))?.n});
  if(action==='list')return {ok:true,libraries:visible.map(view),role:actor.role};
  const library=visible.find(r=>r.id===input.id);
  if(action==='save'){
   if(input.id&&!library)return fail('知识库不存在或无权访问','NOT_FOUND');
   const scope=library?.scope??input.scope;
   if(!['enterprise','personal'].includes(String(scope)))return fail('知识库类型无效');
   if(scope==='enterprise'&&actor.role!=='admin')return fail('企业知识库由管理员维护','FORBIDDEN');
   if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)return fail('名称需要 1–100 个字符');
   const members=scope==='personal'?[]:input.members??[];
   if(!Array.isArray(members)||members.length>200||members.some(m=>typeof m!=='string'||!db.prepare("SELECT employee_id FROM employees WHERE employee_id=? AND org_id=? AND status='active'").get(m,actor.orgId)))return fail('成员必须是本组织的有效员工编号');
   const id=library?.id??randomUUID();
   db.prepare('INSERT INTO kb_libraries VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,members=excluded.members,updated=excluded.updated').run(id,actor.orgId,library?.owner??actor.employeeId,String(scope),input.name.trim(),JSON.stringify([...new Set(members)]),now());
   return {ok:true,id};
  }
  if(!library)return fail('知识库不存在或无权访问','NOT_FOUND');
  if(action==='read')return {ok:true,library:view(library),documents:db.prepare('SELECT * FROM kb_documents WHERE library=? ORDER BY title,id').all(String(library.id))};
  if(library.scope==='enterprise'&&actor.role!=='admin')return fail('企业知识库由管理员维护','FORBIDDEN');
  if(action==='document-save'){
   if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120||typeof input.body!=='string'||!input.body.trim()||input.body.length>48000||input.body.includes('\0'))return fail('文档需要标题及不超过 48000 字的文本正文');
   const old=db.prepare('SELECT * FROM kb_documents WHERE id=? AND library=?').get(String(input.documentId??''),String(library.id));
   if(input.documentId&&!old)return fail('文档不存在','NOT_FOUND');
   if(old&&input.revision!==old.revision)return fail('文档已更新，请重新打开后修改','CONFLICT');
   const size=db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(length(body)),0) AS total FROM kb_documents WHERE library=?').get(String(library.id));
   if((!old&&Number(size?.n)>=500)||Number(size?.total)-String(old?.body??'').length+input.body.length>2_000_000)return fail('知识库最多 500 份文档，总正文最多 200 万字');
   const id=old?.id??randomUUID();
   db.prepare('INSERT INTO kb_documents VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,revision=excluded.revision,updated=excluded.updated').run(id,String(library.id),input.title.trim(),input.body,Number(old?.revision??0)+1,now());
   db.prepare('UPDATE kb_libraries SET updated=? WHERE id=?').run(now(),String(library.id));
   return {ok:true,id};
  }
  return fail('未知知识库操作');
 };
}

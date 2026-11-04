import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformFailure } from './app.js';
type Actor = {orgId:string;employeeId:string;role:string};
export type KnowledgeResult = {ok:true;[key:string]:unknown}|PlatformFailure;
const fail=(message:string,code:PlatformFailure['code']='CONFIG_INVALID'):PlatformFailure=>({ok:false,code,message});

function columnNames(db:DatabaseSync, table:string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => String((row as {name?:string}).name ?? ''));
}

/** 企业文档经原文与 Wiki 审核后才对成员可见；个人库仍由本人直接维护。 */
export function createKnowledge(db:DatabaseSync,now:()=>number){
 db.exec(`CREATE TABLE IF NOT EXISTS kb_libraries(id TEXT PRIMARY KEY,org TEXT NOT NULL,owner TEXT NOT NULL,scope TEXT NOT NULL,name TEXT NOT NULL,members TEXT NOT NULL,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS kb_documents(id TEXT PRIMARY KEY,library TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL);`);
 for (const [name, ddl] of [['status',"ALTER TABLE kb_documents ADD COLUMN status TEXT NOT NULL DEFAULT 'published'"],['source_doc_id','ALTER TABLE kb_documents ADD COLUMN source_doc_id TEXT'],['wiki_page_id','ALTER TABLE kb_documents ADD COLUMN wiki_page_id TEXT']] as const) {
  if (!columnNames(db,'kb_documents').includes(name)) db.exec(ddl);
 }
 return (actor:Actor,action:string,input:Record<string,unknown>):KnowledgeResult=>{
  const rows=db.prepare('SELECT * FROM kb_libraries WHERE org=?').all(actor.orgId);
  const visible=rows.filter(r=>r.scope==='personal'?r.owner===actor.employeeId:actor.role==='admin'||r.owner===actor.employeeId||JSON.parse(String(r.members)).includes(actor.employeeId));
  const publishedCount=(libraryId:string)=>Number(db.prepare("SELECT COUNT(*) AS n FROM kb_documents WHERE library=? AND status='published'").get(libraryId)?.n??0);
  const view=(r:typeof rows[number])=>({...r,members:JSON.parse(String(r.members)),editable:r.scope==='personal'?r.owner===actor.employeeId:actor.role==='admin',count:actor.role==='admin'||r.scope==='personal'?db.prepare('SELECT COUNT(*) AS n FROM kb_documents WHERE library=?').get(String(r.id))?.n:publishedCount(String(r.id))});
  if(action==='list')return {ok:true,libraries:visible.map(view),role:actor.role};
  const library=visible.find(r=>r.id===input.id);
  if(action==='save'){
   if(input.id&&!library)return fail('知识库不存在或无权访问','NOT_FOUND');
   if(library&&input.baseUpdated!==undefined&&input.baseUpdated!==library.updated)return fail('知识库已更新，请重新打开后修改','CONFLICT');
   const scope=library?.scope??input.scope;
   if(!['enterprise','personal'].includes(String(scope)))return fail('知识库类型无效');
   if(scope==='enterprise'&&actor.role!=='admin')return fail('企业知识库由管理员维护','FORBIDDEN');
   if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)return fail('名称需要 1–100 个字符');
   const members=scope==='personal'?[]:input.members??[];
   if(!Array.isArray(members)||members.length>200||members.some(m=>typeof m!=='string'||!db.prepare("SELECT employee_id FROM employees WHERE employee_id=? AND org_id=? AND status='active'").get(m,actor.orgId)))return fail('成员必须是本组织的有效员工编号');
   const id=String(library?.id??randomUUID());
   const unique=[...new Set(members)];
   db.prepare('INSERT INTO kb_libraries VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,members=excluded.members,updated=excluded.updated').run(id,actor.orgId,library?.owner??actor.employeeId,String(scope),input.name.trim(),JSON.stringify(unique),Math.max(now(),Number(library?.updated??0)+1));
   if(scope==='enterprise') syncAcl(db,actor.orgId,aclGroup(id),unique);
   return {ok:true,id};
  }
  if(!library)return fail('知识库不存在或无权访问','NOT_FOUND');
  if(action==='read')return readLibrary(db,actor,library,view(library));
  if(library.scope==='enterprise'&&actor.role!=='admin')return fail('企业知识库由管理员维护','FORBIDDEN');
  if(action==='document-review')return reviewDocument(db,actor,library,input,now);
  if(action==='document-save'){
   if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120||typeof input.body!=='string'||!input.body.trim()||input.body.length>48000||input.body.includes('\0'))return fail('文档需要标题及不超过 48000 字的文本正文');
   const old=db.prepare('SELECT * FROM kb_documents WHERE id=? AND library=?').get(String(input.documentId??''),String(library.id));
   if(input.documentId&&!old)return fail('文档不存在','NOT_FOUND');
   if(old&&input.revision!==old.revision)return fail('文档已更新，请重新打开后修改','CONFLICT');
   const size=db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(length(body)),0) AS total FROM kb_documents WHERE library=?').get(String(library.id));
   if((!old&&Number(size?.n)>=500)||Number(size?.total)-String(old?.body??'').length+input.body.length>2_000_000)return fail('知识库最多 500 份文档，总正文最多 200 万字');
   const id=String(old?.id??randomUUID());
   const revision=Number(old?.revision??0)+1;
   const personal=library.scope!=='enterprise';
   const sourceDocId=personal?null:String(old?.source_doc_id??`src-${id.replaceAll('-','')}`);
   const wikiPageId=personal?null:String(old?.wiki_page_id??`kb-${id.replaceAll('-','')}`);
   const status=personal?'published':'pending';
   db.exec('BEGIN IMMEDIATE');
   try {
    db.prepare('INSERT INTO kb_documents (id,library,title,body,revision,updated,status,source_doc_id,wiki_page_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,revision=excluded.revision,updated=excluded.updated,status=excluded.status').run(id,String(library.id),input.title.trim(),input.body,revision,now(),status,sourceDocId,wikiPageId);
    if(!personal&&sourceDocId&&wikiPageId){
     db.prepare(`INSERT INTO knowledge_docs (doc_id,org_id,title,format,version,body,acl_group,status,created_at) VALUES(?,?,?,'markdown',1,?,?, 'active',?) ON CONFLICT(doc_id) DO UPDATE SET title=excluded.title,body=excluded.body,version=knowledge_docs.version+1,status='active'`).run(sourceDocId,actor.orgId,input.title.trim(),input.body,aclGroup(String(library.id)),now());
     db.prepare('DELETE FROM wiki_published WHERE page_id=?').run(wikiPageId);
     db.prepare(`INSERT INTO wiki_pages (page_id,revision,org_id,title,body,source_doc_ids,status,author_id,created_at) VALUES(?,?,?,?,?,?,'pending',?,?)`).run(wikiPageId,revision,actor.orgId,input.title.trim(),input.body,JSON.stringify([sourceDocId]),actor.employeeId,now());
    }
    db.prepare('UPDATE kb_libraries SET updated=? WHERE id=?').run(now(),String(library.id));
    db.exec('COMMIT');
   } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原异常 */ }
    const message=error instanceof Error?error.message:'文档保存失败';
    return fail(message);
   }
   return {ok:true,id,revision,status,sourceDocId};
  }
  return fail('未知知识库操作');
 };
}

function aclGroup(libraryId:string): string {
  return `kb-${libraryId.replaceAll('-','')}`;
}

function syncAcl(db:DatabaseSync, orgId:string, group:string, members:string[]): void {
  db.prepare('DELETE FROM knowledge_acl WHERE org_id=? AND acl_group=?').run(orgId, group);
  for (const member of members) db.prepare('INSERT INTO knowledge_acl (org_id,acl_group,employee_id) VALUES(?,?,?)').run(orgId, group, member);
}

function readLibrary(db:DatabaseSync, actor:Actor, library:Record<string,unknown>, view:Record<string,unknown>): KnowledgeResult {
  const documents=db.prepare('SELECT id,library,title,body,revision,updated,status,source_doc_id AS sourceDocId,wiki_page_id AS wikiPageId FROM kb_documents WHERE library=? ORDER BY title,id').all(String(library.id)) as Array<Record<string,unknown>>;
  if (library.scope!=='enterprise' || actor.role==='admin') return {ok:true,library:view,documents,pendingCount:documents.filter(doc=>doc.status==='pending').length};
  const published=documents.filter(doc=>doc.status==='published');
  for (const doc of published) {
    const source=db.prepare('SELECT status FROM knowledge_docs WHERE doc_id=? AND org_id=?').get(String(doc.sourceDocId??''), actor.orgId) as {status?:string}|undefined;
    if (!source || source.status!=='active') return fail('来源原文失效，阻断派生页','CONFLICT');
    const pointer=db.prepare('SELECT revision FROM wiki_published WHERE page_id=? AND org_id=?').get(String(doc.wikiPageId??''), actor.orgId) as {revision?:number}|undefined;
    if (!pointer || pointer.revision!==doc.revision) return fail('未审或未发布的 Wiki 不可见','NOT_FOUND');
  }
  return {ok:true,library:view,documents:published,pendingCount:documents.length-published.length};
}

function reviewDocument(db:DatabaseSync, actor:Actor, library:Record<string,unknown>, input:Record<string,unknown>, now:()=>number): KnowledgeResult {
  if (actor.role!=='admin'||library.scope!=='enterprise') return fail('企业知识库由管理员审核','FORBIDDEN');
  if (input.decision!=='approve'&&input.decision!=='reject') return fail('审核决定无效');
  const doc=db.prepare('SELECT * FROM kb_documents WHERE id=? AND library=?').get(String(input.documentId??''), String(library.id)) as Record<string,unknown>|undefined;
  if (!doc) return fail('文档不存在','NOT_FOUND');
  if (doc.status!=='pending') return fail('文档不在待审状态','CONFLICT');
  const source=db.prepare('SELECT status FROM knowledge_docs WHERE doc_id=? AND org_id=?').get(String(doc.source_doc_id??''), actor.orgId) as {status?:string}|undefined;
  if (input.decision==='approve' && (!source || source.status!=='active')) return fail('来源原文不可用，阻断发布','CONFLICT');
  const status=input.decision==='approve'?'published':'rejected';
  const docId=String(doc.id??'');
  const pageId=String(doc.wiki_page_id??'');
  const revision=Number(doc.revision);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE kb_documents SET status=?,updated=? WHERE id=?').run(status, now(), docId);
    db.prepare('UPDATE wiki_pages SET status=? WHERE page_id=? AND revision=?').run(status, pageId, revision);
    if (input.decision==='approve') db.prepare('INSERT INTO wiki_published (page_id,org_id,revision) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET revision=excluded.revision').run(pageId, actor.orgId, revision);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 保留原异常 */ }
    return fail(error instanceof Error?error.message:'审核失败');
  }
  return {ok:true,id:docId,status};
}

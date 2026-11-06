import {createHash} from 'node:crypto';
/** Execution state lives with chat data; it is never included in metadata logs. */
export function createTaskCheckpoints(db){
 db.exec(`CREATE TABLE IF NOT EXISTS chat_task_plans(user_message TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS chat_document_drafts(user_message TEXT PRIMARY KEY,body TEXT NOT NULL);`);
 const read=(table,id)=>{const r=db.prepare(`SELECT body FROM ${table} WHERE user_message=?`).get(id);return r?JSON.parse(r.body):null;};
 const save=(table,id,value)=>db.prepare(`INSERT INTO ${table} VALUES(?,?) ON CONFLICT(user_message) DO UPDATE SET body=excluded.body`).run(id,JSON.stringify(value));
 return {plan:id=>read('chat_task_plans',id),savePlan:(id,v)=>save('chat_task_plans',id,v),draft:id=>read('chat_document_drafts',id),saveDraft:(id,v)=>save('chat_document_drafts',id,v),clearDraft:id=>db.prepare('DELETE FROM chat_document_drafts WHERE user_message=?').run(id)};
}
export function requestFingerprint(serviceId,request){
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const {purpose,serviceId:ignored,...parameters}=request;
 return createHash('sha256').update(JSON.stringify([serviceId,canonical(parameters)])).digest('hex');
}

import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, lstatSync, realpathSync, rmSync, constants } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';

export const documentHash = body => createHash('sha256').update(body).digest('hex');
function filename(text, body) {
  const explicit = text.match(/(?:^|[\s"'`：“”])([\p{L}\p{N}_\-][\p{L}\p{N}_\-.]{0,70}\.md)\b/iu)?.[1];
  const heading = body.match(/^#\s+(.+)$/m)?.[1];
  const title = (explicit || heading || '文档').replace(/\.md$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0,80).replace(/^\.+/, '') || '文档';
  return title + '.md';
}
export function createDocumentStore(db, dataDir, projectFolder = () => null) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_documents (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, actor TEXT NOT NULL, chat TEXT NOT NULL,
    message TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
    hash TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(document_id,revision));
    CREATE TABLE IF NOT EXISTS chat_document_requests(user_message TEXT PRIMARY KEY, actor TEXT NOT NULL, base_id TEXT, expected_hash TEXT);`);
  db.exec('CREATE TABLE IF NOT EXISTS document_roots(document_id TEXT PRIMARY KEY,root TEXT NOT NULL)');
  const root = join(dataDir, 'documents');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootReal = realpathSync(root);
  function owner(actor, chatId) { if (!db.prepare('SELECT id FROM chats WHERE id=? AND actor=?').get(chatId, actor)) throw Error('无权访问此聊天'); }
  function get(actor, id) { const row = db.prepare('SELECT * FROM chat_documents WHERE id=? AND actor=?').get(id, actor); if (!row) throw Error('文档不存在或无权访问'); return row; }
  function checkedPath(row) {
    const path=row.path;const savedRoot=db.prepare('SELECT root FROM document_roots WHERE document_id=?').get(row.document_id)?.root ?? rootReal;
    if(realpathSync(savedRoot)!==savedRoot)throw Error('文档目录已改变');
    const real = realpathSync(path), rel = relative(savedRoot, real);
    if (rel.startsWith('..') || isAbsolute(rel) || lstatSync(path).isSymbolicLink()) throw Error('文档路径已改变，请勿替换为链接');
    return real;
  }
  function read(actor, id) {
    const row = get(actor, id); const path = checkedPath(row);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let body; try { const size = lstatSync(path).size; if(size>512000)throw Error('文档超过预览上限');body=readFileSync(fd,'utf8'); } finally { closeSync(fd); }
    return { ...row, path, body, currentHash: documentHash(body), externalChange: documentHash(body) !== row.hash };
  }
  function list(actor, chatId) { owner(actor,chatId); return db.prepare('SELECT * FROM chat_documents WHERE actor=? AND chat=? ORDER BY created,revision').all(actor,chatId); }
  function plan(actor, chatId, userId, text, input) {
    owner(actor,chatId);
    const existing = db.prepare('SELECT * FROM chat_document_requests WHERE user_message=? AND actor=?').get(userId,actor);
    if(existing) { if(existing.base_id) { const base=read(actor,existing.base_id);if(base.currentHash!==existing.expected_hash)throw Error('文档已在外部修改，请刷新预览后重新提交修改'); return { base }; } return {}; }
    let base;
    if (input.documentId) {
      base = read(actor,input.documentId);
      if(base.chat!==chatId)throw Error('请在文档所属聊天中继续修改');
      if(base.currentHash!==input.expectedHash)throw Error('文档已变化，请刷新预览后重新提交修改');
      if(base.body.length>10000 || base.body.length+text.length>15000)throw Error('此文档超过对话编辑上限（10000字），请先拆分');
    } else return null;
    db.prepare('INSERT INTO chat_document_requests VALUES(?,?,?,?)').run(userId,actor,base?.id??null,base?.currentHash??null);
    return base ? { base } : {};
  }
  function create(actor, chatId, messageId, text, content, plan = {}) {
    owner(actor,chatId);
    const message = db.prepare("SELECT * FROM chat_messages WHERE id=? AND chat=? AND role='assistant' AND state='done'").get(messageId,chatId);
    if(!message)throw Error('仅能将完整回复保存为文档');
    const existing = db.prepare('SELECT * FROM chat_documents WHERE message=? AND actor=?').get(messageId,actor);
    if(existing)return existing;
    const body = content.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i,'$1');
    if(!body || body.length>128000)throw Error('文档正文为空或超限');
    if(plan.base && read(actor,plan.base.id).currentHash!==plan.base.currentHash)throw Error('生成期间原文档被外部修改，新回复已保留，请重新预览后修改');
    const documentId=plan.base?.document_id??randomUUID();
    const revision=Number(db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM chat_documents WHERE document_id=?').get(documentId).revision)+1;
    const name=plan.base?.name??(plan.filename ? filename("", "# "+plan.filename) : filename(text,body)), id=randomUUID();
    const savedRoot=db.prepare('SELECT root FROM document_roots WHERE document_id=?').get(documentId)?.root;
    const targetRoot=savedRoot??projectFolder(actor,chatId)??rootReal;
    if(realpathSync(targetRoot)!==targetRoot)throw Error('项目文件夹已改变');
    const dir=targetRoot===rootReal?join(root,actor,documentId,`r${revision}`):join(targetRoot,'CPclaw成果',documentId,`v${revision}`);
    if(targetRoot===rootReal)mkdirSync(dir,{recursive:true,mode:0o700});
    else {let parent=targetRoot;for(const part of ['CPclaw成果',documentId,`v${revision}`]){parent=join(parent,part);try{mkdirSync(parent,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}const st=lstatSync(parent);if(st.isSymbolicLink()||!st.isDirectory())throw Error('项目成果目录不能为链接');}}
    const rel=relative(targetRoot,realpathSync(dir));if(rel.startsWith('..')||isAbsolute(rel))throw Error('文档目录无效');
    const path=join(realpathSync(dir),name);let wrote=false;
    try {
      writeFileSync(path,body,{flag:'wx',mode:0o600});wrote=true;
      db.prepare('INSERT OR IGNORE INTO document_roots VALUES(?,?)').run(documentId,targetRoot);
      db.prepare('INSERT INTO chat_documents VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,documentId,actor,chatId,messageId,revision,name,path,documentHash(body),Date.now());
    }catch(error){if(wrote)rmSync(path,{force:true});throw error;}
    return get(actor,id);
  }
  function snapshot(actor,chatId,preferredId) {
    const latest=new Map();for(const row of list(actor,chatId))latest.set(row.document_id,row);
    let rows=[...latest.values()].slice(-12);
    if(preferredId){const selected=get(actor,preferredId);if(selected.chat!==chatId)throw Error('文档不属于当前聊天');rows=rows.filter(r=>r.document_id!==selected.document_id);rows.push(selected);rows=rows.slice(-12);}
    const captures=new Map();for(const row of rows){try{captures.set(row.id,read(actor,row.id));}catch(error){if(row.id===preferredId)throw error;}}
    const active=captures.get(preferredId)||[...captures.values()].at(-1);
    const context={files:[...captures.values()].map(r=>({id:r.id,name:r.name}))};
    if(active && active.body.length<=10000)context.active={id:active.id,name:active.name,body:active.body};
    return {context,captures};
  }
  return { list, read, plan, create, snapshot };
}

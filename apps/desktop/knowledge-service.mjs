import { randomUUID } from 'node:crypto';
import { realpathSync, statSync, readdirSync, openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';
import { join, relative, isAbsolute, basename } from 'node:path';

export function createKnowledgeStore(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS knowledge_links(id TEXT PRIMARY KEY,account TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,name TEXT NOT NULL,updated INTEGER NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL,UNIQUE(account,scope,kind,target));
 CREATE TABLE IF NOT EXISTS knowledge_index(link TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(link,path));
 CREATE TABLE IF NOT EXISTS knowledge_choices(chat TEXT NOT NULL,link TEXT NOT NULL,PRIMARY KEY(chat,link));`);
 const list=account=>db.prepare('SELECT l.*,(SELECT COUNT(*) FROM knowledge_index d WHERE d.link=l.id) AS count FROM knowledge_links l WHERE account=? ORDER BY updated DESC').all(account);
 function get(account,id){const r=db.prepare('SELECT * FROM knowledge_links WHERE account=? AND id=?').get(account,id);if(!r)throw Error('知识库未关联或无权访问');return r;}
 function root(link){const real=realpathSync(link.target);if(real!==link.target||!statSync(real).isDirectory())throw Error('目录已变化，请重新关联');return real;}
 function refresh(account,id){
  const link=get(account,id);if(link.kind!=='local')return link;
  try{
   const folder=root(link),queue=[{path:folder,depth:0}],docs=[];let entries=0,total=0;
   while(queue.length){const dir=queue.shift();for(const entry of readdirSync(dir.path,{withFileTypes:true})){
    if(++entries>10000)throw Error('目录超过 10000 个条目，请选择更小的目录');
    if(entry.name.startsWith('.')||entry.isSymbolicLink()||['node_modules','vendor','dist','build','coverage'].includes(entry.name))continue;
    const path=join(dir.path,entry.name);
    if(entry.isDirectory()){if(dir.depth>=8)throw Error('目录超过 8 层，请选择更小的目录');queue.push({path,depth:dir.depth+1});continue;}
    if(!entry.isFile()||! /\.(md|txt)$/i.test(entry.name))continue;
    const real=realpathSync(path),rel=relative(folder,real);if(rel.startsWith('..')||isAbsolute(rel))continue;
    const fd=openSync(real,constants.O_RDONLY|constants.O_NOFOLLOW);let body;
    try{const st=fstatSync(fd);if(!st.isFile()||st.size>512000)throw Error('单份文档不能超过 512KB：'+rel);total+=st.size;if(total>8*1024*1024||docs.length>=500)throw Error('知识库超过 500 份文档或 8MB，请缩小目录');body=readFileSync(fd,'utf8');}finally{closeSync(fd);}
    if(body.includes('\0'))continue;docs.push({path:rel,body});
   }}
   db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM knowledge_index WHERE link=?').run(id);const put=db.prepare('INSERT INTO knowledge_index VALUES(?,?,?)');for(const d of docs)put.run(id,d.path,d.body);db.prepare("UPDATE knowledge_links SET updated=?,status='ready',error='' WHERE id=?").run(Date.now(),id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
   return get(account,id);
  }catch(e){db.prepare("UPDATE knowledge_links SET status='error',error=? WHERE id=?").run(e.message,id);throw e;}
 }
 function link(account,input){
  if(!['enterprise','personal'].includes(input.scope)||!['local','platform'].includes(input.kind)||typeof input.target!=='string')throw Error('关联参数无效');
  const target=input.kind==='local'?realpathSync(input.target):input.target;
  if(input.kind==='local'&&!isAbsolute(target))throw Error('请选择文件夹');
  const old=list(account).find(r=>r.scope===input.scope&&r.kind===input.kind&&r.target===target);if(old)return refresh(account,old.id);
  const id=randomUUID();db.prepare("INSERT INTO knowledge_links VALUES(?,?,?,?,?,?,?,'ready','')").run(id,account,input.scope,input.kind,target,input.name||basename(target),0);
  try{return refresh(account,id);}catch(e){db.prepare('DELETE FROM knowledge_links WHERE id=?').run(id);throw e;}
 }
 function choices(account,chat){return db.prepare('SELECT l.id FROM knowledge_links l JOIN knowledge_choices c ON c.link=l.id WHERE l.account=? AND c.chat=?').all(account,chat).map(x=>x.id);}
 function choose(account,chat,ids){if(!Array.isArray(ids)||ids.length>12||new Set(ids).size!==ids.length)throw Error('最多选择 12 个知识库');for(const id of ids)get(account,id);db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM knowledge_choices WHERE chat=?').run(chat);for(const id of ids)db.prepare('INSERT INTO knowledge_choices VALUES(?,?)').run(chat,id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 function unlink(account,id){get(account,id);db.exec('BEGIN IMMEDIATE');try{for(const table of ['knowledge_index','knowledge_choices'])db.prepare(`DELETE FROM ${table} WHERE link=?`).run(id);db.prepare('DELETE FROM knowledge_links WHERE id=?').run(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 function mark(account,id,{name,status='ready',error=''}){const l=get(account,id);db.prepare('UPDATE knowledge_links SET name=?,status=?,error=?,updated=? WHERE id=?').run(name??l.name,status,error,Date.now(),id);}
 function localDocuments(account,id){const l=get(account,id);root(l);if(l.status!=='ready')throw Error('知识库更新失败，请更新成功后使用');return db.prepare('SELECT path AS id,path AS title,body FROM knowledge_index WHERE link=? ORDER BY path').all(id);}
 function entry(account,id,path){const l=get(account,id);if(l.kind!=='local'||!db.prepare('SELECT path FROM knowledge_index WHERE link=? AND path=?').get(id,path))throw Error('文档不存在');const folder=root(l),file=realpathSync(join(folder,path)),rel=relative(folder,file);if(rel.startsWith('..')||isAbsolute(rel))throw Error('文档超出知识库目录');return file;}
 return {list,get,link,refresh,choices,choose,unlink,localDocuments,entry,mark};
}

export function knowledgeSnippets(documents,query,budget=4000){
 const terms=[...new Set([...new Intl.Segmenter('zh',{granularity:'word'}).segment(query.toLowerCase())].filter(s=>s.isWordLike&&s.segment.length>1).map(s=>s.segment))].slice(0,32);
 const hits=[];
 for(const d of documents){let best=-1,score=0;const lines=d.body.split(/\r?\n/);for(let i=0;i<lines.length;i++){const n=terms.filter(t=>lines[i].toLowerCase().includes(t)).length;if(n>score){score=n;best=i;}}if(!score&&!terms.some(t=>d.title.toLowerCase().includes(t)))continue;const start=Math.max(0,best-1);hits.push({...d,body:undefined,score,lineStart:start+1,lineEnd:Math.min(lines.length,start+6),excerpt:lines.slice(start,start+6).join('\n').slice(0,850)});}
 hits.sort((a,b)=>b.score-a.score);let context='';const sources=[];
 for(const hit of hits.slice(0,6)){const block=`\n[知识库资料 ${sources.length+1}] ${hit.libraryName} / ${hit.title}:L${hit.lineStart}-L${hit.lineEnd}\n${hit.excerpt}\n`;if(context.length+block.length>budget)continue;context+=block;sources.push(hit);}
 return {context,sources};
}

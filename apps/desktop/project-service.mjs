import { randomUUID } from 'node:crypto';
import { realpathSync, statSync, readFileSync, openSync, closeSync, fstatSync, constants, readdirSync, lstatSync } from 'node:fs';
import { basename, relative, isAbsolute, join } from 'node:path';

export function createProjectStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,actor TEXT NOT NULL,name TEXT NOT NULL,folder TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(actor,folder));
    CREATE TABLE IF NOT EXISTS project_chats(chat TEXT PRIMARY KEY REFERENCES chats(id),project TEXT NOT NULL REFERENCES projects(id));`);
  function get(actor,id) { const p=db.prepare('SELECT * FROM projects WHERE id=? AND actor=?').get(id,actor);if(!p)throw Error('项目不存在或无权访问');return p; }
  function folder(actor,id) { const p=get(actor,id);if(realpathSync(p.folder)!==p.folder||!statSync(p.folder).isDirectory())throw Error('项目文件夹已变化，请重新关联');return p.folder; }
  function create(actor,path) {
    if(typeof path!=='string'||!isAbsolute(path))throw Error('请选择本地文件夹');
    const root=realpathSync(path);if(!statSync(root).isDirectory())throw Error('请选择文件夹');
    const existing=db.prepare('SELECT * FROM projects WHERE actor=? AND folder=?').get(actor,root);if(existing)return existing;
    const id=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(id,actor,basename(root)||root,root,Date.now());return get(actor,id);
  }
  function assign(actor,chatId,projectId) {
    if(!db.prepare('SELECT id FROM chats WHERE id=? AND actor=?').get(chatId,actor))throw Error('无权访问此聊天');
    if(projectId){get(actor,projectId);db.prepare('INSERT INTO project_chats VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET project=excluded.project').run(chatId,projectId);}
    else db.prepare('DELETE FROM project_chats WHERE chat=?').run(chatId);
  }
  function forChat(actor,chatId) { return db.prepare('SELECT p.* FROM projects p JOIN project_chats pc ON pc.project=p.id JOIN chats c ON c.id=pc.chat WHERE c.id=? AND c.actor=? AND p.actor=?').get(chatId,actor,actor); }
  function entry(actor,id,path='') {
    const root=folder(actor,id);
    if(typeof path!=='string'||isAbsolute(path)||path.split(/[\\/]/).includes('..'))throw Error('文件超出项目文件夹');
    const target=join(root,path),parent=path?realpathSync(join(target,'..')):root;
    const rel=relative(root,parent);
    if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error('文件超出项目文件夹');
    lstatSync(target);return target;
  }
  function entries(actor,id,path='') {
    const target=entry(actor,id,path);
    if(lstatSync(target).isSymbolicLink())throw Error('不展开符号链接');
    return readdirSync(target,{withFileTypes:true}).map(item=>({name:item.name,path:path?path+'/'+item.name:item.name,directory:item.isDirectory(),symlink:item.isSymbolicLink()})).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name,'zh-CN'));
  }
  function readFile(actor,id,path) {
    const root=folder(actor,id);
    if(typeof path!=='string'||isAbsolute(path)||path.split(/[\\/]/).some(p=>p==='..'||p.startsWith('.')))throw Error('请选择项目内的非隐藏文本文件');
    const real=realpathSync(join(root,path)),rel=relative(root,real);
    if(rel.startsWith('..')||isAbsolute(rel))throw Error('文件超出项目文件夹');
    if(!/\.(md|txt|csv|json|ya?ml)$/i.test(real))throw Error('目前支持 Markdown、TXT、CSV、JSON 和 YAML 文本材料');
    const fd=openSync(real,constants.O_RDONLY|constants.O_NOFOLLOW);
    try { const st=fstatSync(fd);if(!st.isFile()||st.size>32000)throw Error('请选择不超过 32KB 的文本材料');const body=readFileSync(fd,'utf8');if(body.includes('\0')||body.length>10000)throw Error('材料不是文本或超过 10000 字，请先精简');return {path:rel,name:basename(real),body}; } finally {closeSync(fd);}
  }
  return {get,folder,create,assign,forChat,readFile,entry,entries,list:actor=>db.prepare('SELECT * FROM projects WHERE actor=? ORDER BY created DESC').all(actor)};
}

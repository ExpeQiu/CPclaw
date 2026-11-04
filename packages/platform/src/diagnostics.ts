import {createHash} from 'node:crypto';
import type {PlatformApp} from './app.js';
import {MAX_UPLOAD_BYTES} from './enterprise.js';

/** Store diagnostic evidence through the existing per-employee private upload transaction. */
export function uploadDiagnostic(app: PlatformApp, token: string, content: unknown, key: unknown) {
 const invalid=()=>({ok:false as const,code:'CONFIG_INVALID' as const,message:'诊断包形状、大小或脱敏检查未通过'});
 if(typeof content!=='string'||Buffer.byteLength(content)>MAX_UPLOAD_BYTES||typeof key!=='string')return invalid();
 let pack: Record<string,unknown>;
 try{pack=JSON.parse(content) as Record<string,unknown>;}catch{return invalid();}
 if(!pack||typeof pack!=='object'||Array.isArray(pack)||pack.schemaVersion!==1||pack.kind!=='diagnostic-pack'||!pack.report||!Array.isArray(pack.logs))return invalid();
 const allowed=new Set(['schemaVersion','kind','report','includedExtra','syncMeta','skillMeta','imMeta','app','recentChat','logs']);
 if(Object.keys(pack).some(k=>!allowed.has(k)))return invalid();
 const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
 const keys=(value:unknown,allowed:readonly string[]):value is Record<string,unknown>=>record(value)&&Object.keys(value).every(k=>allowed.includes(k));
 if(!keys(pack.report,['schemaVersion','runId','finishedAt','autoRepair','checks','versions'])||pack.report.autoRepair!==false||!Array.isArray(pack.report.checks)||!pack.report.checks.every(c=>keys(c,['id','status','summary','suggestion'])))return invalid();
 if(!pack.logs.every(row=>keys(row,['timestamp','level','service','event','message'])))return invalid();
 if(pack.recentChat){
  if(!keys(pack.recentChat,['chatId','messages','operations'])||!Array.isArray(pack.recentChat.messages)||!Array.isArray(pack.recentChat.operations))return invalid();
  if(!pack.recentChat.messages.every(m=>keys(m,['id','role','state','error']))||!pack.recentChat.operations.every(o=>keys(o,['step','service','action','ok','exitCode'])))return invalid();
 }
 const scan=(value:unknown,depth=0):boolean=>{
  if(depth>12)return true;
  if(typeof value==='string'){
   const text=value.replace(/(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\s*["']?\s*[:=]\s*["']?\[redacted\]/gi,'');
   return /Bearer\s+\S+|(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\s*["']?\s*[:=]|\/(?:Users|home)\/[^\s]+/i.test(text);
  }
  if(Array.isArray(value))return value.some(v=>scan(v,depth+1));
  if(value&&typeof value==='object')return Object.entries(value).some(([k,v])=>/^(?:authorization|cookie|accessToken|refreshToken|apiKey|password|secret)$/i.test(k)||scan(v,depth+1));
  return false;
 };
 if(scan(pack))return invalid();
 const sha=createHash('sha256').update(content).digest('hex');
 if(key!=='diag-'+sha)return invalid();
 const created=app.createUpload(token,{purpose:'artifact',contentSha256:sha,byteSize:Buffer.byteLength(content),idempotencyKey:sha});
 if(!created.ok)return created;
 const put=app.putUploadContent(token,created.upload.uploadId,content);
 if(!put.ok)return put;
 return app.completeUpload(token,created.upload.uploadId);
}

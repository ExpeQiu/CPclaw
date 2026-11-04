import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {runDoctor,exportDiagnosticPack,readCurrentAccountSession} from '@cpclaw/desktop-host';
import {sessionRefresher,platformBase} from './session-refresh.mjs';

export function redactDiagnostic(value) {
 return String(value??'').replace(/Bearer\s+[^\s"',]+/gi,'[redacted]')
  .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,'$1[redacted]')
  .replace(/\/(?:Users|Volumes|home)\/[^\s"'<>]+/g,'[local-path]')
  .replace(/https?:\/\/[^\s"<>]+/g,raw=>{try{const u=new URL(raw);u.username='';u.password='';u.search='';u.hash='';return u.origin+u.pathname;}catch{return '[url]';}});
}
const hash=text=>createHash('sha256').update(text).digest('hex');
const fail=(code,message)=>({ok:false,code,message});
export function createDiagnosticCenter({dataDir,chat,appVersion,fetcher=fetch,refresh=()=>sessionRefresher(dataDir).refresh(),actorNow=()=>readCurrentAccountSession(dataDir).session?.employeeId??'local-doctor'}={}) {
 const dir=join(dataDir,'diagnostics');
 const latestPath=actor=>join(dir,'latest-'+hash(actor)+'.json');
 function latest(actor){try{return JSON.parse(readFileSync(latestPath(actor),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return null;}}
 function current(actor){if(actor!==actorNow())throw Error('账号已变化，请重新操作');}
 async function collect(actor,input={}) {
  const report=runDoctor({dataDir,appVersion,grantedDirectories:[]});
  let recentChat=null;
  if(input.chatId){
   const history=await chat.dispatch('chat.history',actor,{chatId:input.chatId});
   if(!history.ok)return history;
   recentChat={chatId:input.chatId,messages:history.messages.slice(-8).map(m=>({id:m.id,role:m.role,state:m.state,error:redactDiagnostic(m.error).slice(0,300)})),
    operations:history.serviceSteps.slice(-40).map(s=>({step:s.step,service:s.service?.id,action:s.request?.action,ok:s.result?.ok,exitCode:s.result?.exitCode}))};
  }
  const exported=exportDiagnosticPack(dataDir,report,{includeExtra:input.includeExtra===true,extraScopes:input.includeExtra?['sync_meta']:[]});
  if(!exported.ok)return exported;
  const base=JSON.parse(readFileSync(join(dir,exported.fileName),'utf8'));
  const rows=[];
  for(const name of ['desktop-worker.log','desktop-ui.log','desktop-host.log']){
   try{
    const path=join(dataDir,'logs',name);
    if(statSync(path).size>4*1024*1024){rows.push({timestamp:new Date().toISOString(),level:'warn',service:'diagnostics',event:'log_size_limit',message:'部分日志超过采集大小上限，未包含'});continue;}
    for(const line of readFileSync(path,'utf8').split('\n').slice(-80)){
     try{const row=JSON.parse(line);if(row.fields?.chatId&&row.fields.chatId!==input.chatId)continue;
      rows.push({timestamp:String(row.timestamp||''),level:String(row.level||'info'),service:String(row.service||''),event:String(row.event||''),message:redactDiagnostic(row.message).slice(0,400)});
     }catch{}
    }
   }catch(e){if(e.code!=='ENOENT')rows.push({timestamp:'',level:'warn',service:'diagnostics',event:'log_read_failed',message:'部分日志无法读取'});}
  }
  const logs=rows.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).slice(-120);
  const pack=JSON.parse(redactDiagnostic(JSON.stringify({...base,app:{version:appVersion,...input.host},recentChat,logs})));
  const content=JSON.stringify(pack,null,2)+'\n',sha256=hash(content);
  const fileName=exported.fileName;
  current(actor);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,fileName),content,{mode:0o600});
  const snapshot={fileName,sha256,bytes:Buffer.byteLength(content),runId:report.runId};
  writeFileSync(latestPath(actor),JSON.stringify(snapshot),{mode:0o600});
  return {ok:true,...snapshot,report:pack.report,app:pack.app,logCount:logs.length,chat:recentChat};
 }
 async function cloud(actor,input) {
  current(actor);const base=platformBase(dataDir).replace(/\/$/,'');
  if(!base)return fail('AUTH_REQUIRED','请先配置平台并登录');
  const auth=await refresh();if(!auth.ok)return auth;
  current(actor);if(auth.employeeId!==actor||platformBase(dataDir).replace(/\/$/,'')!==base)return fail('AUTH_REQUIRED','账号或平台已变化');
  const snapshot=latest(actor);if(!snapshot)return fail('NOT_FOUND','请先运行诊断并生成诊断包');
  const request=async(path,options={})=>{
   const response=await fetcher(base+path,{...options,headers:{authorization:'Bearer '+auth.accessToken,'content-type':'application/json',...options.headers},signal:AbortSignal.timeout(20000)});
   const value=await response.json().catch(()=>({}));current(actor);
   if(platformBase(dataDir).replace(/\/$/,'')!==base)throw Error('平台已变化，请重新操作');
   if(!response.ok||!value.ok)throw Error(response.status===404?'当前平台尚未提供诊断包接口，请先更新平台。':value.message||'诊断包请求失败');
   return value;
  };
  if(input.action==='status'){
   if(!snapshot.uploadId||snapshot.platform!==base)return fail('NOT_FOUND','当前平台还没有此诊断包的上传回执');
   const result=await request('/v1/diagnostics/'+encodeURIComponent(snapshot.uploadId));
   return result.upload?.contentSha256===snapshot.sha256?result:fail('CONFLICT','云端回执与本机诊断包不一致');
  }
  const content=readFileSync(join(dir,snapshot.fileName),'utf8');
  if(hash(content)!==snapshot.sha256)return fail('CONFLICT','诊断包已变化，请重新运行诊断');
  const result=await request('/v1/diagnostics',{method:'POST',body:JSON.stringify({content,idempotencyKey:'diag-'+snapshot.sha256})});
  if(result.upload?.status!=='available'||result.upload.contentSha256!==snapshot.sha256)return fail('CONFLICT','云端尚未确认诊断包可用');
  current(actor);writeFileSync(latestPath(actor),JSON.stringify({...snapshot,uploadId:result.upload.uploadId,platform:base}),{mode:0o600});
  return result;
 }
 return {async dispatch(action,actor,input={}){
  current(actor);
  if(action==='check'||action==='export')return collect(actor,input);
  if(action==='upload'||action==='status')return cloud(actor,{...input,action});
  if(action==='file'){const snapshot=latest(actor);return snapshot?{ok:true,path:join(dir,snapshot.fileName)}:fail('NOT_FOUND','请先运行诊断');}
  return fail('SCHEMA_INVALID','未知诊断操作');
 }};
}

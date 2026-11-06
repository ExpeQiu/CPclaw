import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeEnv } from './runtime-env.mjs';
import { addAppDriver, attachAppSource } from './local-extensions.mjs';

export function packagePath(root, relative, directory=false) {
  if(typeof relative!=='string'||!relative||isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='..'||p==='.'))throw Error('TPCstore 包内路径无效');
  const base=realpathSync(root),target=realpathSync(resolve(base,relative));
  if(!target.startsWith(base+sep)||(directory?!statSync(target).isDirectory():!statSync(target).isFile()))throw Error('TPCstore 路径越界或类型不符');
  return target;
}
export function sourceRoot(dataDir) {
  try{return JSON.parse(readFileSync(join(dataDir,'tpcstore-source.json'),'utf8')).root;}catch{return null;}
}
export function runStoreJson(root,relative,args,{input,appData,signal}={}) {
  const entry=packagePath(root,relative);
  if(!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error('TPCstore argv 无效');
  return new Promise((resolveResult,reject)=>{
    const env=runtimeEnv();for(const k of Object.keys(env))if(/MINIMAX.*KEY|CPCLAW.*(TOKEN|SECRET|PASSWORD|KEY)/i.test(k))delete env[k];
    if(appData)env.TPCSTORE_APP_DATA=appData;
    const child=spawn(process.env.CPCLAW_NODE_BINARY||'node',[entry,...args],{cwd:realpathSync(root),env,shell:false,signal,stdio:['pipe','pipe','pipe']});
    let output='',over=false;const timer=setTimeout(()=>child.kill(),45000);
    child.stdout.on('data',b=>{output+=b;if(output.length>1024*1024){over=true;child.kill();}});child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>{});child.stdin.end(input===undefined?'':JSON.stringify(input));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);try{if(over)throw Error('TPCstore 返回过大');const result=JSON.parse(output);if(code!==0||result.ok!==true)throw Error(result.error?.message||'TPCstore 执行失败');resolveResult(result);}catch(e){reject(e);}});
  });
}
export async function discoverTpcstore(root,{signal}={}) {
  root=realpathSync(root);
  const result=await runStoreJson(root,'bin/tpcstore-cli.mjs',['apps','list','--json'],{signal});
  if(!Array.isArray(result.data?.apps))throw Error('TPCstore 目录结构无效');
  const ids=new Set();
  for(const app of result.data.apps){
    if(!app||app.protocol_version!=='1.0.0'||typeof app.app_id!=='string'||ids.has(app.app_id))throw Error('TPCstore 协议或应用标识无效');ids.add(app.app_id);
    packagePath(root,app.runtime?.entry);
    if(app.integration)packagePath(root,app.integration.root,true);
  }
  return {root,apps:result.data.apps};
}
export function rememberSource(dataDir,root){mkdirSync(dataDir,{recursive:true});writeFileSync(join(dataDir,'tpcstore-source.json'),JSON.stringify({root:realpathSync(root)}),{mode:0o600});}
export async function resolveTpcstoreApp(root,appId,{signal}={}) {
  const catalog=await discoverTpcstore(root,{signal});
  const manifest=catalog.apps.find(a=>a.app_id===appId);
  if(!manifest?.integration||manifest.stage==='design')throw Error('此应用尚无可用的本机连接适配器');
  // apps list performs TPCstore schema/registry/path/operation validation before returning.
  return {root:catalog.root,manifest};
}
export async function connectTpcstore(dataDir,root,appId,{signal}={}) {
  if(appId!=='tpcstore.cutpot')throw Error('当前宿主尚无此应用的连接适配');
  const {manifest,root:base}=await resolveTpcstoreApp(root,appId,{signal});
  const key=createHash('sha256').update(base+'\0'+appId).digest('hex').slice(0,20);
  const appData=join(dataDir,'app-runtimes',key);
  const connected=await runStoreJson(base,manifest.runtime.entry,manifest.integration.connect,{appData,signal});
  const url=new URL(connected.data?.webUrl);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.hash||url.search||connected.data.app_id!==appId)throw Error('适配器未返回有效的本机工作台');
  const health=await(await fetch(url.origin+'/api/health',{signal:AbortSignal.any([AbortSignal.timeout(2000),...(signal?[signal]:[])])})).json();
  if(appId!=='tpcstore.cutpot'||health.app!=='cutpot'||resolve(health.appRoot)!==resolve(appData))throw Error('应用服务身份或数据目录不匹配');
  signal?.throwIfAborted();
  const service=addAppDriver(dataDir,{root:packagePath(base,manifest.integration.root,true),title:'CutPot',pageUrl:url.href});
  const source={root:base,appId,appData};
  return {service:attachAppSource(dataDir,service.id,source),connection:connected.data};
}
export async function callTpcstore(service,request,{signal}={}) {
  const source=service.tpcstore;
  if(!source)throw Error('缺少 TPCstore 应用来源');
  const {manifest}=await resolveTpcstoreApp(source.root,source.appId,{signal});
  if(request.action==='discover') {
    const result=await runStoreJson(source.root,manifest.runtime.entry,manifest.runtime.discovery,{signal,appData:source.appData});
    return {ok:true,app:result.data,operations:manifest.operations,tools:[{action:'app_call',fields:['operation'],description:'调用清单中的只读 operation action；原生写操作可经获授权 terminal 执行'},{action:'terminal',fields:['command'],description:'原生 CLI；工作目录为应用目录，页面与 CLI 共用已连接数据。先用 read_file 读取应用文档；宿主注入 CUTPOT_URL/CUTPOT_DATA 指向已连接工程'}],connection:{webUrl:service.pageUrl,cliUrl:new URL(service.pageUrl).origin}};
  }
  if(request.action!=='app_call'||!manifest.operations.some(o=>o.action===request.operation))throw Error('操作未登记');
  return runStoreJson(source.root,manifest.runtime.entry,manifest.runtime.invoke,{signal,appData:source.appData,input:{schema_version:'1.0.0',operation:request.operation}});
}

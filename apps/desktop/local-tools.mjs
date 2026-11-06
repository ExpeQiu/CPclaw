import {runtimeEnv} from './runtime-env.mjs';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,statSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
function runTerminal(program,args,{cwd,env,signal,timeout,maxBuffer}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='',size=0,failure,killTimer;
    const stop=error=>{
      if(failure)return;failure=error;
      const kill=kind=>{try{if(process.platform==='win32')child.kill(kind);else if(child.pid)process.kill(-child.pid,kind);}catch{}};
      kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),250);killTimer.unref();
    };
    const abort=()=>stop(Object.assign(Error('命令已停止'),{killed:true}));
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const timer=setTimeout(()=>stop(Object.assign(Error('命令超时'),{killed:true})),timeout);
    const collect=(name,chunk)=>{size+=Buffer.byteLength(chunk);if(size>maxBuffer){stop(Object.assign(Error('输出超过上限'),{code:'OUTPUT_LIMIT'}));return;}if(name==='stdout')stdout+=chunk;else stderr+=chunk;};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    child.once('error',error=>{done();reject(Object.assign(error,{stdout,stderr}));});
    child.once('close',(code,exitSignal)=>{done();if(failure||code!==0)reject(Object.assign(failure||Error('命令退出'),{code:failure?.code??code,signal:exitSignal,stdout,stderr}));else resolve({stdout,stderr});});
  });
}
export const localService={id:'local-terminal',title:'本机文件与终端',type:'CLI',target:process.platform==='win32'?'powershell.exe':'/bin/zsh',builtin:true};
const inside=(root,path)=>{if(!root)return false;try{const rel=relative(realpathSync(root),path);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../');}catch{return false;}};
const insideAny=(roots,path)=>(roots||[]).some(root=>inside(root,path));
const underRoot=(root,path)=>{if(!root||!path)return false;if(inside(root,path))return true;const base=root.endsWith('/')?root:root+'/';return path===root||path.startsWith(base);};
export function workspaceRoots(context){
  if(Array.isArray(context.projectRoots)&&context.projectRoots.length)return context.projectRoots;
  if(context.projectRoot)return [context.projectRoot];
  if(context.workingDirectory)return [context.workingDirectory];
  return [];
}
export function isSensitivePath(path){
  const name=String(path).replace(/\\/g,'/');
  return /\/(\.ssh|\.aws|\.gnupg|\.kube|Keychains)(\/|$)/.test(name)||/\/id_rsa$/.test(name)||/\.(pem|p12|pfx)$/i.test(name);
}
function usesNetwork(command){
  return /https?:\/\//i.test(command)
    ||/\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ping|dig|nslookup)\b/i.test(command)
    ||/\bgit\s+(push|pull|fetch|clone|ls-remote|submodule)\b/i.test(command)
    ||/\b(npm|pnpm|yarn)\s+(install|i|add|update|ci|publish|dlx)\b/i.test(command)
    ||/\bpip3?\s+install\b/i.test(command)
    ||/\bbrew\s+install\b/i.test(command)
    ||/\b(docker|podman)\s+(pull|push|login)\b/i.test(command)
    ||/\bInvoke-WebRequest\b/i.test(command);
}
function isUnsafeCommand(command){
  return /\b(sudo|doas)\b/.test(command)
    ||/\brm\s+(-[^\s]*[rR][^\s]*[fF]|-[^\s]*[fF][^\s]*[rR]|--recursive)\b/.test(command)
    ||/\b(mkfs|shutdown|reboot|halt)\b/.test(command)
    ||/\bdiskutil\s+erase\b/.test(command)
    ||/\bdd\s+if=/.test(command)
    ||/\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh)\b/.test(command)
    ||/\bgit\s+push\b[\s\S]*--force|\bgit\s+push\s+-f\b/.test(command)
    ||/\bsecurity\s+(delete|dump|export)\b/.test(command)
    ||/\bchmod\s+777\b/.test(command)
    ||/(\.ssh|\.aws|\.gnupg|Keychains)/.test(command);
}
function commandEscapes(command,roots){
  if(/(^|[\s'"`=])\.\.(\/|\s|$)/.test(command))return true;
  for(const match of command.matchAll(/(?:^|[\s'"`=:])(\/[^\s'"`|;]+)/g)){
    if(!roots.some(root=>underRoot(root,match[1])))return true;
  }
  return false;
}
/** 工作区内的读写和常规命令留在沙箱内；外部改写与联网越界；破坏性、凭据和提权记为风险。 */
export function classifyCommand(command,cwd,roots){
  if(isUnsafeCommand(command))return 'unsafe';
  if(usesNetwork(command))return 'network';
  if(!insideAny(roots,cwd)||commandEscapes(command,roots))return 'external-write';
  return 'workspace';
}
export async function executeLocalTool({context,request,signal,authorize,run=runTerminal}) {
  signal.throwIfAborted();
  const cwd=realpathSync(resolve(context.workingDirectory||homedir(),request.cwd||'.'));
  if(!statSync(cwd).isDirectory())throw Error('工作目录不是文件夹');
  if(request.action==='discover')return {ok:true,cwd,projectRoot:context.projectRoot||null,capabilities:[
    {action:'read_file',fields:['path'],description:'读取 UTF-8 文本文件，最多 512KB'},
    {action:'write_file',fields:['path','content'],description:'写入 UTF-8 文本文件并校验，父目录须存在'},
    {action:'terminal',fields:['command','cwd?','timeoutMs?'],description:'执行通用终端命令；可读写本机文件和访问网络，服从对话权限模式'},
  ]};
  if(['read_file','write_file'].includes(request.action)) {
    if(typeof request.path!=='string'||!request.path||request.path.includes('\0'))throw Error('文件路径无效');
    const candidate=resolve(cwd,request.path);
    let path;try{path=realpathSync(candidate);}catch(e){if(e.code!=='ENOENT'||request.action!=='write_file')throw e;path=resolve(realpathSync(dirname(candidate)),basename(candidate));}
    const reading=request.action==='read_file';
    if(!reading&&(typeof request.content!=='string'||Buffer.byteLength(request.content)>512000))throw Error('文件正文需要是 512KB 以内的文本');
    const roots=workspaceRoots(context);
    const listed=Array.isArray(context.projectRoots);
    if(listed&&!insideAny(context.projectRoots,path))throw Object.assign(Error('该文件夹不在本项目可访问范围内'),{code:'OUT_OF_SCOPE'});
    const trusted=insideAny(roots,path);
    const risk=isSensitivePath(path)?'unsafe':reading?(trusted?'read':'external-read'):trusted?'workspace':'external-write';
    await authorize({risk,title:reading?'读取本机文件':'写入本机文件',message:`${reading?'读取':'写入'} ${path}`,detail:`文件：${path}\n${reading?'读取内容会提供给模型，用于当前任务。':trusted?'位于当前工作区，可直接修改。':`工作区外写入 ${Buffer.byteLength(request.content)} 字节；已有内容会被覆盖。`}`});
    signal.throwIfAborted();
    if(reading){const st=statSync(path);if(!st.isFile()||st.size>512000)throw Error('只支持 512KB 以内的普通文本文件');return {ok:true,path,content:readFileSync(path,'utf8')};}
    writeFileSync(path,request.content,'utf8');
    const expected=createHash('sha256').update(request.content).digest('hex'),actual=createHash('sha256').update(readFileSync(path)).digest('hex');
    return {ok:expected===actual,path,bytes:Buffer.byteLength(request.content),sha256:actual,verified:expected===actual};
  }
  if(request.action!=='terminal'||typeof request.command!=='string'||!request.command.trim()||request.command.length>32000||request.command.includes('\0'))throw Error('终端请求需要有效的 command 字符串；请使用顶层字段，例如 {"action":"terminal","command":"pwd"}，不要将 command 放入 args。');
  const timeout=request.timeoutMs??60000;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>300000)throw Error('终端超时范围为 100–300000 毫秒');
  const roots=workspaceRoots({...context,workingDirectory:context.workingDirectory||cwd});
  if(Array.isArray(context.projectRoots)&&!insideAny(context.projectRoots,cwd))throw Object.assign(Error('终端工作目录不在本项目可访问范围内'),{code:'OUT_OF_SCOPE'});
  const risk=classifyCommand(request.command,cwd,roots);
  await authorize({risk,title:'终端执行授权',message:request.purpose||'执行当前任务的终端命令',detail:`工作目录：${cwd}\n命令：\n${request.command}\n超时：${timeout} 毫秒\n判定：${risk==='workspace'?'工作区内常规命令':risk==='network'?'将访问网络':risk==='unsafe'?'检出风险操作':risk==='external-write'?'可能改写工作区外文件':'需确认'}`});
  signal.throwIfAborted();
  const program=process.platform==='win32'?'powershell.exe':'/bin/zsh';
  const args=process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',request.command]:['-c',request.command];
  try {
    const result=await run(program,args,{cwd,signal,timeout,maxBuffer:1024*1024,shell:false,windowsHide:true,env:{...Object.fromEntries(Object.entries(runtimeEnv()).filter(([k])=>!/(MINIMAX.*KEY|CPCLAW.*(TOKEN|SECRET|PASSWORD|KEY))/.test(k))),...(context.service?.tpcstore?{CUTPOT_URL:new URL(context.service.pageUrl).origin,CUTPOT_DATA:context.service.tpcstore.appData}:{})}});
    signal.throwIfAborted();return {ok:true,exitCode:0,stdout:result.stdout.slice(0,48000),stderr:result.stderr.slice(0,12000),cwd};
  } catch(error) {
    signal.throwIfAborted();return {ok:false,code:error.killed?'COMMAND_TIMEOUT':'COMMAND_FAILED',exitCode:typeof error.code==='number'?error.code:null,stdout:String(error.stdout??'').slice(0,48000),stderr:String(error.stderr??'').slice(0,12000),cwd,message:error.killed?'命令超时，结果可能部分完成，请先检查现状。':'命令未成功，请依据退出码及输出排查。'};
  }
}

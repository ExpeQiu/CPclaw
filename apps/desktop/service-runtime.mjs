import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, extname, resolve } from 'node:path';
const runFile = promisify(execFile);
const supported = /^(version|model( list| find)?|voice list|canvas (current|ls|use|create)|node (find|show|quote|run|create (image|video|audio|text)|edit (image|video|audio|text))|operation (status|wait)|resource (get|download)|auth (status|account|login|wait))$/;
export const dreaminaService = { id: 'dreamina', title: '即梦画布', type: 'CLI', target: join(homedir(), '.local', 'bin', process.platform==='win32'?'dreamina-canvas.exe':'dreamina-canvas'), builtin: true };
export function publicServices(connectors = []) {
  return [dreaminaService, ...connectors.filter(c => c.enabled && ['CLI', 'MCP'].includes(c.type)).map(c => ({ id: c.id, title: c.title, type: c.type, target: c.target }))];
}
// 服务回执是数据；凭据、临时访问地址不进入模型上下文、聊天历史或日志。
export function sanitizeServiceResult(value) {
  if (Array.isArray(value)) return value.map(sanitizeServiceResult);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/token|secret|password|authorization|cookie|device.?code|user.?code|verificationUriComplete|signed.?url|provider.?payload/i.test(k)).map(([k,v]) => [k, sanitizeServiceResult(v)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/((?:access[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]').replace(/https?:\/\/[^\s"<>]+/g, url => { try { const u = new URL(url); return u.username || u.password || (u.search && !(/^https:\/\/jimeng\.jianying\.com\//.test(url) && [...u.searchParams.keys()].every(k=>!/token|sign|auth|code|credential/i.test(k)))) ? '[临时访问地址已隐藏]' : url; } catch { return '[无效地址]'; } });
  return value;
}
export function serviceImageData(path,expected={}) {
  const info=statSync(path);if(!info.isFile()||info.size<12||info.size>12*1024*1024)throw Error('图片文件为空或超过预览限制');
  const bytes=readFileSync(path);
  if(expected.size!==undefined&&expected.size!==bytes.length)throw Error('下载文件大小与服务回执不一致');
  if(expected.sha256&&createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error('下载文件校验失败');
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
  if(!mime)throw Error('下载内容不是可预览的图片');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
function commandFacts(schema) {
  const result = [];
  function visit(c, path) { const next = [...path,c.name]; result.push({ command:next, summary:c.summary, reads:c.reads, writes:c.writes, arguments:c.arguments, flags:c.flags }); for (const child of c.subcommands??[]) visit(child,next); }
  for (const c of schema.subcommands??[]) visit(c,[]);
  return result;
}
export function createServiceRuntime({ dataDir, approve, isCurrent, notify = () => {}, run = runFile, fetcher = fetch, binaryPath = realpathSync, readBinary = readFileSync } = {}) {
  const sessions = new Map();
  const attempted = new Map();
  function check(context, signal) { signal.throwIfAborted(); if (!isCurrent(context)) throw Error('会话或账号已变化，已停止后续操作'); }
  async function consent(context, signal, details) {
    check(context,signal);
    const accepted = await approve({ ...details, signal });
    check(context,signal);
    if (!accepted) throw Object.assign(Error('用户拒绝授权，未执行该操作。'), { code:'DENIED' });
  }
  async function execute(context, request, signal) {
    const { service } = context;
    check(context,signal);
    if (!service || !['CLI','MCP'].includes(service.type)) throw Error('服务尚未提供执行接口');
    if (!request || !['discover','call'].includes(request.action)) throw Error('仅支持 discover 和 call');
    if (service.type === 'MCP') return mcp(context,request,signal);
    if (!isAbsolute(service.target) || /[\r\n\0]/.test(service.target)) throw Error('CLI 需要已配置程序的绝对路径');
    const executable = binaryPath(service.target), cwd = homedir();
    const fingerprint = createHash('sha256').update(readBinary(executable)).digest('hex');
    const assertBinary = () => { check(context,signal); if (fingerprint !== createHash('sha256').update(readBinary(executable)).digest('hex')) throw Error('CLI 程序已变化，请重新授权'); };
    const builtin = service.id === 'dreamina' && service.builtin === true;
    async function call(args, timeout=30_000) {
      assertBinary();
      const full = builtin ? ['--non-interactive','--format','json',...args] : args;
      let stdout;
      try { ({stdout} = await run(executable, full, { shell:false, cwd, signal, timeout, env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(MINIMAX.*KEY|CPCLAW.*(TOKEN|SECRET|PASSWORD|KEY))/.test(k))), maxBuffer:1024*1024, windowsHide:true })); }
      catch(e) {
        if (signal.aborted || e.killed || e.signal) throw e;
        for (const output of [e.stdout,e.stderr]) { try { const v=JSON.parse(output); if(v && typeof v.ok==='boolean') return v; } catch {} }
        throw Error('CLI 执行失败；已停止自动重试，请检查服务与网络。');
      }
      try { return JSON.parse(stdout); } catch { return {ok:true,output:stdout.slice(0,48000)}; }
    }
    async function authorized(args, purpose, before=()=>{}) {
      await consent(context,signal,{ title:'本机命令执行授权', message:`允许 ${service.title} 执行此操作吗？`, detail:`用途：${purpose}\n执行位置：当前电脑\n工作目录：${cwd}\n程序：${executable}\n参数：${JSON.stringify(builtin?['--non-interactive','--format','json',...args]:args)}\n\n授权方式：仅本次操作。关闭或 Escape 视为拒绝。` });
      before();return call(args);
    }
    if (request.action === 'discover') {
      if (!builtin) return sanitizeServiceResult(await authorized(['--help'],'读取此服务支持的命令与参数'));
      await consent(context,signal,{title:'本机命令执行授权',message:'允许读取即梦 CLI 的真实能力与登录状态吗？',detail:`程序：${executable}\n工作目录：${cwd}\n参数前缀：--non-interactive --format json\n依次执行：version、schema、auth status、auth account、canvas current\n只读取状态，不提交生成任务。授权方式：仅本次发现。`});
      const version=await call(['version']), schema=await call(['schema']), auth=await call(['auth','status']);
      const commands=commandFacts(schema.data??{});
      sessions.set(JSON.stringify([context.actorId,context.chatId,service.id]),{commands});
      if (!schema.ok || !auth.ok || !auth.data?.loggedIn) return sanitizeServiceResult({ok:false,version,auth,commands:commands.filter(c=>c.command[0]==='auth'),message:'请调用 auth login 启动官方授权；然后 auth wait（不传 device-code，由宿主保管），完成后重新 discover。'});

      return sanitizeServiceResult({ok:true,version,auth,account:await call(['auth','account']),current:await call(['canvas','current']),commands:commands.filter(c=>supported.test(c.command.join(' ')))});
    }
    const args=request.args;
    if (!Array.isArray(args) || !args.length || args.length>80 || args.some(x=>typeof x!=='string'||x.length>12000||x.includes('\0'))) throw Error('命令参数必须是字符串数组');
    if (!builtin) return sanitizeServiceResult(await authorized(args,request.purpose||'执行当前任务的服务操作'));
    const key=JSON.stringify([context.actorId,context.chatId,service.id]);
    const discovered=sessions.get(key);
    if (!discovered) throw Error('请先 discover 获取此版本的真实能力');
    const entry=discovered.commands.filter(c=>c.command.every((v,i)=>args[i]===v)).sort((a,b)=>b.command.length-a.command.length)[0];
    if(!entry)throw Error('当前 CLI 未声明此命令');
    const path=entry.command.join(' ');
    if(!supported.test(path))throw Error('此操作尚未接入执行权限，请选择支持的服务操作。');
    const permitted=new Set((entry.flags??[]).map(f=>'--'+f.name));
    for(const a of args.slice(entry.command.length)) if(a.startsWith('--') && (!permitted.has(a) || a.includes('=')))throw Error('当前 CLI 未声明该参数：'+a);
    if(args.some(a=>/^(--yes|--run|--credit-token|--credit-ceiling|--profile|--region|--output)$/.test(a)))throw Error('批准、区域及本地输出路径由宿主管理；生成请使用 node run，下载不传 output。');
    if(args.includes('--force')||args.includes('--device-code'))throw Error('不得清除认证；设备授权引用由宿主保管');
    let actual=[...args];
    const ids=flag=>actual.flatMap((v,i)=>v===flag?[actual[i+1]]:[]);
    const projectId=ids('--project-id')[0];
    if(/^(node|operation|resource) /.test(path)&&!projectId)throw Error('请使用当前任务已确认的 --project-id，不依赖全局画布选择');
    if(path==='canvas create'&&!projectId)actual.push('--project-id',randomUUID());
    if(/^node (create|edit) /.test(path)) {
      if(!ids('--node-id').length)actual.push('--node-id','node_'+randomUUID().replaceAll('-',''));
      if(!ids('--update-id').length)actual.push('--update-id',randomUUID());
    }
    if(path==='auth wait'){if(!discovered.deviceCode)throw Error('请先启动一次 auth login');actual=['auth','wait','--device-code',discovered.deviceCode,'--timeout','20s'];}
    if(path==='operation wait') { if(!ids('--timeout').length)actual.push('--timeout','30s'); }
    if(path==='resource download') {
      const output=join(dataDir,'service-artifacts',createHash('sha256').update(context.actorId).digest('hex').slice(0,16),context.chatId);
      mkdirSync(output,{recursive:true,mode:0o700});actual.push('--output',output);
    }
    if(path==='node run') {
      const nodeIds=ids('--node-id');
      if(!nodeIds.length||new Set(nodeIds).size!==nodeIds.length)throw Error('请提供不重复的节点 ID');
      const identity=JSON.stringify([context.actorId,context.chatId,projectId,nodeIds]);
      const prior=attempted.get(identity)??readAttempt(identity);
      if(prior) return {ok:false,requiredAction:'resume',message:'这些节点已有提交记录。请用原 submitId 查询 operation status/wait；不自动重跑。',items:prior.items};
      const pairs=nodeIds.flatMap(id=>['--node-id',id]);
      const scope=['--project-id',projectId,...pairs];
      const quote=await authorized(['node','quote',...scope],'读取实际生成报价');
      const q=quote.data;
      if(!quote.ok||!Number.isSafeInteger(q?.totalMaxCredits)||q.totalMaxCredits<0||q.confirmable===false||!q.items?.length||q.items.some(i=>i.error||!Number.isSafeInteger(i.maxCredits)))return sanitizeServiceResult({ok:false,quote,message:'报价不完整，未提交生成。'});
      const amount=q.totalMaxCredits;
      await consent(context,signal,{title:'生成积分授权',message:`允许本次生成，积分上限 ${amount} 吗？`,detail:`服务：${service.title}\n画布：${projectId}\n节点：${nodeIds.join('、')}\n逐项报价：${JSON.stringify(q.items)}\n总上限：${amount} 积分\n程序：${executable}\n将依次执行：node confirm ${JSON.stringify(scope)} --credit-ceiling ${amount}；node run 同一画布和节点（由宿主生成稳定提交编号）。\n授权仅覆盖本次生成；最新报价超过上限时停止。关闭或 Escape 不会提交。`});
      const confirmed=await call(['node','confirm',...scope,'--credit-ceiling',String(amount)]);
      const token=confirmed.data?.creditConfirmationToken;
      if(!confirmed.ok||typeof token!=='string'||!token)return sanitizeServiceResult({ok:false,confirmation:confirmed,message:'积分批准未成功，未提交生成。'});
      const submitIds=nodeIds.map(()=>randomUUID());
      const record={projectId,items:nodeIds.map((nodeId,i)=>({nodeId,submitId:submitIds[i]}))};
      attempted.set(identity,record);writeAttempt(identity,record);
      actual=['node','run',...scope,...submitIds.flatMap(id=>['--submit-id',id]),'--credit-token',token];
      // token 始终留在本机内存，不进入回执、模型或持久状态。
      let result;try{result=await call(actual);}catch(error){error.recovery=record;throw error;}
      return sanitizeServiceResult({...result,recovery:record});
    }
    const isSave=path==='canvas create'||/^node (create|edit) /.test(path);
    const writeKey=JSON.stringify(['save',context.actorId,context.chatId,context.taskId??'',service.id,args]);
    const recovery={projectId:actual[actual.indexOf('--project-id')+1],...(actual.includes('--node-id')?{nodeId:actual[actual.indexOf('--node-id')+1]}:{}),...(actual.includes('--update-id')?{updateId:actual[actual.indexOf('--update-id')+1]}:{})};
    if(isSave){const prior=readAttempt(writeKey);if(prior)return {ok:false,requiredAction:'inspect',message:'该保存已有执行记录，请先回读原画布或节点；不自动新建副本。',recovery:prior};}
    let result;
    try{result=await authorized(actual,request.purpose||entry.summary,()=>{if(isSave)writeAttempt(writeKey,recovery);});}
    catch(error){if(isSave&&readAttempt(writeKey))error.recovery=recovery;throw error;}
    if(isSave)result={...result,recovery};
    if(path==='auth login'){const c=result.data?.challenge;if(c?.deviceCode){discovered.deviceCode=c.deviceCode;const url=c.verificationUriComplete||c.verificationUri;notify({type:'authorization',url,userCode:c.userCode,actorId:context.actorId,chatId:context.chatId});return {ok:result.ok,status:'awaiting_login',message:'已启动官方授权，请用户在浏览器完成后调用 auth wait；勿重复 auth login。'};}}
    if(path==='resource download'&&result.ok&&typeof result.data?.path==='string') {
      const path=resolve(result.data.path),root=resolve(dataDir,'service-artifacts');
      if(!path.startsWith(root+'/'))throw Error('下载路径超出本机成果目录');
      const dataUrl=serviceImageData(path,result.data);notify({type:'image',path,dataUrl,actorId:context.actorId,chatId:context.chatId});
    }
    return sanitizeServiceResult(result);
  }
  const attemptPath=identity=>join(dataDir,'service-jobs',createHash('sha256').update(identity).digest('hex')+'.json');
  function writeAttempt(identity,record){mkdirSync(join(dataDir,'service-jobs'),{recursive:true,mode:0o700});writeFileSync(attemptPath(identity),JSON.stringify(record),{mode:0o600});}
  function readAttempt(identity){const p=attemptPath(identity);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;}
  async function mcp(context,request,signal) {
    const {service}=context;const url=new URL(service.target);
    if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol))throw Error('服务地址无效');
    const key=JSON.stringify([context.actorId,context.chatId,service.id,service.target]);
    let session=sessions.get(key);
    await consent(context,signal,{title:'服务调用授权',message:`允许调用 ${service.title} 吗？`,detail:`服务地址：${url.href}\n操作：${request.action==='discover'?'初始化并读取工具目录':request.tool}\n参数：${JSON.stringify(request.arguments??{})}\n数据将发送给该服务，回执会交给 CPclaw 的模型服务以完成当前任务。授权方式：仅本次操作。`});
    async function rpc(method,params,notification=false) {
      check(context,signal);
      const response=await fetcher(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(session?.id?{'Mcp-Session-Id':session.id}:{}),...(session?.version?{'MCP-Protocol-Version':session.version}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:randomUUID()}),method,params}),signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)])});
      if(!response.ok)throw Error(`服务返回 ${response.status}，请检查连接或登录授权`);
      if(response.headers.get('mcp-session-id')){session??={};session.id=response.headers.get('mcp-session-id');}
      if(notification||response.status===202)return {};
      const reader=response.body?.getReader();if(!reader)throw Error('服务未返回正文');
      let raw='';const decoder=new TextDecoder();let result;
      try{while(true){const chunk=await reader.read();raw+=decoder.decode(chunk.value,{stream:!chunk.done});if(raw.length>512000)throw Error('服务回执超限');if(response.headers.get('content-type')?.includes('text/event-stream')){for(const block of raw.split(/\r?\n\r?\n/).slice(0,-1)){const text=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(text){const item=JSON.parse(text);if(item.id!==undefined){result=item;break;}}}if(result)break;}if(chunk.done){result??=JSON.parse(raw);break;}}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(result?.error)throw Error('服务拒绝请求：'+String(result.error.code));
      if(!result?.result)throw Error('服务未返回有效 MCP 结果');
      return result.result;
    }
    if(request.action==='discover') {
      const init=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'CPclaw',version:'0.0.19'}});
      if(!init.protocolVersion||!init.serverInfo)throw Error('MCP 握手无效');
      session??={};session.version=init.protocolVersion;await rpc('notifications/initialized',{},true);
      let tools=[],cursor;for(let page=0;page<5;page++){const r=await rpc('tools/list',cursor?{cursor}:{});tools.push(...(r.tools??[]));cursor=r.nextCursor;if(!cursor)break;}
      session.tools=tools;sessions.set(key,session);
      return sanitizeServiceResult({ok:true,serverInfo:init.serverInfo,tools,truncated:Boolean(cursor)});
    }
    if(!session?.tools?.some(t=>t.name===request.tool)||!request.arguments||typeof request.arguments!=='object'||Array.isArray(request.arguments))throw Error('请先发现此服务的真实工具，并提交对象参数');
    const result=await rpc('tools/call',{name:request.tool,arguments:request.arguments});return sanitizeServiceResult({ok:result.isError!==true,...result});
  }
  return {execute,clear(){sessions.clear();}};
}

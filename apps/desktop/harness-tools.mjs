import {createHash} from 'node:crypto';
import {sanitizeServiceResult} from './service-runtime.mjs';
const str={type:'string'},num={type:'integer'},flag={type:'boolean'},strings={type:'array',items:str},object={type:'object',additionalProperties:true};
const titles={list_resources:'查看关联资源',read_resource:'读取关联资料',discover_service:'发现服务能力',read_file:'读取文件',write_file:'写入文件',terminal:'执行终端命令',call_cli:'调用应用',call_mcp:'调用服务工具',deliver_document:'提交文档段落',register_document:'登记已有文档',submit_result:'提交结构化结果',read_tool_result:'读取结果后续内容'};
const tool=(name,description,properties,required=[])=>({name,title:titles[name]||name,description,parameters:{type:'object',properties,required,additionalProperties:false}});
/** 问答取证顺序：可访问文件夹 → 已关联知识库 → 互联网补充。 */
export const answerRetrievalRule='问答时按此顺序取证，前一层已经足够回答就停止，不把没读到的内容说成已查过：1. 先检索本项目可访问文件夹，只用 list_resources 里 project.roots 的路径，通过 read_file 或 read_resource(kind=project)；名单外的路径会被拒绝。没有关联项目则跳过。2. 再检索本聊天已关联的知识库，用 read_resource(kind=knowledge)；没有关联知识库则跳过。3. 前两层仍不够时，才用 terminal 做互联网检索作为补充，并在回答中标明网络来源。没查到就说明未找到，不编造。';
export const pipelineTools=[
 tool('diagnostic_inspect','只读检查本聊天指定请求；省略 requestId 时检查本轮输入之前的运行。scope 指定关注范围，报告保留完整证据。不重新生成。',{requestId:str,scope:{type:'string',enum:['task','model','services','delivery','environment']}}),
 tool('diagnostic_repair','执行检查返回的宿主动作 actionId；仅恢复已有成果或重装已绑定技能。不能传入权限或任意命令。',{actionId:str},['actionId']),
 tool('diagnostic_verify','按修复 receiptId 回读验证；verified 才表示该项修复通过，不代表整个任务完成。',{receiptId:str},['receiptId']),
 tool('list_resources','列出本聊天显式关联的项目、资料、知识库、技能、成果和可用服务，不授予额外权限。',{}),
 tool('read_resource','读取明确资源；结果按字符偏移分页。问答先读 kind=project 的可访问文件夹，再读 kind=knowledge 的已关联知识库。history 仅限本聊天；knowledge 的 id 为已关联库 ID，path 为文档 ID。',{kind:{type:'string',enum:['context','history','execution','project','knowledge','skill','document','draft','input','result']},id:str,path:str,offset:num,limit:num},['kind']),
 tool('discover_service','发现指定服务的实际能力和参数。',{serviceId:str},['serviceId']),
 tool('read_file','问答时优先读取本项目可访问文件夹中的文件，返回原文及 SHA-256。路径必须在 project.roots 内。',{path:str},['path']),
 tool('write_file','通过宿主文件权限写入文件。',{path:str,content:str},['path','content']),
 tool('terminal','通过宿主授权执行终端命令。互联网检索只在可访问文件夹和已关联知识库都不够回答时使用，并标明网络来源。',{command:str,cwd:str,timeoutMs:num},['command']),
 tool('call_cli','按已发现 schema 调用指定 CLI；本机终端请使用 terminal。',{serviceId:str,args:strings},['serviceId','args']),
 tool('call_mcp','调用指定 MCP 服务已发现的工具。',{serviceId:str,tool:str,arguments:object},['serviceId','tool','arguments']),
 ...['open','snapshot','click','type','scroll','press'].map(action=>tool('browser_'+action,'按 browser-page 发现结果执行 '+action+'，敏感操作必须由宿主确认。',{serviceId:str,url:str,ref:str,text:str,direction:str,amount:num,key:str},[])),
 tool('deliver_document','提交 Markdown 文档的一段。每份文档用稳定 documentKey，part 从0递增；complete=true 时原子发布全文。每段建议1200字以内，可多次提交；sourceId 修改已有文件时必须同时提供 expectedHash。不要把已提交段落重复发送。',{documentKey:str,filename:str,sourceId:str,expectedHash:str,part:num,content:str,complete:flag},['documentKey','filename','part','content','complete']),
 tool('register_document','将明确的已有 Markdown 文件登记为本聊天成果快照。先读取文件取得 SHA-256 expectedHash；宿主重新授权读取、核对版本并保存原文，不修改源文件。',{path:str,filename:str,expectedHash:str},['path','filename','expectedHash']),
 tool('submit_result','向显式功能请求提交结构化结果；只提交已完成的内容。',{value:object},['value']),
 tool('read_tool_result','按稳定引用读取大工具结果的后续页。',{id:str,offset:num,limit:num},['id']),
];
export function validateArguments(schema,value){
 if(schema.type==='object'){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('参数必须为对象');for(const k of schema.required||[])if(!Object.hasOwn(value,k))throw Error('缺少参数 '+k);for(const [k,v]of Object.entries(value)){if(schema.properties?.[k])validateArguments(schema.properties[k],v);else if(schema.additionalProperties===false)throw Error('未知参数 '+k);}}
 else if(schema.type==='array'){if(!Array.isArray(value))throw Error('参数必须为数组');for(const v of value)validateArguments(schema.items,v);}
 else if(schema.type==='integer'){if(!Number.isSafeInteger(value))throw Error('参数必须为整数');}
 else if(typeof value!==schema.type)throw Error('参数类型无效');
 if(schema.enum&&!schema.enum.includes(value))throw Error('参数枚举无效');
}
const hash=v=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x)).digest('hex');
export function resourcePage(value,{offset=0,limit=8000}={}){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>16000)throw Error('分页范围无效');const text=typeof value==='string'?value:JSON.stringify(value);return {content:text.slice(offset,offset+limit),offset,totalChars:text.length,nextOffset:offset+limit<text.length?offset+limit:null};}
/** Stable SDK call identities deduplicate delivery, never same-parameter new calls. */
export function createToolPipe({db,actor,chatId,messageId,signal,handle,record=()=>{}}){
 db.exec('CREATE TABLE IF NOT EXISTS kernel_tool_receipts(actor TEXT,chat TEXT,call_id TEXT,fingerprint TEXT,state TEXT,body TEXT,PRIMARY KEY(actor,chat,call_id))');
 return async call=>{
  signal.throwIfAborted();const spec=pipelineTools.find(t=>t.name===call?.name);
  if(!spec||typeof call.callId!=='string'||!/^[A-Za-z0-9._:-]{1,512}$/.test(call.callId))return {ok:false,code:'TOOL_SCHEMA_INVALID',message:'工具或调用标识无效'};
  try{validateArguments(spec.parameters,call.arguments);}catch(e){return {ok:false,code:'TOOL_SCHEMA_INVALID',message:e.message};}
  const fingerprint=hash([call.name,call.arguments]),prior=db.prepare('SELECT * FROM kernel_tool_receipts WHERE actor=? AND chat=? AND call_id=?').get(actor,chatId,call.callId);
  if(prior){if(prior.fingerprint!==fingerprint)return {ok:false,code:'CALL_ID_CONFLICT',message:'同一调用标识对应不同参数，未执行'};if(prior.state!=='done')return {ok:false,code:'TOOL_OUTCOME_UNKNOWN',message:'原调用结果未确认，未重复执行'};return expose(JSON.parse(prior.body),call.callId);}
  db.prepare('INSERT INTO kernel_tool_receipts VALUES(?,?,?,?,?,?)').run(actor,chatId,call.callId,fingerprint,'running','');record({callId:call.callId,name:call.name,state:'running'});
  try{
   let result;
   if(call.name==='read_tool_result'){const row=db.prepare("SELECT body FROM kernel_tool_receipts WHERE actor=? AND chat=? AND call_id=? AND state='done'").get(actor,chatId,call.arguments.id);if(!row)throw Error('结果不存在或无权访问');result={ok:true,...resourcePage(row.body,call.arguments)};}
   else result=await handle(call.name,call.arguments,call.callId);
   const safe=sanitizeServiceResult(result??{ok:true}),body=JSON.stringify(safe);if(body.length>4_000_000)throw Error('工具结果超过存储上限');
   db.prepare("UPDATE kernel_tool_receipts SET state='done',body=? WHERE actor=? AND chat=? AND call_id=?").run(body,actor,chatId,call.callId);record({callId:call.callId,name:call.name,state:safe.ok===false?'error':'done',result:safe});return expose(safe,call.callId);
  }catch(error){record({callId:call.callId,name:call.name,state:'unknown'});return {ok:false,code:'TOOL_OUTCOME_UNKNOWN',message:'工具未取得完成回执，请核实原调用；'+error.message};}
 };
 function expose(value,id){const body=JSON.stringify(value);return body.length<=16000?value:{ok:value.ok!==false,resultRef:id,...resourcePage(body)};}
}
export function createDocumentDelivery({db,documents,actor,chatId,messageId,onArtifact=()=>{},onDraft=()=>{}}){
 db.exec('CREATE TABLE IF NOT EXISTS kernel_document_drafts(actor TEXT,chat TEXT,document_key TEXT,body TEXT,PRIMARY KEY(actor,chat,document_key))');
 return {list:()=>db.prepare('SELECT document_key,body FROM kernel_document_drafts WHERE actor=? AND chat=?').all(actor,chatId).map(r=>({key:r.document_key,...JSON.parse(r.body)})),
  async deliver(args,callId){
   if(!/^[\w.-]{1,80}$/.test(args.documentKey)||!args.filename.endsWith('.md')||args.filename.length>120||/[<>:"/\\|?*\x00-\x1f]/.test(args.filename)||args.filename.startsWith('.')||args.part<0||!args.content) return {ok:false,code:'DOCUMENT_INVALID',message:'文件名、段序或正文无效'};
   const old=db.prepare('SELECT body FROM kernel_document_drafts WHERE actor=? AND chat=? AND document_key=?').get(actor,chatId,args.documentKey),draft=old?JSON.parse(old.body):{filename:args.filename,sourceId:args.sourceId||'',expectedHash:args.expectedHash||'',parts:[],complete:false,messageId};
   if(draft.filename!==args.filename||draft.sourceId!==(args.sourceId||'')||draft.expectedHash!==(args.expectedHash||''))return {ok:false,code:'DOCUMENT_TARGET_CHANGED',message:'文档目标或版本不能在分段中改变'};
   if(draft.complete)return {ok:false,code:'DOCUMENT_ALREADY_COMMITTED',message:'此文档标识已提交，修改请使用新标识和 sourceId'};
   if(args.part!==draft.parts.length)return {ok:false,code:'DOCUMENT_PART_CONFLICT',message:'需要段序 '+draft.parts.length};
   let base;if(draft.sourceId){base=documents.read(actor,draft.sourceId);if(base.chat!==chatId||!draft.expectedHash||base.currentHash!==draft.expectedHash)return {ok:false,code:'DOCUMENT_VERSION_CONFLICT',message:'原文档版本已改变，未提交'};}
   if(draft.parts.join('').length+args.content.length>128000)return {ok:false,code:'DOCUMENT_LIMIT',message:'文档超过长度上限'};
   draft.parts.push(args.content);
   if(args.complete){try{const artifact=documents.create(actor,chatId,messageId,'',draft.parts.join(''),{filename:args.filename,base,toolCall:callId});draft.complete=true;draft.artifact=artifact;onArtifact(artifact);}catch(e){draft.parts.pop();return {ok:false,code:'ARTIFACT_SAVE_FAILED',message:e.message};}}
   db.prepare('INSERT INTO kernel_document_drafts VALUES(?,?,?,?) ON CONFLICT(actor,chat,document_key) DO UPDATE SET body=excluded.body').run(actor,chatId,args.documentKey,JSON.stringify(draft));
   onDraft();
   return {ok:true,documentKey:args.documentKey,part:args.part,committed:draft.complete,...(draft.artifact?{artifact:draft.artifact}:{})};
  }};
}

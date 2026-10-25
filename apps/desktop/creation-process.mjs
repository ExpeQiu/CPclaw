import {createHash} from 'node:crypto';
import {sanitizeServiceResult} from './service-runtime.mjs';
const privateKey=/token|secret|password|authorization|cookie|api.?key|device.?code|user.?code|verificationUriComplete/i;
export function cleanProcessData(value,{skill=false}={}){
 if(Array.isArray(value))return value.map(v=>cleanProcessData(v,{skill}));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!privateKey.test(k)&&(!skill||!/^(userId|teamId|path|credentialStorage|expiresAt)$/i.test(k))).map(([k,v])=>[k,cleanProcessData(v,{skill})]));
 if(typeof value!=='string')return value;
 let text=value;
 try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object')return JSON.stringify(cleanProcessData(parsed,{skill}));}catch{}
 text=String(sanitizeServiceResult(text)).replace(/((?:access[_-]?token|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,'$1[已隐藏]');
 if(skill)text=text.replace(/\bnode_[a-zA-Z0-9_-]+\b/g,'<node_id>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'<id>').replace(/\/(?:Users|home|tmp|private)\/[^\s"'`]+/g,'<本机路径>');
 return text;
}
function boundedJson(value,limit){const text=JSON.stringify(value,null,2);return text.length<=limit?text:text.slice(0,limit)+'\n…（回执过长，已截断；可在操作面板查看完整记录）';}
export function creationProcess({goal,summary,steps}){
 if(!steps.length)throw Error('本轮没有实际应用执行记录，不能保存为创作过程');
 const lines=['# 创作过程','','## 本轮需求','',cleanProcessData(goal),'','## 执行记录','', '以下来自本轮服务回执；接口受理不代表生成完成，积分报价也不等于最终结算。'];
 for(const step of steps){lines.push('',`### ${step.step}. ${step.service.title}`,'',`操作：${cleanProcessData(step.request.purpose||step.request.tool||step.request.args?.slice(0,3).join(' ')||'发现服务能力')}`,'','````json',boundedJson(cleanProcessData({request:step.request,result:step.result}),Math.min(10000,Math.floor(85000/steps.length))),'````');}
 lines.push('','## AI 总结（仅供参考，以执行回执为准）','',cleanProcessData(summary));
 return lines.join('\n').slice(0,120000);
}
export function skillMaterial({goal,summary,steps}){
 const count=Math.max(1,steps.length),requestLimit=Math.max(80,Math.floor(4500/count)),resultLimit=Math.max(40,Math.floor(1800/count));
 const text=(value,limit)=>{const s=typeof value==='string'?value:JSON.stringify(value);return s.length<=limit?s:s.slice(0,limit)+'…[已截断，使用时重新发现能力]';};
 function facts(value,result=[]){
   if(result.length>=14)return result;
   if(Array.isArray(value)){for(const item of value.slice(0,5))facts(item,result);}
   else if(value&&typeof value==='object'){for(const [key,v]of Object.entries(value)){if(result.length>=14)break;if(/^(ok|state|status|code|reason|requiredAction|totalMaxCredits|maxCredits|projectId|nodeId|resourceId|submitId)$/i.test(key)&&['string','number','boolean'].includes(typeof v))result.push([key,v]);else if(v&&typeof v==='object')facts(v,result);}}
   return result;
 }
 const compact=steps.map(s=>{
   const clean=cleanProcessData(s,{skill:true});
   return {step:s.step,request:text(clean.request,requestLimit),result:text(facts(clean.result),resultLimit)};
 });
 return JSON.stringify({goal:text(cleanProcessData(goal,{skill:true}),800),summary:text(cleanProcessData(summary,{skill:true}),1200),services:[...new Map(steps.map(s=>[s.service.id??s.service.title,s.service])).values()],evidence:steps.length?'包含本轮真实工具回执，各步均保留；长参数按标记截断':'仅有对话内容，方法尚未经过工具执行验证',steps:compact});
}
export function skillDraftMetadata(messageId,goal){
 const slug='workflow-'+createHash('sha256').update(messageId).digest('hex').slice(0,12);
 return {slug,title:(goal.replace(/\s+/g,' ').trim().slice(0,48)||'创作流程')+' · Skill',description:'复用本轮任务记录中的工作方法；用户提出类似任务时，先核对工具能力与授权，再按步骤执行。'};
}
export function wrapSkillDraft(markdown,metadata){
 let body=markdown.trim().replace(/^```(?:markdown|md|yaml)?\s*\n([\s\S]*?)\n```$/i,'$1').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/,'').trim();
 if(!body||body.length>80000)throw Error('Skill 正文为空或超过草稿上限');
 return ['---','name: '+metadata.slug,'description: '+JSON.stringify(metadata.description),'version: "1.0.0"','owner: "cpclaw"','id: "skill-'+metadata.slug+'-'+new Date().getFullYear()+'"','disable-model-invocation: true','input_schema: {type: object, properties: {goal: {type: string}}, required: [goal]}','output_schema: {type: object, properties: {status: {type: string}, summary: {type: string}}, examples: [{status: awaiting_approval, summary: 等待用户授权}]}','errors: [{code: WORKFLOW_AUTH_REQUIRED, message: 执行权限或账号授权未就绪, resolution: 停止并按官方授权流程处理后继续原任务}]','side_effects: [生成工作产物；如需本机或外部服务操作必须按宿主规则取得授权]','---','',body].join('\n');
}

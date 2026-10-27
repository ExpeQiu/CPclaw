/** 平台资源契约；不包含 Harness 私有类型或用户授权。 */
export type SkillInput = { name: string; label: string; required: boolean; example: string };
export type SkillDependency = { service: string; title: string; required: boolean; type: 'CLI' | 'MCP' | 'internal' };
export type SkillExample = { title: string; input: string; output: string };
export type SkillMetadata = {
  category: string; tags: string[]; applicability: string; limitations: string; outputType: string;
  inputs: SkillInput[]; dependencies: SkillDependency[]; examples: SkillExample[];
  sections: string[]; platforms: string[]; changelog: string; license: string;
};
export type MarketItem = SkillMetadata & {
  id: string; skillId: string; owner: string; kind: 'skill' | 'expert'; title: string; description: string;
  body: string; version: string; source: string; origin: string; members: string[];
  status: string; note: string; updated: number; revision: number; digest: string;
  personalAvailable: boolean; featured: number;
};
export type SkillCheck = { code: string; status: 'pass' | 'warning' | 'error'; message: string };
export type SkillFile = { path: string; body: string };
export const skillVersionPattern = /^\d+\.\d+\.\d+$/;
export function compareSkillVersions(a: string, b: string): number {
  const left=a.split('.').map(Number), right=b.split('.').map(Number);
  for(let i=0;i<3;i++){const delta=(left[i]??0)-(right[i]??0);if(delta)return delta;}
  return 0;
}
export function skillFiles(body: string, source: string): SkillFile[] {
  if(source!=='upload')return [{path:'SKILL.md',body}];
  const parsed=JSON.parse(body) as {files?: SkillFile[]};
  if(!Array.isArray(parsed.files)||!parsed.files.length||parsed.files.length>50)throw Error('上传最多 50 个文本文件');
  const files=parsed.files;
  if(files.some(f=>typeof f.path!=='string'||!f.path||f.path.startsWith('/')||f.path.includes('\\')||f.path.split('/').some(p=>!p||p==='..'||p==='.'||p.startsWith('.'))||!/^[-\p{L}\p{N} _./]+$/u.test(f.path)||!/\.(md|txt|json|ya?ml)$/i.test(f.path)||typeof f.body!=='string'||f.body.includes('\0')))throw Error('上传含无效路径或非文本文件');
  if(new Set(files.map(f=>f.path.toLowerCase())).size!==files.length)throw Error('上传含重复文件路径');
  if(files.reduce((n,f)=>n+Buffer.byteLength(f.body,'utf8'),0)>100000)throw Error('上传正文总计不能超过 100KB');
  if(files.filter(f=>f.path.split('/').at(-1)==='SKILL.md'&&f.body.trim()).length!==1)throw Error('上传需要唯一且非空的 SKILL.md 入口');
  return files;
}
export function skillInstruction(item: Pick<MarketItem,'body'|'source'>): string {
  return skillFiles(item.body,item.source).find(f=>f.path.split('/').at(-1)==='SKILL.md')?.body??'';
}
export function readSkillMetadata(input: Record<string, unknown>): SkillMetadata {
  const text=(key:string,max=2000)=>{const v=input[key];if(v!==undefined&&typeof v!=='string')throw Error(key+' 必须为文本');if(typeof v==='string'&&v.length>max)throw Error(key+' 超过长度上限');return typeof v==='string'?v.trim():'';};
  const strings=(key:string,max=30)=>{const v=input[key];if(v===undefined)return [];if(!Array.isArray(v)||v.length>max||v.some(x=>typeof x!=='string'||x.length>100))throw Error(key+' 列表无效');return [...new Set(v as string[])];};
  const inputs=input.inputs??[],dependencies=input.dependencies??[],examples=input.examples??[];
  if(!Array.isArray(inputs)||inputs.length>20||inputs.some(p=>!p||typeof p!=='object'||typeof p.name!=='string'||!/^\w{1,40}$/.test(p.name)||typeof p.label!=='string'||p.label.length>100||typeof p.required!=='boolean'||typeof p.example!=='string'||p.example.length>4000)||new Set(inputs.map(p=>p.name)).size!==inputs.length)throw Error('输入参数配置无效');
  if(!Array.isArray(dependencies)||dependencies.length>20||dependencies.some(p=>!p||typeof p!=='object'||typeof p.service!=='string'||!p.service||p.service.length>100||typeof p.title!=='string'||p.title.length>100||typeof p.required!=='boolean'||!['CLI','MCP','internal'].includes(p.type)))throw Error('依赖配置无效');
  if(!Array.isArray(examples)||examples.length>10||examples.some(p=>!p||typeof p!=='object'||typeof p.title!=='string'||p.title.length>100||typeof p.input!=='string'||p.input.length>8000||typeof p.output!=='string'||p.output.length>12000))throw Error('样例配置无效');
  const platforms=strings('platforms',10);
  return {category:text('category',50)||'其他',tags:strings('tags'),applicability:text('applicability'),limitations:text('limitations'),outputType:text('outputType',100)||'Markdown',inputs:inputs.map(p=>({name:p.name,label:p.label,required:p.required,example:p.example})),dependencies:dependencies.map(p=>({service:p.service,title:p.title,required:p.required,type:p.type})),examples:examples.map(p=>({title:p.title,input:p.input,output:p.output})),sections:strings('sections'),platforms:platforms.length?platforms:['darwin-arm64'],changelog:text('changelog'),license:text('license',200)};
}
export function checkSkill(item: MarketItem): SkillCheck[] {
  const checks:SkillCheck[]=[];
  try {const packageBytes=Buffer.byteLength(skillPackage(item),'utf8');checks.push({code:'PACKAGE',status:packageBytes<=250000?'pass':'error',message:packageBytes<=250000?'发布包大小符合限制':'发布包（含元数据和样例）超过 250KB，请精简'});const instruction=skillInstruction(item);checks.push({code:'ENTRY',status:instruction.trim()?'pass':'error',message:instruction.trim()?'技能入口可读取':'技能正文为空'});checks.push({code:'CONTEXT',status:instruction.length<=6000?'pass':'error',message:instruction.length<=6000?'技能入口符合 6000 字上下文限制':'技能入口超过 6000 字，请精简'});
    if(/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,}/i.test(instruction))checks.push({code:'CREDENTIAL',status:'error',message:'可能包含凭据，请检查后移除'});
  }catch(error){checks.push({code:'ENTRY',status:'error',message:error instanceof Error?error.message:'技能入口无效'});}
  checks.push({code:'DESCRIPTION',status:item.description.trim()?'pass':'warning',message:item.description.trim()?'用途已填写':'建议填写用途说明'});
  checks.push({code:'EXAMPLES',status:item.examples.length?'pass':'warning',message:item.examples.length?'已提供样例（不代表执行验证）':'建议补充合成输入与输出样例'});
  if(item.source==='opensource'&&!item.license)checks.push({code:'LICENSE',status:'warning',message:'开源引入尚未填写许可，组织发布前需核对'});
  return checks;
}
export function checkSkillOutput(sections: string[], text: string): {status:'passed'|'failed'|'unverified';missing:string[]} {
  const headings=new Set(text.split('\n').filter(line=>/^#{1,6}\s+/.test(line)).map(line=>line.replace(/^#{1,6}\s+/,'').replace(/^\*\*|\*\*$/g,'').trim()));
  const missing=sections.filter(section=>!headings.has(section));
  return {status:!sections.length?'unverified':missing.length?'failed':'passed',missing};
}
export function skillPackage(item: MarketItem): string {
  const {id,skillId,version,title,description,kind,source,origin,members,category,tags,applicability,limitations,outputType,inputs,dependencies,examples,sections,platforms,changelog,license}=item;
  return JSON.stringify({schemaVersion:1,files:skillFiles(item.body,item.source),skill:{id,skillId,version,title,description,kind,source,origin,members,category,tags,applicability,limitations,outputType,inputs,dependencies,examples,sections,platforms,changelog,license}});
}

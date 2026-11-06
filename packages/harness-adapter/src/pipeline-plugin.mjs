import {readFileSync} from 'node:fs';
export const name='cpclaw-pipeline';export const inject=['tools'];
export function apply(ctx){
 const tools=JSON.parse(readFileSync(process.env.CPCLAW_TOOL_MANIFEST,'utf8'));
 for(const tool of tools){
  const parameters=Object.fromEntries(Object.entries(tool.parameters.properties||{}).map(([key,value])=>[key,{...value,...(tool.parameters.required?.includes(key)?{required:true}:{})}]));
  ctx.tools.register({name:tool.name,description:tool.description,parameters,output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
   async execute(args,exec){const response=await fetch(process.env.CPCLAW_TOOL_URL+'/tools',{method:'POST',headers:{authorization:'Bearer '+process.env.CPCLAW_LOOP_KEY,'content-type':'application/json'},body:JSON.stringify({name:tool.name,arguments:args,callId:String(exec.callId)})});if(!response.ok)throw Error('工具管道不可用');return response.text();}});
 }
}

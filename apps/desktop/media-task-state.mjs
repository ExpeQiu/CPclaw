import {localServiceImage} from './service-images.mjs';

const success=s=>['success','succeeded','completed'].includes(s);
const failure=s=>['failed','error','cancelled'].includes(s);
const flag=(args,name)=>args[args.indexOf(name)+1];
export function mediaTaskState(records,{dataDir,actorId,chatId}={}) {
  const resources=new Map(),operations=new Map();
  for(const record of records){
    if(record.service?.id!=='dreamina')continue;
    const request=record.request||{},args=Array.isArray(request.args)?request.args:[],result=record.result||{},data=result.data||{};
    const projectId=args.includes('--project-id')?flag(args,'--project-id'):request.projectId||result.recovery?.projectId;
    if(!projectId)continue;
    const put=(item,state,type)=>{
      if(typeof item.resourceId!=='string')return;
      const key=projectId+':'+item.resourceId,prior=resources.get(key)||{resourceId:item.resourceId,projectId,type:'unknown'};
      const nextState=item.state||item.status||state;
      resources.set(key,{...prior,...(type?{type}:{}),...(item.type?{type:item.type}:{}),...(nextState?{state:nextState}:{}),...(item.format&&/^(png|jpe?g|webp)$/i.test(item.format)?{type:'image'}:{})});
    };
    if(args[0]==='node'&&args[1]==='run'){
      for(const item of result.recovery?.items||[])if(item.submitId)operations.set(projectId+':'+item.submitId,{projectId,submitId:item.submitId,state:'unknown'});
      for(const item of data.items||[]){
        if(item.submitId)operations.set(projectId+':'+item.submitId,{projectId,submitId:item.submitId,state:item.state||'unknown'});
        for(const resource of item.resources||[])put(resource,item.state);
      }
    }
    if(args[0]==='operation'&&result.ok){
      const submitId=data.operationRef||args[2];
      if(submitId)operations.set(projectId+':'+submitId,{projectId,submitId,state:data.state||'unknown'});
      for(const item of data.resources||[])put(item,data.state);
    }
    if(args[0]==='resource'&&args[1]==='get'&&result.ok)put({...data,resourceId:data.resourceId||args[2]});
    if(args[0]==='node'&&args[1]==='show'&&result.ok){
      for(const node of [data.node,...(data.nodes||[]).map(n=>n.node)].filter(Boolean))for(const item of node.resources||[])put(item,node.status,node.type);
    }
    if((args[0]==='resource'&&args[1]==='download'||request.action==='recover_image')&&result.ok&&typeof data.path==='string'){
      const resourceId=request.resourceId||args[2];put({resourceId},'success','image');
      Object.assign(resources.get(projectId+':'+resourceId),{expected:{size:data.size,sha256:data.sha256},path:data.path,delivered:data.deliveryVerified===true&&data.preview?.state==='ready'});
    }
  }
  const images=[...resources.values()].filter(r=>r.type==='image').map(r=>{
    if(!dataDir)return r;
    try{return {...r,local:localServiceImage(dataDir,{actorId,chatId},{resourceId:r.resourceId,path:r.path,expected:r.expected}),localError:''};}
    catch(error){return {...r,delivered:false,localError:error.code==='ENOENT'?'本机尚无该图片文件':error.message};}
  });
  const generated=images.filter(r=>success(r.state)),pending=[...operations.values()].filter(o=>!success(o.state)&&!failure(o.state));
  const unknown=[...resources.values()].filter(r=>r.type==='unknown'&&!failure(r.state));
  const hasFailure=[...resources.values(),...operations.values()].some(r=>failure(r.state));
  const status=images.length&&images.every(r=>success(r.state)&&r.delivered&&(!dataDir||r.local))&&!pending.length&&!unknown.length&&!hasFailure?'delivered':pending.length||unknown.length?'pending':hasFailure?'failed':generated.length?'generated':'unknown';
  return {status,images,resources:[...resources.values()],operations:[...operations.values()],detail:status==='delivered'?`已恢复 ${images.length} 张图片的本机交付；原始执行错误保留。`:status==='generated'?`已确认 ${generated.length} 张图片生成成功，正在核实本机交付。`:status==='pending'?'已有生成提交或资源，需查询原任务状态；不会重新生成。':status==='failed'?`已有生成任务明确返回失败；已恢复 ${images.filter(i=>i.delivered).length} 张图片，未自动重新生成。`:'尚无可确认的图片生成终态。'};
}

export function mediaRecoveryText(task) {
  return `图片成果已恢复：${task.images.filter(i=>i.delivered).length} 张。未重新提交生成。\n\n`+
    task.images.filter(i=>i.delivered&&i.local).map(i=>`- 原图：${i.local.path}\n  文件已校验，预览已准备；可在应用操作面板查看和打开原图。`).join('\n')+
    '\n\n原始执行异常及工具回执已保留；恢复成果不代表其他请求内容已完成。';
}

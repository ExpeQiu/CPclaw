/** User-facing issue contract: cause, impact, preserved evidence and one concrete next action. */
export function taskIssue({error='',state='error',safeToRetry=false,hasServiceSteps=false,modelQuota=null,serviceAuthRequired=false}={}) {
  if(!error||state==='cancelled')return null;
  const saved=hasServiceSteps?(safeToRetry?'这轮仅有只读准备记录，尚无生成或写入提交；可继续原请求。':'已有操作记录已保存；恢复时先核实原任务，避免重复生成。'):'你的请求已保留；恢复后可继续原请求。';
  const base={severity:'blocking',popup:false,impact:'本轮已暂停，尚未确认任务完成。',preserved:saved,safeToRetry,hasServiceSteps,details:String(error).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,500),modelQuota};
  if(modelQuota&&modelQuota.availableTokens<Math.max(1,modelQuota.minimumRequestTokens||1)||/平台模型额度不足/.test(error))return {...base,code:'MODEL_QUOTA_EXHAUSTED',popup:true,title:'模型额度不足，任务已暂停',summary:modelQuota?.availableTokens===0?'平台模型可用额度已用完，暂时无法继续思考和执行。':'当前可用额度不足以发起下一次模型请求，任务已暂停。',impact:'申请新额度后可继续当前任务。即梦积分与模型tokens额度分别计算。',action:'quota',actionLabel:'申请新额度'};
  if(/并发位已满|并发已达上限/.test(error))return {...base,code:'MODEL_CONCURRENCY_FULL',severity:'temporary',title:'已有模型调用正在进行',summary:'当前并发位已占用，请等待已有调用结束。',action:'diagnose',actionLabel:'检查占用与恢复'};
  if(/网关返回 429/.test(error))return {...base,code:'MODEL_REQUEST_LIMITED',severity:'temporary',title:'模型请求暂时受限',summary:'平台拒绝了本次模型请求，需要核实额度或并发状态。',action:'diagnose',actionLabel:'检查额度与原因'};
  if(serviceAuthRequired||/oauth_scope_insufficient|服务端授权不足|OAuth.*不足/.test(error))return {...base,code:'SERVICE_AUTH_REQUIRED',popup:true,title:'即梦授权需要更新',summary:'即梦当前授权不足，无法继续读取或操作画布。',action:'diagnose',actionLabel:'检查并重新授权'};
  if(/登录凭证|请先.*登录|会话.*失效|登录会话不可用|AUTH_REQUIRED|SESSION_REVOKED/.test(error))return {...base,code:'SESSION_EXPIRED',popup:true,title:'登录已失效，请重新连接',summary:'当前平台会话不可用，任务进度已保留。',action:'login',actionLabel:'前往登录'};
  if(/图片.*(预览|解码)|超过预览限制/.test(error))return {...base,code:'IMAGE_DELIVERY_FAILED',title:'图片交付尚未完成',summary:'图片读取或预览遇到问题，需要先核实已有文件。',action:'diagnose',actionLabel:'查找并恢复图片'};
  if(/网关返回 50[234]|timeout|超时|fetch failed|断网|连接中断/i.test(error))return {...base,code:'CONNECTION_INTERRUPTED',severity:'temporary',title:'连接中断，任务未完成',summary:'模型或平台暂未正常响应，当前原因仍需检查。',action:safeToRetry?'retry':'diagnose',actionLabel:safeToRetry?'继续原请求':'检查原任务状态'};
  if(/模型步骤达到上限/.test(error))return {...base,code:'MODEL_STEP_LIMIT',title:'本轮执行已暂停',summary:'本轮推理步骤已用尽，需要核实当前进度后续接。',action:'diagnose',actionLabel:'检查进度并恢复'};
  return {...base,code:'TASK_INTERRUPTED',title:'任务遇到问题，进度已保留',summary:'本轮执行未完成，需要检查具体原因。',action:'diagnose',actionLabel:'运行自诊断'};
}

export function recoveredMediaIssue(task,previous=null){
  if(task?.status!=='delivered'||!task.images?.some(i=>i.delivered&&i.local))return previous;
  return {code:'MEDIA_RECOVERED',severity:'resolved',popup:false,title:'已有图片已恢复',summary:'已核实原图并恢复本机图片预览，可在右侧查看成果。',impact:'本机图片交付已恢复，原始执行异常保留在详情中。',preserved:'没有重新提交生成，原图与操作记录均已保留。',safeToRetry:false,hasServiceSteps:true,details:previous?.details||'',action:'diagnose',actionLabel:'查看恢复报告'};
}

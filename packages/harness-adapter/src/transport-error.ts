/** Never persist network error text: it can contain URLs, headers or credentials. */
const allowed=new Set(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EPIPE','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT']);
export function transportCode(error:unknown):string {
 const queue:unknown[]=[error];const seen=new Set<unknown>();
 for(let n=0;queue.length&&n<12;n++){const value=queue.shift();if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);const code=Reflect.get(value,'code');if(typeof code==='string'&&allowed.has(code))return code;queue.push(Reflect.get(value,'cause'));const errors=Reflect.get(value,'errors');if(Array.isArray(errors))queue.push(...errors.slice(0,4));}return '';
}
export function modelTransportFailure(error:unknown,stage:'model_connect'|'model_stream'){
 const code=stage==='model_connect'?'MODEL_CONNECTION_FAILED':'MODEL_STREAM_INCOMPLETE';
 const diagnostic={code,stage,outcome:'error',httpStatus:stage==='model_connect'?0:200,transportCode:transportCode(error)};
 return Object.assign(new Error(stage==='model_connect'?'模型连接失败；已保存的文件和回执保留，请核实原任务后继续。':'模型响应流中断；已保存的文件和回执保留，请核实原任务后继续。'),{code,diagnostic});
}

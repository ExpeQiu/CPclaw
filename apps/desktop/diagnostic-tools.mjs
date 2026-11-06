import {randomUUID} from 'node:crypto';
export const diagnosticScopes=['task','model','services','delivery','environment'];
const fail=(code,message)=>({ok:false,code,message});
// Tokens are issued by this host, scoped to actor/chat/request, single-use and short-lived.
export function createDiagnosticTools({inspect,fingerprint,repair,now=Date.now}) {
 const actions=new Map(),receipts=new Map();
 const allowed=new Set(['MEDIA_RESUME','SKILL_INSTALL_MISSING']);
 function retain(map,key,value){map.set(key,value);while(map.size>100)map.delete(map.keys().next().value);}
 function match(row,actor,input){return row&&row.actor===actor&&row.chatId===input.chatId&&row.expires>now();}
 async function call(name,actor,input,context={}) {
  if(name==='diagnostic_inspect'){
   if(input.scope&&!diagnosticScopes.includes(input.scope))return fail('SCHEMA_INVALID','未知诊断范围');
   const report=await inspect(actor,input,context);if(!report.ok)return report;
   const target={chatId:input.chatId,requestId:report.requestId};
   const stamp=fingerprint(actor,target,context);
   const repairActions=(report.repairActions||[]).map(a=>{
    if(!stamp||!a.runnable||a.needsConfirm||!allowed.has(a.code))return {...a,runnable:false,manualOnly:true};
    const actionId=randomUUID();retain(actions,actionId,{actor,...target,stamp,code:a.code,expires:now()+300000});return {...a,actionId};
   });
   const scope=input.scope||'task';
   const patterns={task:/.*/,model:/MODEL|HARNESS_GATEWAY|HARNESS_RATE|PLATFORM/,services:/SERVICE|CLI|SKILL|AUTH|LOCAL_TOOL/,delivery:/MEDIA|ARTIFACT/,environment:/KERNEL|PLATFORM|HARNESS_CLEANUP/};
   return {...report,scope,focusFindings:(report.findings||[]).filter(f=>patterns[scope].test(f.code)),repairActions};
  }
  if(name==='diagnostic_repair'){
   const row=actions.get(input.actionId);
   if(!match(row,actor,input))return fail('DIAGNOSTIC_ACTION_INVALID','修复动作不存在、已使用或已过期，请重新检查');
   if(fingerprint(actor,row,context)!==row.stamp)return fail('DIAGNOSTIC_EVIDENCE_CHANGED','运行证据已变化，请重新检查');
   actions.delete(input.actionId);
   const result=await repair(actor,{...row,code:row.code},context);
   const receiptId=randomUUID();retain(receipts,receiptId,{...row,result,expires:now()+300000});
   return {...result,receiptId,requestId:row.requestId};
  }
  if(name==='diagnostic_verify'){
   const row=receipts.get(input.receiptId);
   if(!match(row,actor,input))return fail('DIAGNOSTIC_RECEIPT_INVALID','修复回执不存在或已过期');
   const report=await inspect(actor,row,context);if(!report.ok)return report;
   const verified=row.result.ok===true&&row.result.repairs?.length>0&&row.result.repairs.every(r=>r.verified===true)&&!(report.repairActions||[]).some(a=>a.code===row.code&&a.runnable);
   return {ok:true,verified:Boolean(verified),requestId:row.requestId,receiptId:input.receiptId,report};
  }
  return fail('TOOL_UNSUPPORTED','未知诊断操作');
 }
 return {call};
}

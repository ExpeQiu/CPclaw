import {cleanRequestDiagnostic} from '@cpclaw/model-gateway';

const explanations={
 MODEL_OUTPUT_LIMIT:'模型达到输出长度上限，正文或工具参数尚未完成。',
 MODEL_STREAM_INCOMPLETE:'模型流未完整结束；现有证据无法进一步区分供应商中断与链路中断。',
 TOOL_FINISH_MISMATCH:'模型输出了工具调用，但结束状态与工具调用不一致。',
 TOOL_ARGUMENTS_INVALID:'模型工具参数无法解析或未通过校验，未交付该工具。',
 MODEL_EVENT_INVALID:'模型流包含无法解析的事件。',
 MODEL_STREAM_TIMEOUT:'等待模型流数据超时。',
 MODEL_HTTP_ERROR:'模型供应商返回非成功 HTTP 状态。',
 MODEL_CONNECTION_FAILED:'未能建立模型连接。',
 DELIVERY_FAILED:'模型结果交付阶段失败。',
 PLATFORM_PROCESS_INTERRUPTED:'云端进程退出时请求尚未结束，原执行结果需要核实。',
 LOCAL_SERVICE_FAILED:'本机应用工具调用未取得正常回执，不能据此认定外部操作没有发生。',
 HARNESS_FAILED:'内核执行失败；需结合已保存的模型调用和工具回执定位。',
 DESKTOP_PROCESS_INTERRUPTED:'桌面进程退出时请求尚未结束，原执行结果需要核实。',
};
export function evidenceFinding(evidence,hasServiceSteps){
 if(!evidence||!evidence.code||['done','running','cancelled'].includes(evidence.state))return null;
 const d=evidence.diagnostic||{};
 const details=[explanations[evidence.code]||'请求失败，以下为已记录的失败阶段。',`阶段：${evidence.stage||'unknown'}；请求：${evidence.requestId}`,
 d.finishReason?`模型结束状态：${d.finishReason}`:'',d.toolName?`工具：${d.toolName}；参数 ${d.toolArgumentBytes||0} 字节`:'',
 d.httpStatus?`模型 HTTP：${d.httpStatus}`:'',
 typeof d.reasoningChars==='number'?`模型输出：正文 ${d.textChars||0} 字符；推理 ${d.reasoningChars} 字符（仅记录数量）。`:'',
 hasServiceSteps?'已有工具操作回执；恢复前应核实原操作，避免重复执行。':evidence.route==='harness'?'已进入内核，缺少工具回执不能证明外部操作未发生。':'尚未进入内核，无本轮应用工具执行回执。'].filter(Boolean).join(' ');
 return {code:evidence.code,status:'error',detail:details};
}
/** One durable record per attempt. A retry never overwrites previous failure evidence. */
export function createRequestEvidence(db){
 db.exec(`CREATE TABLE IF NOT EXISTS chat_request_evidence(request TEXT PRIMARY KEY,chat TEXT NOT NULL,message TEXT NOT NULL,updated INTEGER NOT NULL,body TEXT NOT NULL)`);
 for(const row of db.prepare("SELECT request,body FROM chat_request_evidence WHERE json_extract(body,'$.state')='running'").all()){
  const v=JSON.parse(row.body);v.state='interrupted';v.code='DESKTOP_PROCESS_INTERRUPTED';v.finishedAt=Date.now();
  db.prepare('UPDATE chat_request_evidence SET body=?,updated=? WHERE request=?').run(JSON.stringify(v),Date.now(),row.request);
 }
 return {
  save(record){db.prepare('INSERT INTO chat_request_evidence VALUES(?,?,?,?,?) ON CONFLICT(request) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(record.requestId,record.chatId,record.messageId,Date.now(),JSON.stringify(record));},
  read(requestId){const row=db.prepare('SELECT body FROM chat_request_evidence WHERE request=?').get(requestId);return row?JSON.parse(row.body):null;},
  diagnostic:cleanRequestDiagnostic,
 };
}

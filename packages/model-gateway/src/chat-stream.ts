import {partialDocument} from './document-checkpoint.js';
import {fetchModel} from './model-retry.js';
import {newRequestDiagnostic,notifyDiagnostic,diagnosticCode,RequestDiagnosticError,type DiagnosticObserver} from './request-diagnostics.js';
import { serviceRequestTool, serviceSystemMessage, parseServiceRequest, documentTool, documentSystemMessage, parseDocumentDelivery, type DocumentTools } from "./document-tool.js";
import { createStreamDeadline } from "./stream-deadline.js";
import { readTokenUsage, type TokenUsage } from "@cpclaw/contracts";
import type { RealGatewayConfig } from "./index.js";

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** 增量解析供应商 SSE；忽略 reasoning，仅接受经校验的文档交付工具。 */
export async function streamChat(
  config: RealGatewayConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => Promise<void>,
  documents?: DocumentTools,
  onDiagnostic?: DiagnosticObserver,
): Promise<TokenUsage> {
  const finalDelivery=documents?.context.retryRoute==='document'||Boolean(documents?.context.draft);
  const deliveryTool=documents?.context.sectioned?documentTool:{...documentTool,function:{...documentTool.function,parameters:{...documentTool.function.parameters,properties:{filename:documentTool.function.parameters.properties.filename,content:documentTool.function.parameters.properties.content,sourceId:documentTool.function.parameters.properties.sourceId}}}};
  const record=newRequestDiagnostic(4096), started=Date.now();let lastData=started;
  const deadline = createStreamDeadline({ signal, idleMs: config.timeoutMs, label: "模型服务" });
  try {
    const response = await fetchModel(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "MiniMax-M3", messages: documents ? [{ role: "system", content: (documents.services&&!finalDelivery ? serviceSystemMessage(documents.services) : "") + documentSystemMessage(documents.context) }, ...messages] : messages, ...(documents ? { tools: [deliveryTool, ...(documents.services&&documents.context.retryRoute!=="document"&&documents.context.retryRoute!=="answer" ? [serviceRequestTool] : [])], tool_choice: documents.context.retryRoute==="document"?{type:"function",function:{name:"deliver_document"}}:documents.context.retryRoute==="answer"?"none":"auto", parallel_tool_calls: false } : {}), stream: true, stream_options: { include_usage: true }, thinking: { type: documents&&!finalDelivery ? "adaptive" : "disabled" }, ...(documents ? { reasoning_split: true } : {}), max_completion_tokens: 4096 }),
      signal: deadline.signal,
    },attempt=>{(record.attempts??=[]).push(attempt);},config.timeoutMs);
    deadline.touch();
    record.httpStatus=response.status;
    record.providerRequestId=(response.headers.get("x-request-id")||response.headers.get("request-id")||"").replace(/[^A-Za-z0-9._:-]/g,"").slice(0,128);
    record.stage="model_stream";
    if (!response.ok) throw new Error(`模型网关返回 ${response.status}`);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {record.code="MODEL_PROTOCOL_ERROR";throw new Error("模型未返回流式响应");}
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", data: string[] = [], finish: unknown, length = 0;
    let toolName="", toolArgs="", toolId="";
    let usage: TokenUsage = { state: "unknown" };
    async function dispatch(): Promise<void> {
      if (!data.length) return;
      const raw = data.join("\n"); data = [];
      if (raw === "[DONE]") {record.sawDone=true;return;}
      const event = JSON.parse(raw);
      if (event.error || (event.base_resp && event.base_resp.status_code !== 0)) {record.code="MODEL_PROVIDER_ERROR";throw new Error("模型流返回错误");}
      if (event.usage) usage = readTokenUsage(event.usage);
      const choice = event.choices?.[0];
      if(typeof choice?.delta?.reasoning_content==='string'){record.reasoningChars=(record.reasoningChars||0)+choice.delta.reasoning_content.length;if(documents)await documents.onActivity?.();}
      if (choice?.finish_reason != null) {finish = choice.finish_reason;record.finishReason=typeof finish==='string'&&/^[a-z_]{1,40}$/.test(finish)?finish:'';}
      const calls = choice?.delta?.tool_calls;
      if (calls !== undefined) {
        if (!documents || !Array.isArray(calls)) throw Error("模型返回未获支持的工具调用");
        for (const call of calls) {
          if (call.index !== 0 || (call.id && toolId && call.id !== toolId)) throw Error("每次回复仅允许交付一个文档");
          if (call.id) toolId=call.id;
          if (typeof call.function?.name === 'string') toolName+=call.function.name;
          if (typeof call.function?.arguments === 'string') toolArgs+=call.function.arguments;
          if (toolName.length>100 || toolArgs.length>1000000) {record.code="TOOL_ARGUMENTS_LIMIT";throw Error("文档工具参数超限");}
        }
        record.toolName=['deliver_document','request_service'].includes(toolName)?toolName:toolName?'unknown':'';
        record.toolArgumentBytes=Buffer.byteLength(toolArgs);
        await documents.onActivity?.();
      }
      const text = choice?.delta?.content;
      if (typeof text === "string" && text.length) {
        length += text.length;record.textChars=length;
        if (length > 128_000) throw new Error("模型回复超过长度限制");
        signal.throwIfAborted();
        await onDelta(text);
      }
    }
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.value?.length) {deadline.touch();lastData=Date.now();record.chunks++;record.responseBytes+=chunk.value.length;}
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length > 256_000) throw new Error("模型流事件过大");
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
          if (!line) await dispatch();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (chunk.done) {record.normalEof=true;break;}
      }
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).trim());
      await dispatch();
      signal.throwIfAborted();
      record.finishReason=typeof finish==='string'&&/^[a-z_]{1,40}$/.test(finish)?finish:'';
      record.textChars=length;record.toolName=['deliver_document','request_service'].includes(toolName)?toolName:toolName?'unknown':'';
      record.toolArgumentBytes=Buffer.byteLength(toolArgs);
      if(toolArgs){try{JSON.parse(toolArgs);record.toolJsonValid=true;}catch{record.toolJsonValid=false;}}
      if(finish==='length'){if(documents?.context.sectioned&&documents.onCheckpoint&&toolName==='deliver_document'){const draft=partialDocument(toolArgs,documents.context);if(draft)await documents.onCheckpoint(draft);}record.code='MODEL_OUTPUT_LIMIT';throw Error('模型回复达到长度上限，已保留可恢复的草稿，请续接原任务');}
      record.stage='tool_validate';
      if (finish === "tool_calls") {
        if(documents?.services && documents.onService && toolName==='request_service'){const request=parseServiceRequest(toolArgs,documents.services);record.stage='delivery';await documents.onService(request);record.outcome='done';return usage;}
        if (!documents || toolName !== 'deliver_document') {record.code='TOOL_UNSUPPORTED';throw Error("模型请求了未知文档工具");}
        const document=parseDocumentDelivery(toolArgs,documents.context);record.stage="delivery";await documents.onDocument(document);record.outcome="done";
        return usage;
      }
      if (toolArgs || toolName) {record.stage="model_stream";record.code=finish?"TOOL_FINISH_MISMATCH":"MODEL_STREAM_INCOMPLETE";throw Error("工具调用未完整结束，未执行工具交付");}
      if (finish !== "stop" || !length) {record.stage='model_stream';throw new Error(finish === "length" ? "模型回复达到长度上限，请缩短问题后重试" : "模型流未完整结束");}
      record.outcome="done";return usage;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    record.outcome='error';
    if(deadline.signal.aborted&&!signal.aborted)record.code='MODEL_STREAM_TIMEOUT';
    record.code=diagnosticCode(error,record,signal.aborted);
    const cause=deadline.signal.aborted?deadline.signal.reason:error;
    throw new RequestDiagnosticError(cause instanceof SyntaxError?(record.stage==='tool_validate'?'模型工具参数无法解析':'模型流包含无效 JSON'):cause instanceof Error?cause.message:'模型请求失败',record);
  } finally { record.durationMs=Date.now()-started;record.lastDataAgeMs=Date.now()-lastData;notifyDiagnostic(onDiagnostic,record);deadline.dispose(); }
}

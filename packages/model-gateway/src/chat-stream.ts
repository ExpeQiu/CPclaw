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
): Promise<TokenUsage> {
  const deadline = createStreamDeadline({ signal, idleMs: config.timeoutMs, label: "模型服务" });
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "MiniMax-M3", messages: documents ? [{ role: "system", content: (documents.services ? serviceSystemMessage(documents.services) : "") + documentSystemMessage(documents.context) }, ...messages] : messages, ...(documents ? { tools: [documentTool, ...(documents.services ? [serviceRequestTool] : [])], tool_choice: "auto", parallel_tool_calls: false } : {}), stream: true, stream_options: { include_usage: true }, thinking: { type: documents ? "adaptive" : "disabled" }, ...(documents ? { reasoning_split: true } : {}), max_completion_tokens: 4096 }),
      signal: deadline.signal,
    });
    deadline.touch();
    if (!response.ok) throw new Error(`模型网关返回 ${response.status}`);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("模型未返回流式响应");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", data: string[] = [], finish: unknown, length = 0;
    let toolName="", toolArgs="", toolId="";
    let usage: TokenUsage = { state: "unknown" };
    async function dispatch(): Promise<void> {
      if (!data.length) return;
      const raw = data.join("\n"); data = [];
      if (raw === "[DONE]") return;
      const event = JSON.parse(raw);
      if (event.error || (event.base_resp && event.base_resp.status_code !== 0)) throw new Error("模型流返回错误");
      if (event.usage) usage = readTokenUsage(event.usage);
      const choice = event.choices?.[0];
      if (documents && choice?.delta?.reasoning_content) await documents.onActivity?.();
      if (choice?.finish_reason != null) finish = choice.finish_reason;
      const calls = choice?.delta?.tool_calls;
      if (calls !== undefined) {
        if (!documents || !Array.isArray(calls)) throw Error("模型返回未获支持的工具调用");
        for (const call of calls) {
          if (call.index !== 0 || (call.id && toolId && call.id !== toolId)) throw Error("每次回复仅允许交付一个文档");
          if (call.id) toolId=call.id;
          if (typeof call.function?.name === 'string') toolName+=call.function.name;
          if (typeof call.function?.arguments === 'string') toolArgs+=call.function.arguments;
          if (toolName.length>100 || toolArgs.length>1000000) throw Error("文档工具参数超限");
        }
        await documents.onActivity?.();
      }
      const text = choice?.delta?.content;
      if (typeof text === "string" && text.length) {
        length += text.length;
        if (length > 128_000) throw new Error("模型回复超过长度限制");
        signal.throwIfAborted();
        await onDelta(text);
      }
    }
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.value?.length) deadline.touch();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length > 256_000) throw new Error("模型流事件过大");
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
          if (!line) await dispatch();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (chunk.done) break;
      }
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).trim());
      await dispatch();
      signal.throwIfAborted();
      if (finish === "tool_calls") {
        if(documents?.services && documents.onService && toolName==='request_service'){await documents.onService(parseServiceRequest(toolArgs,documents.services));return usage;}
        if (!documents || toolName !== 'deliver_document') throw Error("模型请求了未知文档工具");
        await documents.onDocument(parseDocumentDelivery(toolArgs,documents.context));
        return usage;
      }
      if (toolArgs || toolName) throw Error("文档工具调用未完整结束");
      if (finish !== "stop" || !length) throw new Error(finish === "length" ? "模型回复达到长度上限，请缩短问题后重试" : "模型流未完整结束");
      return usage;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally { deadline.dispose(); }
}

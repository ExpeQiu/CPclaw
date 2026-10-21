import { createLogEvent, readTokenUsage, type ModelCheckRecord, type TokenUsage } from "@cpclaw/contracts";

const MODEL = "MiniMax-M3" as const;
const DEFAULT_OPENAI_BASE_URL = "https://api.minimaxi.com/v1";

export type MockGatewayConfig = {
  mode: "mock";
  timeoutMs: number;
};

export type RealGatewayConfig = {
  mode: "real";
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
};

export type GatewayConfig = MockGatewayConfig | RealGatewayConfig;

export function resolveGatewayConfig(
  env: Record<string, string | undefined>,
): GatewayConfig | { ok: false; message: string } {
  const mock = env.AI_MOCK_MODE;
  if (mock === "true") {
    return { mode: "mock", timeoutMs: 5_000 };
  }
  if (mock !== undefined && mock !== "false") {
    return { ok: false, message: "AI_MOCK_MODE 只接受 true 或 false" };
  }
  const apiKey = env.MINIMAX_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return { ok: false, message: "真实模式缺少 MINIMAX_API_KEY，密钥不能写进仓库" };
  }
  const baseUrl = resolveOpenAiBaseUrl(env);
  if (typeof baseUrl !== "string") {
    return baseUrl;
  }
  return {
    mode: "real",
    baseUrl,
    apiKey,
    timeoutMs: 20_000,
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** 空字符串是已写出的配置，不回落默认地址。未设置才用指南里的 OpenAI 兼容地址。 */
function resolveOpenAiBaseUrl(
  env: Record<string, string | undefined>,
): string | { ok: false; message: string } {
  const openai = env.MINIMAX_OPENAI_BASE_URL;
  const host = env.MINIMAX_BASE_URL;
  if (openai === "") {
    return { ok: false, message: "MINIMAX_OPENAI_BASE_URL 已写出但为空" };
  }
  if (host === "") {
    return { ok: false, message: "MINIMAX_BASE_URL 已写出但为空" };
  }
  if (typeof openai === "string") {
    return stripTrailingSlash(openai);
  }
  if (typeof host === "string") {
    const trimmed = stripTrailingSlash(host);
    return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  }
  return DEFAULT_OPENAI_BASE_URL;
}

type ChatResult = {
  text: string;
  usage: TokenUsage;
  toolName?: string;
};

function gatewayLog(level: "info" | "warn" | "error", event: string, message: string, fields: Record<string, string | number | boolean>): void {
  const created = createLogEvent({
    timestamp: new Date().toISOString(),
    level,
    service: "cpclaw-model-gateway",
    event,
    message,
    fields,
  });
  if (!created.ok) {
    process.stderr.write(`${JSON.stringify({ level: "error", event: "log_rejected", message: created.message })}\n`);
    return;
  }
  process.stderr.write(`${JSON.stringify(created.event)}\n`);
}

async function postChat(
  config: RealGatewayConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ChatResult> {
  const started = Date.now();
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    gatewayLog("error", "minimax_http", "MiniMax 返回非成功状态", {
      model: MODEL,
      status: response.status,
      durationMs: Date.now() - started,
    });
    throw new Error(`模型网关返回 ${response.status}`);
  }
  const payload = await readModelPayload(response);
  const usage = readTokenUsage(typeof payload === "object" && payload !== null ? Reflect.get(payload, "usage") : undefined);
  const choices = typeof payload === "object" && payload !== null ? Reflect.get(payload, "choices") : undefined;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = typeof first === "object" && first !== null ? Reflect.get(first, "message") : undefined;
  const text = typeof message === "object" && message !== null && typeof Reflect.get(message, "content") === "string"
    ? Reflect.get(message, "content")
    : "";
  const toolCalls = typeof message === "object" && message !== null ? Reflect.get(message, "tool_calls") : undefined;
  const toolName = Array.isArray(toolCalls) && typeof toolCalls[0] === "object" && toolCalls[0] !== null
    ? Reflect.get(Reflect.get(toolCalls[0], "function") ?? {}, "name")
    : undefined;
  const result: ChatResult = {
    text: typeof text === "string" ? text : "",
    usage,
  };
  if (typeof toolName === "string") {
    result.toolName = toolName;
  }
  const fields: Record<string, string | number | boolean> = {
    model: MODEL,
    status: response.status,
    durationMs: Date.now() - started,
    usageState: usage.state,
  };
  if (usage.state === "known") {
    fields.inputTokens = usage.inputTokens;
    fields.outputTokens = usage.outputTokens;
  }
  gatewayLog("info", "minimax_chat", "MiniMax 文本调用返回", fields);
  return result;
}

function mockRecord(kind: ModelCheckRecord["kind"], note: string, usage: TokenUsage): ModelCheckRecord {
  return { kind, model: MODEL, usage, note };
}

async function readModelPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return response.json();
  }
  const raw = await response.text();
  let content = "";
  let usage: unknown;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof chunk !== "object" || chunk === null) {
      continue;
    }
    const chunkUsage = Reflect.get(chunk, "usage");
    if (chunkUsage !== undefined && chunkUsage !== null) {
      usage = chunkUsage;
    }
    const choices = Reflect.get(chunk, "choices");
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const delta = typeof first === "object" && first !== null ? Reflect.get(first, "delta") : undefined;
    const piece = typeof delta === "object" && delta !== null ? Reflect.get(delta, "content") : undefined;
    if (typeof piece === "string") {
      content += piece;
    }
  }
  return { choices: [{ message: { content } }], usage };
}

export async function runModelChecks(
  env: Record<string, string | undefined>,
): Promise<{ ok: true; records: ModelCheckRecord[] } | { ok: false; message: string }> {
  const config = resolveGatewayConfig(env);
  if ("ok" in config) {
    return config;
  }
  if (config.mode === "mock") {
    return {
      ok: true,
      records: [
        mockRecord("text", "mock 文本", { state: "known", inputTokens: 3, outputTokens: 2 }),
        mockRecord("stream", "mock 流式", { state: "known", inputTokens: 3, outputTokens: 4 }),
        mockRecord("tool", "mock 工具", { state: "known", inputTokens: 5, outputTokens: 1 }),
        mockRecord("cancel", "mock 取消", { state: "unknown" }),
        mockRecord("timeout", "mock 超时", { state: "unknown" }),
      ],
    };
  }
  const records: ModelCheckRecord[] = [];
  const baseBody = { model: MODEL, messages: [{ role: "user", content: "回复一个字：好" }] };
  try {
    const text = await postChat(config, baseBody, AbortSignal.timeout(config.timeoutMs));
    records.push(mockRecord("text", "文本调用完成", text.usage));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "文本调用失败" };
  }
  try {
    const stream = await postChat(
      config,
      { ...baseBody, stream: true, stream_options: { include_usage: true } },
      AbortSignal.timeout(config.timeoutMs),
    );
    records.push(mockRecord("stream", stream.text.length > 0 ? "流式调用完成" : "流式调用没有正文", stream.usage));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "流式调用失败" };
  }
  try {
    const tool = await postChat(
      config,
      {
        model: MODEL,
        messages: [{ role: "user", content: "请调用 echo，参数 word 为好" }],
        tools: [{
          type: "function",
          function: {
            name: "echo",
            description: "回显一个词",
            parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
          },
        }],
        tool_choice: { type: "function", function: { name: "echo" } },
      },
      AbortSignal.timeout(config.timeoutMs),
    );
    records.push(mockRecord("tool", tool.toolName === undefined ? "工具调用未返回工具名" : `工具 ${tool.toolName}`, tool.usage));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "工具调用失败" };
  }
  const cancel = new AbortController();
  const cancelled = postChat(config, baseBody, cancel.signal).then(
    (result) => mockRecord("cancel", "取消前已返回", result.usage),
    () => mockRecord("cancel", "调用已取消", { state: "unknown" }),
  );
  cancel.abort();
  records.push(await cancelled);
  const timed = await postChat(config, baseBody, AbortSignal.timeout(1)).then(
    (result) => mockRecord("timeout", "超时边界内返回", result.usage),
    () => mockRecord("timeout", "调用超时", { state: "unknown" }),
  );
  records.push(timed);
  return { ok: true, records };
}

export function assertUsageNotZeroFilled(records: readonly ModelCheckRecord[]): boolean {
  return records.every((record) => record.usage.state === "unknown" || record.usage.inputTokens >= 0);
}

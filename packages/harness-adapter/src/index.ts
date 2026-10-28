import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_START_TIMEOUT_MS = 180_000;

const SDK_SPECIFIER: string = "@deepseek-ai/dsh-sdk-client";

type SdkNotification = { method: string; params: Record<string, unknown> };

type SdkHarness = {
  run(
    input: string,
    options?: { onNotification?: (notification: SdkNotification) => void },
  ): Promise<{ finalResponse: string }>;
  close(): Promise<void>;
};

type SdkModule = {
  DeepSeekHarness: new (options: Record<string, unknown>) => SdkHarness;
};

function isSdkModule(value: unknown): value is SdkModule {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "DeepSeekHarness") === "function";
}

async function loadSdk(): Promise<SdkModule> {
  const loaded: unknown = await import(process.env.CPCLAW_HARNESS_BUNDLE ? pathToFileURL(join(process.env.CPCLAW_HARNESS_BUNDLE, "node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js")).href : SDK_SPECIFIER);
  if (!isSdkModule(loaded)) {
    throw new Error("未能从 @deepseek-ai/dsh-sdk-client 加载 DeepSeekHarness");
  }
  return loaded;
}

export type StreamMeasurement = {
  commit: string;
  streamEnded: boolean;
  finalResponse: string;
  notificationCount: number;
  trace: string[];
  childEnvNames: string[];
  childCommandSeenAfterClose: boolean;
};

export function readHarnessCommit(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export function writeMockProviderHome(homeDir: string, baseUrl: string): void {
  mkdirSync(homeDir, { recursive: true });
  const settings = [
    "llm-pi-ai:",
    "  providers:",
    "    cpclaw-mock:",
    "      apiKeyEnv: CPCLAW_MOCK_LLM_KEY",
    "      api: openai-completions",
    "      baseURL: " + baseUrl,
    "      models:",
    "        - id: mock-text",
    "",
  ].join("\n");
  writeFileSync(join(homeDir, "settings.yaml"), settings, "utf8");
  writeFileSync(join(homeDir, "cpclaw-marker.patch.yml"), "[]\n", "utf8");
}

function markerPatch(homeDir: string): string {
  return join(homeDir, "cpclaw-marker.patch.yml");
}

function scrubbedEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    DSH_HOME: homeDir,
    CPCLAW_MOCK_LLM_KEY: "local-mock",
  };
  return env;
}

export async function runTextStream(input: {
  harnessRoot: string;
  dshHome: string;
  baseUrl: string;
  prompt: string;
}): Promise<StreamMeasurement> {
  const commit = readHarnessCommit(input.harnessRoot);
  writeMockProviderHome(input.dshHome, input.baseUrl);
  const sdk = await loadSdk();
  const harness = new sdk.DeepSeekHarness({
    profile: "sdk",
    provider: "cpclaw-mock",
    model: "mock-text",
    cwd: input.dshHome,
    dshHome: input.dshHome,
    processCwd: input.dshHome,
    patches: [markerPatch(input.dshHome)],
    env: scrubbedEnv(input.dshHome),
    initializeTimeoutMs: SOURCE_START_TIMEOUT_MS,
    requestTimeoutMs: 60_000,
  });
  let notificationCount = 0;
  const trace: string[] = [];
  let streamEnded = false;
  try {
    const result = await harness.run(input.prompt, {
      onNotification: (notification) => {
        notificationCount += 1;
        const event = notification.params.event;
        const eventType = typeof event === "object" && event !== null && typeof Reflect.get(event, "type") === "string"
          ? String(Reflect.get(event, "type"))
          : "";
        if (eventType === "turn/end" && typeof event === "object" && event !== null) {
          const data: unknown = Reflect.get(event, "data");
          const detail = typeof data === "object" && data !== null ? JSON.stringify(data) : "";
          trace.push(`${notification.method}:${eventType}:${detail}`);
        } else {
          trace.push(eventType === "" ? notification.method : `${notification.method}:${eventType}`);
        }
      },
    });
    streamEnded = true;
    await harness.close();
    return {
      commit,
      streamEnded,
      finalResponse: result.finalResponse,
      notificationCount,
      trace,
      childEnvNames: Object.keys(scrubbedEnv(input.dshHome)),
      childCommandSeenAfterClose: processStillMentions(markerPatch(input.dshHome)),
    };
  } catch (error) {
    await harness.close().catch(() => undefined);
    throw error;
  }
}

function processStillMentions(marker: string): boolean {
  try {
    const listing = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
    return listing.includes(marker);
  } catch {
    return true;
  }
}

export async function cancelHarness(input: {
  harnessRoot: string;
  dshHome: string;
  baseUrl: string;
}): Promise<{ closed: boolean; runRejected: boolean; childCommandSeenAfterClose: boolean }> {
  writeMockProviderHome(input.dshHome, input.baseUrl);
  const sdk = await loadSdk();
  const harness = new sdk.DeepSeekHarness({
    profile: "sdk",
    provider: "cpclaw-mock",
    model: "mock-text",
    cwd: input.dshHome,
    dshHome: input.dshHome,
    patches: [markerPatch(input.dshHome)],
    env: scrubbedEnv(input.dshHome),
    initializeTimeoutMs: SOURCE_START_TIMEOUT_MS,
    requestTimeoutMs: 60_000,
  });
  let sawRequest = false;
  const run = harness.run("请保持这条生成不要结束", {
    onNotification: (notification) => {
      const event = notification.params.event;
      const eventType = typeof event === "object" && event !== null && typeof Reflect.get(event, "type") === "string"
        ? String(Reflect.get(event, "type"))
        : "";
      if (eventType === "request/header") {
        sawRequest = true;
      }
    },
  });
  const requested = new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (sawRequest) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 60_000) {
        clearInterval(timer);
        reject(new Error("取消前没有等到模型请求"));
      }
    }, 30);
  });
  try {
    await Promise.race([
      requested,
      run.then(() => Promise.reject(new Error("取消前回合已经结束"))),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await harness.close();
  } catch (error) {
    await harness.close().catch(() => undefined);
    throw error;
  }
  let runRejected = false;
  try {
    await run;
  } catch {
    runRejected = true;
  }
  return {
    closed: true,
    runRejected,
    childCommandSeenAfterClose: processStillMentions(markerPatch(input.dshHome)),
  };
}

/** Preserve actionable platform failures without echoing arbitrary upstream bodies or credentials. */
export async function harnessGatewayError(response: Response): Promise<Error> {
  const value: unknown = await response.json().catch(() => null);
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const code = ['QUOTA_EXCEEDED','AUTH_REQUIRED','SESSION_REVOKED','FORBIDDEN','CONFLICT','CONFIG_INVALID','NOT_FOUND'].includes(String(record.code)) ? String(record.code) : '';
  let reason = '';
  if(code==='QUOTA_EXCEEDED') reason=record.message==='并发已达上限'?'平台模型并发位已满':record.message==='额度不足'?'平台模型额度不足':'平台模型额度或并发受限';
  else if(['AUTH_REQUIRED','SESSION_REVOKED'].includes(code)) reason='平台登录会话不可用';
  else if(code==='FORBIDDEN') reason='平台权限不足';
  else if(response.status===429) reason='请求受限，请核实平台模型额度与并发';
  const retryAfter=Number(response.headers.get('retry-after'));
  return Object.assign(new Error(`远程 Harness 网关返回 ${response.status}${reason?'：'+reason:''}${code?'（'+code+'）':''}`),{
    httpStatus:response.status,platformCode:code,
    ...(Number.isFinite(retryAfter)&&retryAfter>0?{retryAfterSeconds:retryAfter}:{}),
  });
}

export async function runReportLoop(input: {
  homeParent: string; platformBase: string; accessToken: string;
  goal: string; materials: { fileName: string; paragraphs: { id: string; text: string }[] }[];
  signal: AbortSignal; beforeCall: () => void; unknownUsage: () => void;
  service?: { context: string; execute: (request: string) => Promise<string> };
}): Promise<{ finalResponse: string; toolCalls: number; modelCalls: number; childCommandSeenAfterClose: boolean }> {
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { mkdtempSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const homeDir = mkdtempSync(join(input.homeParent, "harness-"));
  const nonce = randomUUID();
  let modelCalls = 0, toolCalls = 0;
  let fatal: unknown;
  let harness: SdkHarness | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      if (input.signal.aborted || fatal || req.headers.authorization !== `Bearer ${nonce}`) { res.writeHead(403); res.end(); return; }
      if (input.service && req.method === "POST" && req.url === "/service") {
        if (++toolCalls > 40) throw new Error("服务步骤超过 40 次，请分批执行");
        let raw = ""; for await (const chunk of req) { raw += String(chunk); if (raw.length > 16000) throw new Error("服务参数超限"); }
        const result = await input.service.execute(raw);
        res.writeHead(200, { "content-type": "application/json" }); res.end(result); return;
      }
      if (req.method === "GET" && req.url === "/material") {
        toolCalls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(input.materials));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
      let charged = false;
      try {
        let raw = "";
        for await (const chunk of req) { raw += String(chunk); if (Buffer.byteLength(raw) > (input.service ? 240_000 : 16_000)) throw new Error("模型上下文超过验证上限"); }
        const body: unknown = JSON.parse(raw);
        if (modelCalls >= (input.service ? 24 : 8)) throw Error("模型步骤达到上限，请继续当前任务");
        input.beforeCall(); charged = true; modelCalls++;
        const response = await fetch(`${input.platformBase.replace(/\/$/, "")}/v1/harness/completions`, {
          method: "POST", headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json", "x-request-id": `loop-${randomUUID()}` },
          body: JSON.stringify(body), signal: input.signal,
        });
        if (!response.ok) throw await harnessGatewayError(response);
        const text = await response.text();
        res.writeHead(200, { "content-type": "text/event-stream" }); res.end(text);
      } catch (error) {
        if (charged) input.unknownUsage();
        fatal = error;
        res.writeHead(502); res.end();
        void harness?.close().catch(() => undefined);
      }
    })().catch(() => { res.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("本地工具网关没有端口");
  const base = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(homeDir, "settings.yaml"), `llm-pi-ai:\n  providers:\n    cpclaw-real:\n      apiKeyEnv: CPCLAW_LOOP_KEY\n      api: openai-completions\n      baseURL: ${base}/v1\n      models:\n        - id: MiniMax-M3\n`);
  const patch = markerPatch(homeDir);
  const plugin = fileURLToPath(new URL(input.service ? "../src/service-plugin.mjs" : "../src/material-plugin.mjs", import.meta.url));
  writeFileSync(patch, [
    "- id: llm-deepseek\n  disabled: true",
    "- id: persistent-bash\n  disabled: true",
    "- id: persistent-pwsh\n  disabled: true",
    "- id: session-log-deepseek\n  disabled: true",
    `- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: false\n    personaPrefix: ${JSON.stringify(input.service ? input.service.context : "你是报告助手。必须先调用 read_material，再依据返回材料生成中文报告，不得编造来源。只输出报告正文，必须逐字使用这四个标题（井号后有空格）：# 任务目标、# 材料与来源、# 要点、# 未覆盖项。每段材料都必须引用 fileName#段落id。")}`,
    `- insert:\n    - id: llm-pi-ai\n      name: '@deepseek-ai/dsh-llm-pi-ai'\n      config: ${JSON.stringify({ providers: { 'cpclaw-real': { apiKeyEnv: 'CPCLAW_LOOP_KEY', api: 'openai-completions', baseURL: base + '/v1', models: [{ id: 'MiniMax-M3' }] } } })}\n    - id: cpclaw-service\n      name: ${JSON.stringify(plugin)}`,
  ].join("\n"));
  const env = scrubbedEnv(homeDir);
  delete env.CPCLAW_MOCK_LLM_KEY;
  env.CPCLAW_LOOP_KEY = nonce; env.CPCLAW_TOOL_URL = base;
  const abort = () => { void harness?.close().catch(() => undefined); };
  try {
    const sdk = await loadSdk();
    harness = new sdk.DeepSeekHarness({ profile: "sdk-minimal", provider: "cpclaw-real", model: "MiniMax-M3", cwd: homeDir, processCwd: homeDir, dshHome: homeDir, patches: [patch], env, maxTokens: 2048, initializeTimeoutMs: SOURCE_START_TIMEOUT_MS, requestTimeoutMs: input.service ? 1_800_000 : 90_000 });
    input.signal.addEventListener("abort", abort, { once: true });
    input.signal.throwIfAborted();
    let result;
    try { result = await harness.run(input.service ? input.goal : `任务目标：${input.goal}。先调用 read_material 获取本次获准的材料，再输出带全部段落来源的四节 Markdown 报告。`); }
    catch (error) { throw fatal ?? error; }
    if (fatal) throw fatal;
    input.signal.throwIfAborted();
    if ((!input.service && (toolCalls < 1 || modelCalls < 2)) || !result.finalResponse.trim()) throw new Error("Harness 未完成工具调用和模型续答");
    await harness.close();
    // SDK close may resolve before the operating system reaps its child.
    const cleanupDeadline = Date.now() + 2_000;
    let remains = processStillMentions(patch);
    while (remains && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      input.signal.throwIfAborted();
      remains = processStillMentions(patch);
    }
    input.signal.throwIfAborted();
    if (remains) throw new Error("Harness 子进程未回收");
    const finalResponse = result.finalResponse.replace(/^#(?=任务目标|材料与来源|要点|未覆盖项)/gm, "# ");
    return { finalResponse, toolCalls, modelCalls, childCommandSeenAfterClose: remains };
  } finally {
    input.signal.removeEventListener("abort", abort);
    await harness?.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

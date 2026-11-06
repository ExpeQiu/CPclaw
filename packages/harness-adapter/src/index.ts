import {modelTransportFailure,transportCode} from './transport-error.js';
import { inspectHarnessProcess } from "./process-inspection.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { prepareServiceCompletion, serviceModelBudget } from "./loop-budget.js";

const SOURCE_START_TIMEOUT_MS = 180_000;

const SDK_SPECIFIER: string = "@deepseek-ai/dsh-sdk-client";

type SdkNotification = { method: string; params: Record<string, unknown> };

type SdkHarness = {
  run(
    input: string | {type:'text';text:string}[],
    options?: { sessionId?: string; onNotification?: (notification: SdkNotification) => void },
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
  const result = inspectHarnessProcess(marker);
  if (result.state === 'unknown') throw new Error('Harness 退出状态检查失败，无法确认进程是否残留');
  return result.state === 'remaining';
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
  const code = ['QUOTA_EXCEEDED','AUTH_REQUIRED','SESSION_REVOKED','FORBIDDEN','CONFLICT','CONFIG_INVALID','NOT_FOUND','MODEL_OUTPUT_LIMIT'].includes(String(record.code)) ? String(record.code) : '';
  let reason = '';
  if(code==='QUOTA_EXCEEDED') reason=record.message==='并发已达上限'?'平台模型并发位已满':record.message==='额度不足'?'平台模型额度不足':'平台模型额度或并发受限';
  else if(['AUTH_REQUIRED','SESSION_REVOKED'].includes(code)) reason='平台登录会话不可用';
  else if(code==='FORBIDDEN') reason='平台权限不足';
  else if(response.status===429) reason='请求受限，请核实平台模型额度与并发';
  const retryAfter=Number(response.headers.get('retry-after'));
  return Object.assign(new Error(`远程 Harness 网关返回 ${response.status}${reason?'：'+reason:''}${code?'（'+code+'）':''}`),{
    httpStatus:response.status,platformCode:code,
    diagnostic:record.diagnostic,
    ...(code==='MODEL_OUTPUT_LIMIT'&&typeof record.checkpoint==='string'&&record.checkpoint.length<=128000?{checkpoint:record.checkpoint}:{}),
    ...(code==='MODEL_OUTPUT_LIMIT'?{code}:{}),
    ...(Number.isFinite(retryAfter)&&retryAfter>0?{retryAfterSeconds:retryAfter}:{}),
  });
}

export async function runReportLoop(input: {
  homeParent: string; platformBase: string; accessToken: string;
  /** Stable CPclaw chat binding; omitted for standalone reports. */
  sessionId?: string;
  traceId?: string; parentRequestId?: string; chatId?: string;
  onAccepted?: (messageId: string) => void;
  onFinalDraft?: (content:string)=>void;
  shouldFinalize?: ()=>boolean;
  pipeline?: {context:string;idleMs?:number;references?:Record<string,unknown>;tools:{name:string;description:string;parameters:Record<string,unknown>}[];execute:(call:{name:string;arguments:Record<string,unknown>;callId:string})=>Promise<unknown>};
  onDelta?: (text:string)=>void;
  onDiagnostic?: (record: Record<string, unknown>) => void;
  goal: string; materials: { fileName: string; paragraphs: { id: string; text: string }[] }[];
  signal: AbortSignal; beforeCall: () => void; unknownUsage: () => void;
  service?: { context: string; execute: (request: string) => Promise<string> };
}): Promise<{ finalResponse: string; toolCalls: number; modelCalls: number; childCommandSeenAfterClose: boolean | null; cleanupWarning?: { code: string; message: string };handoff?:boolean }> {
  const budget = input.service||input.pipeline ? serviceModelBudget() : null;
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { mkdtempSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  if (input.sessionId !== undefined && !/^[a-zA-Z0-9-]{1,100}$/.test(input.sessionId)) throw Error("无效的内核会话编号");
  const homeDir = input.sessionId === undefined ? mkdtempSync(join(input.homeParent, "harness-")) : join(input.homeParent, "harness-sessions", input.sessionId);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  let modelCalls = 0, toolCalls = 0,handoff=false,lastModelFinish='';
  let fatal: unknown;
  let harness: SdkHarness | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      if (input.signal.aborted || fatal || req.headers.authorization !== `Bearer ${nonce}`) { res.writeHead(403); res.end(); return; }
      if(input.pipeline&&req.method==='POST'&&req.url==='/tools'){
        if(++toolCalls>100)throw Error('工具调用次数达到硬限制');
        let raw='';for await(const chunk of req){raw+=String(chunk);if(Buffer.byteLength(raw)>1_000_000)throw Error('工具参数超限');}
        const call=JSON.parse(raw);const result=await input.pipeline.execute(call);
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
      }
      if (input.service && req.method === "POST" && req.url === "/service") {
        if (budget && modelCalls > budget.finalOnlyAt) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, code: "ROUND_WRAP_UP", message: "本轮已进入收尾阶段，未执行此操作。请依据已有回执完成回答；未知任务状态请明确说明，勿重复提交。" }));
          return;
        }
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
      let modelRequestId='',networkStage:'model_connect'|'model_stream'='model_connect',fetchStarted=false;
      let charged = false;let idleTimer:ReturnType<typeof setTimeout>|undefined;
      const idleAbort=new AbortController();const touch=()=>{if(input.pipeline){clearTimeout(idleTimer);idleTimer=setTimeout(()=>idleAbort.abort(Error('模型连续未返回数据，连接已中止')),input.pipeline.idleMs??70000);idleTimer.unref?.();}};
      try {touch();
        let raw = "";
        for await (const chunk of req) { raw += String(chunk); if (Buffer.byteLength(raw) > (input.pipeline ? 2_000_000 : input.service ? 240_000 : 16_000)) throw new Error("模型上下文超过验证上限"); }
        const body: unknown = JSON.parse(raw);
        if(input.service&&input.shouldFinalize?.()){
          handoff=true;res.writeHead(200,{'content-type':'text/event-stream'});
          res.end('data: '+JSON.stringify({id:'cpclaw-handoff',object:'chat.completion.chunk',model:'MiniMax-M3',choices:[{index:0,delta:{role:'assistant',content:'资料收集阶段结束，交由宿主完成分段交付。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
        }
        if (modelCalls >= (budget?.limit ?? 8)) throw Error("模型步骤达到上限，请继续当前任务");
        input.beforeCall(); charged = true; modelCalls++;
        modelRequestId=`loop-${randomUUID()}`;fetchStarted=true;
        const response = await fetch(`${input.platformBase.replace(/\/$/, "")}/v1/harness/completions`, {
          method: "POST", headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json", "x-request-id": modelRequestId,"x-cpclaw-harness-final":"v1",...(input.pipeline?{"x-cpclaw-pipeline":"v1"}:{}),"x-trace-id":input.traceId||modelRequestId,"x-parent-request-id":input.parentRequestId||"","x-chat-id":input.chatId||"","x-harness-session-id":input.sessionId||"" },
          body: JSON.stringify(budget&&!input.pipeline ? prepareServiceCompletion(body, modelCalls - 1, budget) : body), signal: AbortSignal.any([input.signal,idleAbort.signal]),
        });
        try{input.onDiagnostic?.({requestId:modelRequestId,status:response.status,modelCall:modelCalls,traceId:input.traceId||modelRequestId});}catch{ /* Diagnostic observers do not control execution. */ }
        if (!response.ok) {const failure=await harnessGatewayError(response);const checkpoint=Reflect.get(failure,'checkpoint');if(typeof checkpoint==='string'&&!input.pipeline)input.onFinalDraft?.(checkpoint);try{input.onDiagnostic?.({requestId:modelRequestId,status:response.status,modelCall:modelCalls,diagnostic:Reflect.get(failure,'diagnostic')});}catch{}throw failure;}
        networkStage='model_stream';
        if(input.pipeline&&response.body){
          res.writeHead(200,{'content-type':'text/event-stream'});const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',finish='';let textChars=0;
          try{while(true){const part=await reader.read();if(part.value){touch();if(!res.write(part.value))await new Promise<void>((resolve,reject)=>{const cleanup=()=>{res.off('drain',done);res.off('close',closed);};const done=()=>{cleanup();resolve();};const closed=()=>{cleanup();reject(Error('内核模型通道关闭'));};res.once('drain',done);res.once('close',closed);});}
            buffer+=decoder.decode(part.value,{stream:!part.done});let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(line.startsWith('data:')&&line.slice(5).trim()!=='[DONE]'){const item=JSON.parse(line.slice(5)),choice=item.choices?.[0];if(typeof choice?.delta?.content==='string'){const text=choice.delta.content;textChars+=text.length;input.onDelta?.(text);}if(choice?.finish_reason)finish=choice.finish_reason;}}
            if(part.done)break;}
          }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          lastModelFinish=finish;input.onDiagnostic?.({requestId:modelRequestId,diagnostic:{code:finish==='length'?'MODEL_OUTPUT_LIMIT':'',stage:'model_stream',finishReason:finish,textChars}});res.end();
        }else{const text = await response.text();res.writeHead(200, { "content-type": "text/event-stream" }); res.end(text);}
      } catch (error) {
        if (charged) input.unknownUsage();
        fatal = input.signal.aborted?input.signal.reason:idleAbort.signal.aborted?Object.assign(Error('模型连续未返回数据，连接已中止；已保存的文件和回执保留。'),{code:'MODEL_STREAM_TIMEOUT',diagnostic:{code:'MODEL_STREAM_TIMEOUT',stage:networkStage,outcome:'error'}}):fetchStarted&&(error instanceof TypeError||transportCode(error))?modelTransportFailure(error,networkStage):error;
        const diagnostic=fatal&&typeof fatal==='object'?Reflect.get(fatal,'diagnostic'):undefined;
        if(diagnostic)try{input.onDiagnostic?.({requestId:modelRequestId,modelCall:modelCalls,diagnostic});}catch{};
        if(!res.headersSent){res.writeHead(502);res.end();}else res.destroy();
        void harness?.close().catch(() => undefined);
      }finally{clearTimeout(idleTimer);}
    })().catch(() => { res.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("本地工具网关没有端口");
  const base = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(homeDir, "settings.yaml"), `llm-pi-ai:\n  providers:\n    cpclaw-real:\n      apiKeyEnv: CPCLAW_LOOP_KEY\n      api: openai-completions\n      baseURL: ${base}/v1\n      models:\n        - id: MiniMax-M3\n`);
  const patch = markerPatch(homeDir);
  const plugin = fileURLToPath(new URL(input.pipeline ? "../src/pipeline-plugin.mjs" : input.service ? "../src/service-plugin.mjs" : "../src/material-plugin.mjs", import.meta.url));
  writeFileSync(patch, [
    ...(input.sessionId ? ["- id: sdk-jsonrpc-server\n  config:\n    maxTokensAsSuccess: false\n    resumeExistingSessions: true"] : []),
    "- id: llm-deepseek\n  disabled: true",
    "- id: persistent-bash\n  disabled: true",
    "- id: persistent-pwsh\n  disabled: true",
    "- id: session-log-deepseek\n  disabled: true",
    `- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: false\n    personaPrefix: ${JSON.stringify(input.pipeline ? input.pipeline.context : input.service ? input.service.context + " 对资料查询类问题，只查询回答所需的信息；已有证据足够时立即整理答复，不扩展到无关源码、用户目录或测试夹具。区分内置、项目和用户安装的技能。" : "你是报告助手。必须先调用 read_material，再依据返回材料生成中文报告，不得编造来源。只输出报告正文，必须逐字使用这四个标题（井号后有空格）：# 任务目标、# 材料与来源、# 要点、# 未覆盖项。每段材料都必须引用 fileName#段落id。")}`,
    `- insert:\n    - id: llm-pi-ai\n      name: '@deepseek-ai/dsh-llm-pi-ai'\n      config: ${JSON.stringify({ providers: { 'cpclaw-real': { apiKeyEnv: 'CPCLAW_LOOP_KEY', api: 'openai-completions', baseURL: base + '/v1', models: [{ id: 'MiniMax-M3' }] } } })}\n    - id: cpclaw-service\n      name: ${JSON.stringify(plugin)}`,
  ].join("\n"));
  if(input.pipeline)writeFileSync(join(homeDir,'cpclaw-tools.json'),JSON.stringify(input.pipeline.tools),{mode:0o600});
  const env = scrubbedEnv(homeDir);
  if(input.pipeline)env.CPCLAW_TOOL_MANIFEST=join(homeDir,'cpclaw-tools.json');
  delete env.CPCLAW_MOCK_LLM_KEY;
  env.CPCLAW_LOOP_KEY = nonce; env.CPCLAW_TOOL_URL = base;
  const abort = () => { void harness?.close().catch(() => undefined); };
  try {
    const sdk = await loadSdk();
    harness = new sdk.DeepSeekHarness({ profile: "sdk-minimal", provider: "cpclaw-real", model: "MiniMax-M3", cwd: homeDir, processCwd: homeDir, dshHome: homeDir, patches: [patch], env, maxTokens: input.pipeline?4096:2048, initializeTimeoutMs: SOURCE_START_TIMEOUT_MS, requestTimeoutMs: input.service||input.pipeline ? 1_800_000 : 90_000 });
    input.signal.addEventListener("abort", abort, { once: true });
    input.signal.throwIfAborted();
    let result,accepted=false;
    const kernelInput=input.pipeline?.references?[{type:'text' as const,text:input.goal},{type:'text' as const,text:'\n\n[CPclaw input references]\n'+JSON.stringify(input.pipeline.references)}]:input.goal;
    try { result = await harness.run(input.pipeline?kernelInput:input.service ? input.goal : `任务目标：${input.goal}。先调用 read_material 获取本次获准的材料，再输出带全部段落来源的四节 Markdown 报告。`, {...(input.sessionId?{sessionId:input.sessionId}:{}),onNotification:notification=>{
      const event=notification.params.event as {type?:string;data?:{inserted?:{id?:string}[]}}|undefined;
      if(!accepted&&notification.method==='session.event'&&notification.params.sessionId===input.sessionId&&event?.type==='agent/inbox/spliced'){
        const id=event.data?.inserted?.[0]?.id;if(id){accepted=true;input.onAccepted?.(id);}
      }
    }}); }
    catch (error) { throw fatal ?? error; }
    if (fatal) throw fatal;
    if(input.pipeline&&lastModelFinish==='length')throw Object.assign(Error('内核模型达到输出上限，原会话与已提交段落已保留'),{code:'MODEL_OUTPUT_LIMIT'});
    input.signal.throwIfAborted();
    if (!input.pipeline && ((!input.service && (toolCalls < 1 || modelCalls < 2)) || !result.finalResponse.trim())) throw new Error("Harness 未完成工具调用和模型续答");
    let cleanupWarning: { code: string; message: string } | undefined;
    try { await harness.close(); }
    catch { cleanupWarning = {code:'HARNESS_CLOSE_FAILED',message:'运行环境关闭异常，已有回复已保留；请检查运行环境后再继续。'}; }
    // SDK close may resolve before the operating system reaps its child.
    const cleanupDeadline = Date.now() + 2_000;
    let inspection = inspectHarnessProcess(patch);
    while (inspection.state === 'remaining' && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      input.signal.throwIfAborted();
      inspection = inspectHarnessProcess(patch);
    }
    input.signal.throwIfAborted();
    if (inspection.state === 'remaining') cleanupWarning = {code:'HARNESS_CLEANUP',message:'检测到运行环境进程仍未退出，已有回复已保留；请检查运行环境后再继续。'};
    else if (inspection.state === 'unknown') cleanupWarning = {code:'HARNESS_CLEANUP_UNKNOWN',message:'无法核实运行环境是否退出，已有回复已保留；请检查运行环境后再继续。'};
    const finalResponse = input.pipeline?result.finalResponse:result.finalResponse.replace(/^#(?=任务目标|材料与来源|要点|未覆盖项)/gm, "# ");
    return { finalResponse, toolCalls, modelCalls,...(handoff?{handoff:true}:{}),
      childCommandSeenAfterClose: inspection.state === 'unknown' ? null : inspection.state === 'remaining',
      ...(cleanupWarning ? {cleanupWarning} : {}) };

  } finally {
    input.signal.removeEventListener("abort", abort);
    await harness?.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

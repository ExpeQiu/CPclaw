import {resolveHarnessBodyLimit,DEFAULT_HARNESS_BODY_BYTES} from '@cpclaw/contracts';
import {requestTraces} from './request-traces.js';
import {randomUUID} from 'node:crypto';
import {HarnessFinalCheckpointError,errorMetadata,RequestDiagnosticError,type RequestDiagnostic} from '@cpclaw/model-gateway';
import { LoginGuard } from './login-guard.js';
import { uploadDiagnostic } from "./diagnostics.js";
import { marketPage } from "./market-page.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PlatformConfig } from "./config.js";
import { adminPage } from "./admin-page.js";
import { openPlatform, type PlatformApp, type PlatformCode, type PlatformFailure, type UsageView } from "./app.js";
import { platformLog } from "./log.js";

import { completeHarness, generateReport, streamChat, type ChatMessage, type ServiceContext, type DocumentContext, type RealGatewayConfig, type ReportInput } from "@cpclaw/model-gateway";
import { checkReport, SERVICE_TYPES, invalidCatalogReason } from "@cpclaw/contracts";

const traceStores = new WeakMap<PlatformApp,ReturnType<typeof requestTraces>>();
const loginGuards = new WeakMap<PlatformApp, LoginGuard>();
const MAX_BODY = 16_384;
class BodyTooLargeError extends Error {
  constructor(readonly receivedBytes:number,readonly limitBytes:number){super('BODY_TOO_LARGE');}
}
/** 平台接受的应用服务类型白名单；桌面端按此裁剪服务目录，避免整轮对话被 400 拒绝。 */
const ALLOWED_SERVICE_TYPES = SERVICE_TYPES;

function publicSession(result: {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  sessionId: string;
  employeeId: string;
  orgId: string;
  role: string;
}): {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  sessionId: string;
  employeeId: string;
  orgId: string;
  role: string;
} {
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    accessExpiresAt: result.accessExpiresAt,
    sessionId: result.sessionId,
    employeeId: result.employeeId,
    orgId: result.orgId,
    role: result.role,
  };
}

function statusFor(code: PlatformCode): number {
  if (code === "AUTH_REQUIRED" || code === "SESSION_REVOKED") {
    return 401;
  }
  if (code === "FORBIDDEN") {
    return 403;
  }
  if (code === "QUOTA_EXCEEDED") {
    return 429;
  }
  if (code === "NOT_FOUND") {
    return 404;
  }
  if (code === "CONFLICT") {
    return 409;
  }
  return 400;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function sendFailure(res: ServerResponse, failure: PlatformFailure): void {
  sendJson(res, statusFor(failure.code), { schemaVersion: 1, code: failure.code, message: failure.message });
}

function readRequestId(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(header)) {
    return undefined;
  }
  return header;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return undefined;
  }
  const token = header.slice("Bearer ".length);
  if (token.length === 0 || token.length > 4096) {
    return undefined;
  }
  return token;
}

function readBody(req: IncomingMessage, maxBody = MAX_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if(exceeded)return;
      size += chunk.length;
      if (size > maxBody) {
        exceeded=true;chunks.length=0;
        reject(new BodyTooLargeError(size,maxBody));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if(exceeded)return;
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        const message = error instanceof Error ? error.message : "解析失败";
        reject(new Error(message));
      }
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function parseUsage(value: unknown): UsageView | undefined {
  const body = objectOf(value);
  if (body === undefined) {
    return undefined;
  }
  if (body.state === "unknown") {
    return { state: "unknown" };
  }
  if (body.state !== "known") {
    return undefined;
  }
  const inputTokens = body.inputTokens;
  const outputTokens = body.outputTokens;
  if (typeof inputTokens !== "number" || !Number.isInteger(inputTokens) || inputTokens < 0 || inputTokens > 10_000_000) {
    return undefined;
  }
  if (typeof outputTokens !== "number" || !Number.isInteger(outputTokens) || outputTokens < 0 || outputTokens > 10_000_000) {
    return undefined;
  }
  return { state: "known", inputTokens, outputTokens };
}

function modelField(body: Record<string, unknown>): { ok: true; model?: string } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(body, "model")) {
    return { ok: true };
  }
  const model = body.model;
  if (typeof model !== "string") {
    return { ok: false };
  }
  return { ok: true, model };
}

export function listenPlatform(
  app: PlatformApp,
  options: { port: number; dataDir: string; listenHost?: string; reportGateway?: RealGatewayConfig; aiMockMode?: boolean; harnessMaxBodyBytes?: number },
): Promise<{ port: number; close: () => Promise<void> }> {
  const harnessMaxBody=resolveHarnessBodyLimit(options.harnessMaxBodyBytes??process.env.CPCLAW_HARNESS_MAX_BODY_BYTES);
  const listenHost = options.listenHost ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void handle(app, options.dataDir, req, res, options.reportGateway, options.aiMockMode ?? true,harnessMaxBody);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      const code = "code" in error ? String(error.code) : "UNKNOWN";
      platformLog(options.dataDir, "error", "listen_failed", "平台端口监听失败", { code, listenHost });
      reject(error);
    };
    server.once("error", onError);
    server.listen(options.port, listenHost, () => {
      server.removeListener("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      platformLog(options.dataDir, "info", "listening", "平台端口已监听", { port, listenHost });
      resolve({
        port,
        close: () => new Promise((done, fail) => {
          server.close((error) => {
            traceStores.get(app)?.close();traceStores.delete(app);
            app.close();
            if (error) {
              fail(error);
              return;
            }
            done();
          });
        }),
      });
    });
  });
}

async function handle(app: PlatformApp, dataDir: string, req: IncomingMessage, res: ServerResponse, reportGateway?: RealGatewayConfig, aiMockMode = true,harnessMaxBody=DEFAULT_HARNESS_BODY_BYTES): Promise<void> {
  let requestId = readRequestId(req.headers["x-request-id"]);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const httpStarted=Date.now();
  const httpRoute=['/v1/chat','/v1/harness','/v1/diagnostics','/v1/session','/v1/market','/v1/knowledge','/v1/reports','/v1/models','/v1/me'].find(prefix=>path.startsWith(prefix+'/')||path===prefix)||'other';
  if(path!=='/health')res.once('close',()=>{
    platformLog(dataDir,res.statusCode>=400||!res.writableFinished?'warn':'info','http_request_finished','HTTP 请求结束',{route:httpRoute,status:res.statusCode,completed:res.writableFinished,durationMs:Date.now()-httpStarted},requestId);
  });
  try {
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, {
        schemaVersion: 1,
        status: "ok",
        service: "cpclaw-platform",
        mode: aiMockMode ? "mock" : "real",
        aiMockMode,
        serviceTypes: ALLOWED_SERVICE_TYPES,
        harnessMaxBodyBytes:harnessMaxBody,
      });
      return;
    }
    if (req.method === "GET" && path === "/") {
      res.writeHead(302, { location: "/admin", "cache-control": "no-store" });
      res.end();
      return;
    }
    if (req.method === "GET" && (path === "/admin" || path === "/market")) {
      const html = path === "/market" ? marketPage() : adminPage();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(html),
        ...(path === "/admin" ? { "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } : {}),
      });
      res.end(html);
      return;
    }
    const body = req.method === "POST" ? objectOf(await readBody(req, path === "/v1/harness/completions" ? harnessMaxBody : path === "/v1/diagnostics" ? 524_288 : path === "/v1/chat/stream" || path === "/v1/market" || path === "/v1/knowledge" ? 262_144 : MAX_BODY)) : {};
    if(typeof body?.requestId==='string')requestId=readRequestId(body.requestId)||requestId;
    if (body === undefined) {
      sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "请求体必须是 JSON 对象" });
      return;
    }
    const token = bearer(req);
    if (req.method === "POST" && path === "/v1/session/login") {
      const employeeId = stringField(body, "employeeId");
      const password = stringField(body, "password");
      const deviceLabel = stringField(body, "deviceLabel");
      if (employeeId === undefined || password === undefined || deviceLabel === undefined) {
        sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "登录需要员工编号、口令和设备名" });
        return;
      }
      let guard = loginGuards.get(app);
      if (!guard) { guard = new LoginGuard(); loginGuards.set(app, guard); }
      const ip = req.socket.remoteAddress ?? 'unknown';
      const retryAfter = guard.retryAfter(ip, employeeId);
      if (retryAfter) {
        res.setHeader('retry-after', String(retryAfter));
        sendJson(res, 429, {ok:false, code:'RATE_LIMITED', message:'登录失败次数过多，请稍后重试', retryAfter});
        return;
      }
      const result = app.login({ employeeId, password, deviceLabel });
      guard.record(ip, employeeId, result.ok);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, ...publicSession(result) });
      return;
    }
    if (req.method === "POST" && path === "/v1/session/refresh") {
      const refreshToken = stringField(body, "refreshToken");
      if (refreshToken === undefined) {
        sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "缺少刷新令牌" });
        return;
      }
      const result = await app.refresh(refreshToken);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, ...publicSession(result) });
      return;
    }
    if (token === undefined) {
      sendFailure(res, { ok: false, code: "AUTH_REQUIRED", message: "未登录" });
      return;
    }
    const tracePath=/^\/v1\/me\/request-traces\/([A-Za-z0-9._:-]{1,64})$/.exec(path);
    if(tracePath&&req.method==='GET'){
      const own=app.listOwnSessions(token);if(!own.ok){sendFailure(res,own);return;}
      const actor=own.sessions[0]?.employeeId;
      let store=traceStores.get(app);if(!store){store=requestTraces(dataDir);traceStores.set(app,store);}
      const evidence=actor?store.read(actor,tracePath[1]!):undefined;
      if(!evidence){sendJson(res,404,{ok:false,code:'NOT_FOUND',message:'没有该账号的请求诊断记录'});return;}
      sendJson(res,200,{ok:true,evidence});return;
    }
    if (req.method === 'POST' && path === '/v1/diagnostics') {
      const result=uploadDiagnostic(app,token,body.content,body.idempotencyKey);
      if(!result.ok){sendFailure(res,result);return;}
      sendJson(res,200,result);return;
    }
    const diagnosticPath=/^\/v1\/diagnostics\/(upl-[a-f0-9]+)(\/content)?$/.exec(path);
    if(req.method==='GET'&&diagnosticPath){
      const result=app.getUpload(token,diagnosticPath[1]!);
      if(!result.ok){sendFailure(res,result);return;}
      if(diagnosticPath[2]&&result.upload.fileId){
        const file=app.readPrivateFile(token,result.upload.fileId);
        if(!file.ok){sendFailure(res,file);return;}
        sendJson(res,200,{...result,content:file.body});return;
      }
      sendJson(res,200,result);return;
    }
    if (req.method === "POST" && path === "/v1/knowledge") {
      const result = app.knowledge(token, String(body.action ?? 'list'), objectOf(body.input) ?? {});
      if (!result.ok) { sendFailure(res, result); return; }
      sendJson(res, 200, result); return;
    }
    if (req.method === "POST" && path === "/v1/learning") {
      const result = app.learning(token, String(body.action ?? "published"), objectOf(body.input) ?? {});
      if (!result.ok) { sendFailure(res, result); return; }
      sendJson(res, 200, result); return;
    }
    if (req.method === "POST" && path === "/v1/market") {
      const result = app.market(token, String(body.action ?? "list"), objectOf(body.input) ?? {});
      if (!result.ok) { sendFailure(res, result); return; }
      sendJson(res, 200, result); return;
    }
    if (req.method === "POST" && path === "/v1/session/logout") {
      const result = app.logout(token);
      sendJson(res, result.ok ? 200 : statusFor(result.code), result.ok ? { schemaVersion: 1, ok: true } : { schemaVersion: 1, code: result.code, message: result.message });
      return;
    }
    if (req.method === "GET" && path === "/v1/me/sessions") {
      const result = app.listOwnSessions(token);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, sessions: result.sessions });
      return;
    }
    if (req.method === "GET" && path === "/v1/me/quota") {
      const result = app.readOwnQuota(token);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, quota: result.quota, quotaPolicy:{approvalMode:'auto',maxAdditionalTokens:300_000_000} });
      return;
    }
    if(req.method==='POST'&&path==='/v1/me/quota-requests'){
      if(typeof body.requestId!=='string'||typeof body.additionalTokens!=='number'){
        sendFailure(res,{ok:false,code:'CONFIG_INVALID',message:'额度申请需要requestId与新增tokens整数'});return;
      }
      const result=app.requestOwnQuota(token,{requestId:body.requestId,additionalTokens:body.additionalTokens});
      if(!result.ok){sendFailure(res,result);return;}
      sendJson(res,200,{schemaVersion:1,...result});return;
    }
    if (req.method === "POST" && path === "/v1/chat/stream") {
      const messages = parseChatMessages(body.messages);
      const id = stringField(body, "requestId");
      const own=app.listOwnSessions(token);if(!own.ok){sendFailure(res,own);return;}
      const actor=own.sessions[0]?.employeeId;if(!actor){sendJson(res,401,{ok:false,message:'会话无效'});return;}
      let traces=traceStores.get(app);if(!traces){traces=requestTraces(dataDir);traceStores.set(app,traces);}
      const safeId=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,64}$/.test(v)?v:'';
      const traceId=safeId(body.traceId)||safeId(id)||randomUUID(),started=Date.now();
      const evidence={traceId,requestId:safeId(id),chatId:safeId(body.chatId),messageId:safeId(body.messageId),retryOf:safeId(body.retryOf),appVersion:safeId(body.appVersion),route:'chat',state:'running',code:'',stage:'platform_validate',startedAt:started,finishedAt:0,httpStatus:200,diagnostic:undefined as RequestDiagnostic|undefined};
      const prior=evidence.requestId?traces.read(actor,evidence.requestId) as {state?:string}|undefined:undefined;
      if(prior&&prior.state!=='rejected'){sendJson(res,409,{ok:false,message:'此请求已经受理，请勿重复发送'});return;}
      const save=()=>{try{if(evidence.requestId)traces.save(actor,evidence.requestId,evidence);}catch{process.stderr.write('{"event":"request_trace_write_failed"}\n');}};
      save();
      res.once('finish',()=>{if(!evidence.finishedAt){evidence.finishedAt=Date.now();evidence.httpStatus=res.statusCode;evidence.state=res.statusCode>=400?'rejected':'done';evidence.code=res.statusCode>=400?'PLATFORM_HTTP_'+res.statusCode:'';save();}});
      if (!messages || !id) { sendJson(res, 400, { ok: false, message: "聊天需要有效的上下文和请求编号" }); return; }
      if (!aiMockMode && !reportGateway) { sendJson(res, 503, { ok: false, message: "平台尚未配置聊天模型" }); return; }
      let documentContext: DocumentContext | undefined;
      if (body.documentTools !== undefined) {
        const c=objectOf(body.documentTools);
        if (!c || !Array.isArray(c.files) || c.files.length>12 || c.files.some(f=>!objectOf(f)||typeof f.id!=='string'||f.id.length>64||typeof f.name!=='string'||f.name.length>120)) { sendJson(res,400,{ok:false,message:'文档上下文无效'});return; }
        documentContext={files:c.files.map(f=>({id:String(f.id),name:String(f.name)}))};
        const version=typeof body.appVersion==='string'?/^0\.0\.(\d+)$/.exec(body.appVersion):null;documentContext.sectioned=Boolean(version&&Number(version[1])>=40);
        if(['document','answer'].includes(String(body.retryRoute)))documentContext.retryRoute=String(body.retryRoute);
        if(c.draft!==undefined){if(!documentContext.sectioned){sendJson(res,400,{ok:false,message:'当前客户端不支持文档草稿续接'});return;}const d=objectOf(c.draft);if(!d||typeof d.filename!=='string'||typeof d.sourceId!=='string'||typeof d.tail!=='string'||d.tail.length>8000||typeof d.chars!=='number'||d.chars<0||d.chars>128000){sendJson(res,400,{ok:false,message:'文档草稿上下文无效'});return;}documentContext.draft={filename:d.filename,sourceId:d.sourceId,tail:d.tail,chars:d.chars};}

        if(c.active!==undefined){const a=objectOf(c.active);if(!a||typeof a.id!=='string'||typeof a.name!=='string'||typeof a.body!=='string'||a.body.length>10000||!documentContext.files.some(f=>f.id===a.id)){sendJson(res,400,{ok:false,message:'当前文档无效或超过编辑上限'});return;}documentContext.active={id:a.id,name:a.name,body:a.body};}
      }
      let serviceContext: ServiceContext | undefined;
      if(body.serviceTools!==undefined){
        const c=objectOf(body.serviceTools);
        const reason=invalidCatalogReason(c,ALLOWED_SERVICE_TYPES);
        if(reason){sendJson(res,400,{ok:false,message:'应用服务目录无效',reason});return;}
        serviceContext={services:(c as {services:{id:unknown;title:unknown;type:unknown}[]}).services.map(s=>({id:String(s.id),title:String(s.title),type:String(s.type)})),activeId:(c as {activeId:unknown}).activeId as string};
      }
      const held = app.beginReport(token, id);
      if (!held.ok) { evidence.code=held.code;evidence.stage='platform_reserve';evidence.state='rejected';evidence.httpStatus=statusFor(held.code);evidence.finishedAt=Date.now();save();sendFailure(res, held); return; }
      if (held.replayed) { sendJson(res, 409, { ok: false, message: "此请求已经受理，请勿重复发送" }); return; }
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) {controller.abort();evidence.state='cancelled';evidence.code='CLIENT_DISCONNECTED';evidence.finishedAt=Date.now();save();} };
      res.on("close", cancel);
      let usage: UsageView = { state: "unknown" };
      const write = async (event: object): Promise<void> => {
        controller.signal.throwIfAborted();
        const permission = app.listOwnSessions(token);
        if (!permission.ok) throw new Error("会话已失效，请重新登录");
        if (!res.write(JSON.stringify(event) + "\n")) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => { res.off("drain", drained); res.off("close", closed); };
            const drained = (): void => { cleanup(); resolve(); };
            const closed = (): void => { cleanup(); reject(new Error("连接已关闭")); };
            res.once("drain", drained); res.once("close", closed);
          });
        }
      };
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
      res.flushHeaders();
      evidence.stage='model_connect';save();
      platformLog(dataDir,'info','chat_request_started','聊天请求开始',{traceId,chatId:evidence.chatId,retryOf:evidence.retryOf,appVersion:evidence.appVersion},id);
      try {
        await write({ event: "start",traceId,requestId:id, mode: reportGateway ? "real" : "mock", model: "MiniMax-M3" });
        if (reportGateway) {
          let lastActivity=0;
          usage = await streamChat(reportGateway, messages, controller.signal, text => write({ event: "delta", text }), documentContext ? {
            context:documentContext,
            ...(serviceContext?{services:serviceContext,onService:async(request: {serviceId:string;purpose:string})=>{await write({event:"service_request",request});}}:{}),
            onActivity: async()=>{if(Date.now()-lastActivity>300){lastActivity=Date.now();await write({event:'activity',message:'正在整理内容…'});}},
            onCheckpoint:async document=>{await write({event:'document_checkpoint',document});},
            onDocument: async document=>{if(document.complete===false&&!documentContext?.sectioned)throw Error('当前客户端不支持分段文档');if(document.complete===false)await write({event:'document_part',document});else{await write({event:'document',document});await write({event:'delta',text:document.content});}},
          } : undefined,record=>{evidence.diagnostic=record;evidence.stage=record.stage;evidence.code=record.code;save();});
        } else {
          const { setTimeout: delay } = await import("node:timers/promises");
          const text = `【Mock 演示】已收到：${messages.at(-1)?.content}\n\n这是用于验证聊天交互的合成回复，未调用真实模型。当前上下文包含 ${messages.length} 条消息。`;
          for (const piece of text.match(/[^]{1,12}/gu) ?? []) {
            await delay(25, undefined, { signal: controller.signal });
            await write({ event: "delta", text: piece });
          }
        }
        const settled = held.finish(usage);
        if (!settled.ok) throw new Error(settled.message);
        evidence.state='done';evidence.finishedAt=Date.now();save();
        await write({event:'diagnostic',traceId,requestId:id,diagnostic:evidence.diagnostic});
        await write({ event: "done", usage });
      } catch (error) {
        held.finish(usage);
        evidence.state=controller.signal.aborted?'cancelled':'error';evidence.finishedAt=Date.now();
        if(error instanceof RequestDiagnosticError)evidence.diagnostic=error.diagnostic;
        evidence.code=evidence.diagnostic?.code||evidence.code||(controller.signal.aborted?'CLIENT_DISCONNECTED':'PLATFORM_STREAM_FAILED');save();
        if (!res.destroyed && !controller.signal.aborted) res.write(JSON.stringify({ event: "error",traceId,requestId:id,code:evidence.code,stage:evidence.stage,diagnostic:evidence.diagnostic,message: error instanceof Error ? error.message : "聊天调用失败" }) + "\n");
      } finally {
        platformLog(dataDir,evidence.state==='done'?'info':'error','chat_request_finished','聊天请求结束',{traceId,chatId:evidence.chatId,code:evidence.code,stage:evidence.stage,state:evidence.state,durationMs:Date.now()-started},id);
        res.off("close", cancel); res.end();
      }
      return;
    }
    if (req.method === "POST" && path === "/v1/harness/completions") {
      if (reportGateway === undefined) { sendJson(res, 503, { ok: false, message: "真实模型网关未启用" }); return; }
      const id = readRequestId(req.headers["x-request-id"]);
      const own=app.listOwnSessions(token);if(!own.ok){sendFailure(res,own);return;}
      const actor=own.sessions[0]?.employeeId;if(!actor){sendJson(res,401,{ok:false,message:'会话无效'});return;}
      let traces=traceStores.get(app);if(!traces){traces=requestTraces(dataDir);traceStores.set(app,traces);}
      const safeHeader=(key:string)=>{const v=req.headers[key];return typeof v==='string'&&/^[A-Za-z0-9._:-]{1,64}$/.test(v)?v:'';};
      const started=Date.now(),traceId=safeHeader('x-trace-id')||id||randomUUID();
      const evidence={traceId,requestId:id||'',parentRequestId:safeHeader('x-parent-request-id'),chatId:safeHeader('x-chat-id'),harnessSessionId:safeHeader('x-harness-session-id'),route:'harness',state:'running',stage:'platform_validate',code:'',startedAt:started,finishedAt:0,httpStatus:200,diagnostic:undefined as RequestDiagnostic|undefined};
      const prior=id?traces.read(actor,id) as {state?:string}|undefined:undefined;
      if(prior&&prior.state!=='rejected'){sendJson(res,409,{ok:false,message:'模型请求已受理'});return;}
      const save=()=>{try{if(id)traces.save(actor,id,evidence);}catch{process.stderr.write('{"event":"request_trace_write_failed"}\n');}};save();
      res.once('finish',()=>{if(!evidence.finishedAt){evidence.finishedAt=Date.now();evidence.httpStatus=res.statusCode;evidence.state=res.statusCode>=400?'rejected':'done';evidence.code=res.statusCode>=400?'PLATFORM_HTTP_'+res.statusCode:'';save();}});
      const pipeline=req.headers['x-cpclaw-pipeline']==='v1';
      const pipelineTools=new Set(['list_resources','read_resource','discover_service','read_file','write_file','terminal','call_cli','call_mcp','browser_open','browser_snapshot','browser_click','browser_type','browser_scroll','browser_press','deliver_document','register_document','submit_result','read_tool_result','diagnostic_inspect','diagnostic_repair','diagnostic_verify']);
      const toolsValid=Array.isArray(body.tools)&&(pipeline?body.tools.length>=1&&body.tools.length<=pipelineTools.size&&body.tools.every(t=>pipelineTools.has(String(objectOf(objectOf(t)?.function)?.name))):body.tools.length===1&&['read_material','service_action'].includes(String(objectOf(objectOf(body.tools[0])?.function)?.name)));
      if(!id||body.model!=='MiniMax-M3'||!Array.isArray(body.messages)||body.messages.length<1||body.messages.length>(pipeline?256:128)||!toolsValid){sendJson(res,400,{ok:false,message:'Harness 模型或注册工具契约无效'});return;}
      const held = app.beginReport(token, id);
      if (!held.ok) { evidence.code=held.code;evidence.stage='platform_reserve';evidence.state='rejected';evidence.httpStatus=statusFor(held.code);evidence.finishedAt=Date.now();save();sendFailure(res, held); return; }
      if (held.replayed) { sendJson(res, 409, { ok: false, message: "模型请求已受理" }); return; }
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", cancel);
      try {
        evidence.stage='model_connect';save();
        const generated = await completeHarness(reportGateway, body, controller.signal,record=>{evidence.diagnostic=record;evidence.code=record.code;evidence.stage=record.stage;save();},pipeline?async chunk=>{if(!res.headersSent)res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});if(!res.write(chunk))await new Promise<void>((resolve,reject)=>{const cleanup=()=>{res.off('drain',drained);res.off('close',closed);};const drained=()=>{cleanup();resolve();};const closed=()=>{cleanup();reject(Error('客户端断开'));};res.once('drain',drained);res.once('close',closed);});}:undefined);
        held.finish(generated.usage);
        const permission = app.listOwnSessions(token);
        if (!permission.ok) { sendFailure(res, permission); return; }
        if(!res.headersSent)res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        evidence.state=evidence.code==='MODEL_OUTPUT_LIMIT'?'error':'done';evidence.finishedAt=Date.now();save();res.end(pipeline?undefined:generated.raw);
      } catch(error) {
        held.finish(error instanceof HarnessFinalCheckpointError?error.usage:{ state: "unknown" });
        if(error instanceof RequestDiagnosticError)evidence.diagnostic=error.diagnostic;
        const supportsCheckpoint=req.headers['x-cpclaw-harness-final']==='v1';
        evidence.state=controller.signal.aborted?'cancelled':'error';evidence.code=evidence.diagnostic?.code||(controller.signal.aborted?'CLIENT_DISCONNECTED':'HARNESS_MODEL_FAILED');evidence.httpStatus=supportsCheckpoint&&evidence.code==='MODEL_OUTPUT_LIMIT'?422:502;evidence.finishedAt=Date.now();save();
        if(res.headersSent){if(!res.destroyed)res.destroy();}
        else if (!res.destroyed) sendJson(res,evidence.httpStatus,{ok:false,code:evidence.code,traceId,requestId:id,diagnostic:evidence.diagnostic,...(supportsCheckpoint&&error instanceof HarnessFinalCheckpointError?{checkpoint:error.content}:{}),message:evidence.code==='MODEL_OUTPUT_LIMIT'?'内核答复达到长度上限，需续接最终交付':'Harness 模型调用失败或已取消'});
      } finally {
        platformLog(dataDir,evidence.state==='done'?'info':'error','harness_request_finished','内核模型请求结束',{traceId,parentRequestId:evidence.parentRequestId,chatId:evidence.chatId,code:evidence.code,stage:evidence.stage,state:evidence.state,durationMs:Date.now()-started},id);
        res.removeListener("close", cancel);
      }
      return;
    }
    if (req.method === "POST" && path === "/v1/reports/generate") {
      if (reportGateway === undefined) {
        sendJson(res, 503, { ok: false, code: "MODEL_UNAVAILABLE", message: "平台未启用真实 MiniMax 报告网关" });
        return;
      }
      const reportInput = parseReportInput(body);
      const reportRequestId = stringField(body, "requestId");
      if (reportInput === undefined || reportRequestId === undefined) {
        sendJson(res, 400, { ok: false, code: "SCHEMA_INVALID", message: "报告需要目标、明确材料与 requestId" });
        return;
      }
      const held = app.beginReport(token, reportRequestId);
      if (!held.ok) { sendFailure(res, held); return; }
      // 重放不重新扣费或启动供应商调用；客户端以新执行显式重试。
      if (held.replayed) {
        sendJson(res, 409, { ok: false, code: "CONFLICT", message: "该模型请求已受理，不重复调用" });
        return;
      }
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", cancel);
      let usage: UsageView = { state: "unknown" };
      try {
        const generated = await generateReport(reportGateway, reportInput, controller.signal);
        usage = generated.usage;
        const check = checkReport(generated.text, reportInput.materials.map(m => m.fileName));
        const referencesValid = reportInput.materials.every(m => m.paragraphs.every(p => generated.text.includes(`${m.fileName}#${p.id}`)));
        const settled = held.finish(usage);
        if (!settled.ok) { sendFailure(res, settled); return; }
        const permission = app.listOwnSessions(token);
        if (!permission.ok) { sendFailure(res, permission); return; }
        if (!check.ok || !referencesValid) throw new Error("报告结构或来源检查失败");
        if (!controller.signal.aborted) sendJson(res, 200, { ok: true, model: "MiniMax-M3", text: generated.text, usage, check });
      } catch {
        held.finish(usage);
        if (!res.destroyed) sendJson(res, 502, { ok: false, code: "MODEL_FAILED", message: "MiniMax 调用失败、超时或报告检查未通过" });
      } finally { res.removeListener("close", cancel); }
      return;
    }
    if (req.method === "POST" && path === "/v1/models/reserve") {
      const requestId = stringField(body, "requestId");
      const model = modelField(body);
      if (requestId === undefined || !model.ok) {
        sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "预留需要 requestId" });
        return;
      }
      const result = app.reserve(token, model.model === undefined ? { requestId } : { requestId, model: model.model });
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      const { ok: reservedOk, ...reserved } = result;
      void reservedOk;
      sendJson(res, 200, { schemaVersion: 1, ...reserved });
      return;
    }
    if (req.method === "POST" && path === "/v1/models/settle") {
      const requestId = stringField(body, "requestId");
      const usage = parseUsage(body.usage);
      if (requestId === undefined || usage === undefined) {
        sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "结算需要 requestId 和用量" });
        return;
      }
      const result = app.settle(token, { requestId, usage });
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      const { ok: settledOk, ...settled } = result;
      void settledOk;
      sendJson(res, 200, { schemaVersion: 1, ...settled });
      return;
    }
    if (req.method === "POST" && path === "/v1/models/invoke") {
      if (!aiMockMode) { sendJson(res, 409, { ok: false, code: "REAL_MODE_REQUIRED", message: "真实环境请使用报告或 Harness 接口" }); return; }
      const requestId = stringField(body, "requestId");
      const kind = stringField(body, "kind");
      const model = modelField(body);
      if (requestId === undefined || kind === undefined || !model.ok) {
        sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "调用需要 requestId 和 kind" });
        return;
      }
      const result = app.invoke(token, model.model === undefined ? { requestId, kind } : { requestId, kind, model: model.model });
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      if (result.kind === "stream" && result.deltas.length > 0) {
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        });
        for (const text of result.deltas) {
          res.write(`${JSON.stringify({ schemaVersion: 1, event: "delta", text })}\n`);
        }
        const done = {
          schemaVersion: 1,
          event: "done",
          requestId: result.requestId,
          model: result.model,
          text: result.text,
          usage: result.usage,
          reservationStatus: result.reservationStatus,
        };
        res.end(`${JSON.stringify(done)}\n`);
        return;
      }
      const { ok: invokedOk, ...invoked } = result;
      void invokedOk;
      sendJson(res, 200, { schemaVersion: 1, ...invoked });
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/manage") {
      const result = app.admin(token, String(body.action ?? ""), objectOf(body.input) ?? {});
      if (!result.ok) { sendFailure(res, result); return; }
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET" && path === "/v1/admin/employees") {
      const result = app.listEmployees(token);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, employees: result.employees });
      return;
    }
    if (req.method === "GET" && path === "/v1/admin/audit") {
      const result = app.listAudit(token);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, entries: result.entries });
      return;
    }
    if (req.method === "GET" && path === "/v1/admin/provider") {
      const result = app.providerView(token);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, model: result.model, keyPresent: result.keyPresent });
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/sessions/revoke") {
      const sessionId = stringField(body, "sessionId");
      if (sessionId === undefined) {
        sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "缺少 sessionId" });
        return;
      }
      const result = app.revoke(token, sessionId);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, ok: true });
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/employees/disable") {
      const employeeId = stringField(body, "employeeId");
      if (employeeId === undefined) {
        sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "缺少 employeeId" });
        return;
      }
      const result = app.disable(token, employeeId);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, ok: true });
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/quota") {
      const employeeId = stringField(body, "employeeId");
      const limitTokens = body.limitTokens;
      const concurrentLimit = body.concurrentLimit;
      if (employeeId === undefined || typeof limitTokens !== "number" || typeof concurrentLimit !== "number") {
        sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: "额度更新需要员工、上限和并发" });
        return;
      }
      const result = app.setQuota(token, { employeeId, limitTokens, concurrentLimit });
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, ok: true });
      return;
    }
    if (req.method === "POST" && path === "/v1/admin/backup") {
      const result = app.backup(token);
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      sendJson(res, 200, { schemaVersion: 1, fileName: result.fileName, bytes: result.bytes });
      return;
    }
    sendJson(res, 404, { schemaVersion: 1, code: "NOT_FOUND", message: "未知路径" });
    platformLog(dataDir, "info", "not_found", "拒绝未知路径", { method: req.method ?? "" }, requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求失败";
    if(error instanceof BodyTooLargeError&&!res.headersSent){
      platformLog(dataDir,'warn','request_body_rejected','请求体超过传输上限',{receivedBytes:error.receivedBytes,limitBytes:error.limitBytes},requestId);
      sendJson(res,413,{ok:false,code:'REQUEST_BODY_TOO_LARGE',message:'请求上下文超过平台传输上限，原任务及已有成果保留；请缩减上下文或调整平台传输配置',diagnostic:{code:'REQUEST_BODY_TOO_LARGE',stage:'platform_validate',outcome:'rejected',httpStatus:413,requestBytes:error.receivedBytes,requestLimitBytes:error.limitBytes}});return;
    }
    if (!res.headersSent) {
      sendFailure(res, { ok: false, code: "CONFIG_INVALID", message: message === "BODY_TOO_LARGE" ? "请求体过大" : "请求体无法解析" });
    }
  }
}

export async function servePlatform(config: PlatformConfig): Promise<{ port: number; close: () => Promise<void> }> {
  const opened = openPlatform(config);
  if (!opened.ok) {
    platformLog(config.dataDir, "error", "platform_open_failed", opened.message);
    throw new Error(opened.message);
  }
  return listenPlatform(opened.app, {
    ...(config.reportGateway === undefined ? {} : { reportGateway: config.reportGateway }),
    aiMockMode: config.aiMockMode ?? true,
    port: config.port,
    dataDir: config.dataDir,
    listenHost: config.listenHost,
  });
}

function parseReportInput(body: Record<string, unknown>): ReportInput | undefined {
  if (typeof body.goal !== "string" || body.goal.length < 1 || body.goal.length > 500 || !Array.isArray(body.materials) || body.materials.length < 1 || body.materials.length > 8) return undefined;
  const materials: ReportInput["materials"] = [];
  for (const raw of body.materials) {
    const m = objectOf(raw);
    if (m === undefined || typeof m.fileName !== "string" || !/^[\w.\-\u4e00-\u9fff]{1,100}$/.test(m.fileName) || !Array.isArray(m.paragraphs) || m.paragraphs.length < 1 || m.paragraphs.length > 64) return undefined;
    const paragraphs: ReportInput["materials"][number]["paragraphs"] = [];
    for (const rawParagraph of m.paragraphs) {
      const p = objectOf(rawParagraph);
      if (p === undefined || typeof p.id !== "string" || !/^[A-Za-z0-9-]{1,40}$/.test(p.id) || typeof p.text !== "string" || p.text.length < 1 || p.text.length > 4000) return undefined;
      paragraphs.push({ id: p.id, text: p.text });
    }
    materials.push({ fileName: m.fileName, paragraphs });
  }
  return { goal: body.goal, materials };
}

function parseChatMessages(value: unknown): ChatMessage[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 31) return undefined;
  const messages: ChatMessage[] = [];
  let size = 0;
  for (const item of value) {
    const message = objectOf(item);
    if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || !message.content.trim() || message.content.length > 16_000) return undefined;
    if (message.role !== (messages.length % 2 === 0 ? "user" : "assistant")) return undefined;
    size += message.content.length;
    if (size > 32_000) return undefined;
    messages.push({ role: message.role, content: message.content });
  }
  return messages.at(-1)?.role === "user" ? messages : undefined;
}

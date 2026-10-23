import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PlatformConfig } from "./config.js";
import { adminPage } from "./admin-page.js";
import { openPlatform, type PlatformApp, type PlatformCode, type PlatformFailure, type UsageView } from "./app.js";
import { platformLog } from "./log.js";

const MAX_BODY = 16_384;

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

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
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
  options: { port: number; dataDir: string; listenHost?: string },
): Promise<{ port: number; close: () => Promise<void> }> {
  const listenHost = options.listenHost ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void handle(app, options.dataDir, req, res);
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

async function handle(app: PlatformApp, dataDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = readRequestId(req.headers["x-request-id"]);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, {
        schemaVersion: 1,
        status: "ok",
        service: "cpclaw-platform",
        mode: "mock",
        aiMockMode: true,
      });
      return;
    }
    if (req.method === "GET" && path === "/admin") {
      const html = adminPage();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }
    const body = req.method === "POST" ? objectOf(await readBody(req)) : {};
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
      const result = app.login({ employeeId, password, deviceLabel });
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
      sendJson(res, 200, { schemaVersion: 1, quota: result.quota });
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
    port: config.port,
    dataDir: config.dataDir,
    listenHost: config.listenHost,
  });
}

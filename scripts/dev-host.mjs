import { createServer } from "node:http";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHealthReport, createLogEvent, resolveDevHostConfig } from "@cpclaw/contracts";
import { homedir } from "node:os";

const MAX_LOG_BYTES = 1024 * 1024;

function pick(name) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
    return undefined;
  }
  return process.env[name];
}

const configResult = resolveDevHostConfig(
  {
    AI_MOCK_MODE: pick("AI_MOCK_MODE"),
    CPCLAW_DATA_DIR: pick("CPCLAW_DATA_DIR"),
    CPCLAW_DEV_HOST_PORT: pick("CPCLAW_DEV_HOST_PORT"),
  },
  { homeDir: homedir(), target: "local" },
);

function writeLog(dataDir, entry) {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "dev-host.log");
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      process.stderr.write(`${JSON.stringify({ level: "error", event: "log_rotate_failed" })}\n`);
    }
  }
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

function log(dataDir, level, event, message, fields, requestId) {
  const input = {
    timestamp: new Date().toISOString(),
    level,
    service: "cpclaw-dev-host",
    event,
    message,
  };
  if (requestId !== undefined) {
    input.requestId = requestId;
  }
  if (fields !== undefined) {
    input.fields = fields;
  }
  const created = createLogEvent(input);
  if (!created.ok) {
    process.stderr.write(`${JSON.stringify({ level: "error", event: "log_rejected", message: created.message })}\n`);
    return;
  }
  const line = JSON.stringify(created.event);
  process.stderr.write(`${line}\n`);
  if (dataDir !== undefined) {
    writeLog(dataDir, created.event);
  }
}

if (!configResult.ok) {
  log(undefined, "error", "config_rejected", configResult.message, { code: configResult.code });
  process.exit(1);
}

const config = configResult.config;
const health = createHealthReport({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
});

if (!health.ok) {
  log(config.dataDir, "error", "runtime_rejected", health.message, { code: health.code });
  process.exit(1);
}

const report = health.report;
mkdirSync(join(config.dataDir, "logs"), { recursive: true });

function readRequestId(header) {
  if (typeof header !== "string") {
    return undefined;
  }
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(header)) {
    return undefined;
  }
  return header;
}

const server = createServer((req, res) => {
  const requestId = readRequestId(req.headers["x-request-id"]);
  const path = req.url ?? "";
  if (req.method === "GET" && path === "/health") {
    const body = JSON.stringify(report);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    log(config.dataDir, "info", "health_ok", "健康检查应答", { port: config.port }, requestId);
    return;
  }
  const body = JSON.stringify({
    schemaVersion: 1,
    code: "NOT_FOUND",
    message: "未知路径",
  });
  res.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
  log(config.dataDir, "info", "not_found", "拒绝未知路径", { port: config.port }, requestId);
});

server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
server.on("error", (error) => {
  const code = "code" in error ? String(error.code) : "UNKNOWN";
  log(config.dataDir, "error", "listen_failed", "监听失败", { code });
  process.exit(1);
});

function shutdown(signal) {
  log(config.dataDir, "info", "shutting_down", "正在关闭健康进程", { signal });
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 3_000).unref();
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGHUP", () => {
  log(config.dataDir, "info", "sighup_ignored", "忽略挂起信号，停止请使用 stop.sh");
});

server.listen(config.port, "127.0.0.1", () => {
  log(config.dataDir, "info", "listening", "健康端口已监听", { port: config.port });
});

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogEvent } from "@cpclaw/contracts";

const MAX_LOG_BYTES = 1024 * 1024;
const SENSITIVE = /(Bearer\s+\S+|api[_-]?key|refreshToken|password|secret|\/Users\/[^\s"]+)/gi;

const FILE_BY_SERVICE = {
  "cpclaw-desktop-host": "desktop-host.log",
  "cpclaw-desktop-worker": "desktop-worker.log",
  "cpclaw-desktop-ui": "desktop-ui.log",
};

function logPath(dataDir, service) {
  return join(dataDir, "logs", FILE_BY_SERVICE[service] || "desktop-worker.log");
}

function rotateIfNeeded(path) {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      process.stderr.write(`${JSON.stringify({ level: "error", event: "log_rotate_failed" })}\n`);
    }
  }
}

/** 结构化日志：stderr + 落盘；失败不抛。 */
export function desktopLog(dataDir, service, level, event, message, fields) {
  const input = {
    timestamp: new Date().toISOString(),
    level,
    service,
    event,
    message: String(message || "untitled").slice(0, 500),
  };
  if (fields && Object.keys(fields).length) input.fields = fields;
  const created = createLogEvent(input);
  if (!created.ok) {
    process.stderr.write(`${JSON.stringify({ level: "error", event: "log_rejected", message: created.message })}\n`);
    return;
  }
  const line = JSON.stringify(created.event);
  process.stderr.write(`${line}\n`);
  if (!dataDir) return;
  try {
    const dir = join(dataDir, "logs");
    mkdirSync(dir, { recursive: true });
    const path = logPath(dataDir, service);
    rotateIfNeeded(path);
    appendFileSync(path, `${line}\n`, "utf8");
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: "error", event: "log_write_failed", message: error instanceof Error ? error.message : "write failed" })}\n`);
  }
}

function redact(text) {
  return String(text || "").replace(SENSITIVE, "[redacted]").slice(0, 240);
}

function readLogFile(path, limit) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean);
  const slice = lines.slice(Math.max(0, lines.length - limit));
  const out = [];
  for (const line of slice) {
    try {
      const row = JSON.parse(line);
      out.push({
        timestamp: row.timestamp || "",
        level: row.level || "info",
        service: row.service || "",
        event: row.event || "",
        message: redact(row.message || ""),
        chatId: row.fields?.chatId,
        requestId: row.requestId || row.fields?.requestId,
      });
    } catch {
      out.push({ timestamp: "", level: "warn", service: "", event: "log_parse", message: redact(line) });
    }
  }
  return out;
}

/** 读取近期日志；可按 chatId 过滤（字段匹配）。 */
export function readRecentLogs(dataDir, { chatId = "", limit = 40 } = {}) {
  const perFile = Math.max(10, Math.ceil(limit / 2));
  const rows = [
    ...readLogFile(join(dataDir, "logs", "desktop-worker.log"), perFile),
    ...readLogFile(join(dataDir, "logs", "desktop-ui.log"), perFile),
    ...readLogFile(join(dataDir, "logs", "desktop-host.log"), perFile),
  ];
  rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const filtered = chatId
    ? rows.filter((r) => r.chatId === chatId || /chat|diagnos|kernel|skill|harness|bridge/i.test(`${r.event} ${r.message}`))
    : rows;
  return filtered.slice(-limit);
}

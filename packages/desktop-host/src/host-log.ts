import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogEvent, type LogLevel } from "@cpclaw/contracts";

const MAX_LOG_BYTES = 1024 * 1024;

export function hostLog(
  dataDir: string,
  level: LogLevel,
  event: string,
  message: string,
  fields?: Record<string, string | number | boolean>,
): void {
  const input: {
    timestamp: string;
    level: LogLevel;
    service: "cpclaw-desktop-host";
    event: string;
    message: string;
    fields?: Record<string, string | number | boolean>;
  } = {
    timestamp: new Date().toISOString(),
    level,
    service: "cpclaw-desktop-host",
    event,
    message,
  };
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
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "desktop-host.log");
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      process.stderr.write(`${JSON.stringify({ level: "error", event: "log_rotate_failed" })}\n`);
    }
  }
  appendFileSync(path, `${line}\n`, "utf8");
}

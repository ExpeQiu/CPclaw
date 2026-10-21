import { homedir } from "node:os";
import { resolvePlatformConfig, servePlatform } from "@cpclaw/platform";

function pick(name) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
    return undefined;
  }
  return process.env[name];
}

const result = resolvePlatformConfig(
  {
    AI_MOCK_MODE: pick("AI_MOCK_MODE"),
    CPCLAW_DATA_DIR: pick("CPCLAW_DATA_DIR"),
    CPCLAW_PLATFORM_PORT: pick("CPCLAW_PLATFORM_PORT"),
    CPCLAW_SESSION_SECRET: pick("CPCLAW_SESSION_SECRET"),
    CPCLAW_PLATFORM_SEED: pick("CPCLAW_PLATFORM_SEED"),
    CPCLAW_BOOTSTRAP_FILE: pick("CPCLAW_BOOTSTRAP_FILE"),
    CPCLAW_ACCESS_TTL_SEC: pick("CPCLAW_ACCESS_TTL_SEC"),
    CPCLAW_REFRESH_TTL_SEC: pick("CPCLAW_REFRESH_TTL_SEC"),
    MINIMAX_API_KEY: pick("MINIMAX_API_KEY"),
  },
  { homeDir: homedir() },
);

if (!result.ok) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    service: "cpclaw-platform",
    event: "config_rejected",
    message: result.message,
  })}\n`);
  process.exit(1);
}

let started;
try {
  started = await servePlatform(result.config);
} catch (error) {
  const message = error instanceof Error ? error.message : "平台启动失败";
  process.stderr.write(`${JSON.stringify({ level: "error", event: "platform_start_failed", message })}\n`);
  process.exit(1);
}

let closing = false;
async function shutdown(signal) {
  if (closing) {
    return;
  }
  closing = true;
  process.stderr.write(`${JSON.stringify({ level: "info", event: "shutting_down", message: "正在关闭平台进程", signal })}\n`);
  try {
    await started.close();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "关闭失败";
    process.stderr.write(`${JSON.stringify({ level: "error", event: "shutdown_failed", message })}\n`);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGHUP", () => {
  process.stderr.write(`${JSON.stringify({ level: "info", event: "sighup_ignored", message: "忽略挂起信号，停止请使用 stop-platform.sh" })}\n`);
});

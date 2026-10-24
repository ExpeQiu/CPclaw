import { homedir } from "node:os";
import { resolvePlatformConfig } from "@cpclaw/platform";

if (process.env.CPCLAW_MODEL_ENV_FILE) {
  const { readFileSync } = await import("node:fs");
  const { parseEnv } = await import("node:util");
  const vars = parseEnv(readFileSync(process.env.CPCLAW_MODEL_ENV_FILE, "utf8"));
  for (const name of ["MINIMAX_API_KEY", "MINIMAX_BASE_URL", "MINIMAX_OPENAI_BASE_URL", "CPCLAW_REPORT_MODEL_MODE"]) {
    if (process.env[name] === undefined && vars[name] !== undefined) process.env[name] = vars[name];
  }
}
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
    CPCLAW_LISTEN_HOST: pick("CPCLAW_LISTEN_HOST"),
    CPCLAW_SESSION_SECRET: pick("CPCLAW_SESSION_SECRET"),
    CPCLAW_PLATFORM_SEED: pick("CPCLAW_PLATFORM_SEED"),
    CPCLAW_BOOTSTRAP_FILE: pick("CPCLAW_BOOTSTRAP_FILE"),
    CPCLAW_ACCESS_TTL_SEC: pick("CPCLAW_ACCESS_TTL_SEC"),
    CPCLAW_REFRESH_TTL_SEC: pick("CPCLAW_REFRESH_TTL_SEC"),
    MINIMAX_API_KEY: pick("MINIMAX_API_KEY"),
    CPCLAW_REPORT_MODEL_MODE: pick("CPCLAW_REPORT_MODEL_MODE"),
    MINIMAX_OPENAI_BASE_URL: pick("MINIMAX_OPENAI_BASE_URL"),
    MINIMAX_BASE_URL: pick("MINIMAX_BASE_URL"),
  },
  { homeDir: homedir() },
);

if (!result.ok) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    service: "cpclaw-lifecycle",
    event: "config_rejected",
    message: result.message,
    code: result.code,
  })}\n`);
  process.exit(1);
}

function shQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

process.stdout.write(`AI_MOCK_MODE=${shQuote(String(result.config.aiMockMode ?? true))}\n`);
process.stdout.write(`CPCLAW_DATA_DIR=${shQuote(result.config.dataDir)}\n`);
process.stdout.write(`CPCLAW_PLATFORM_PORT=${shQuote(String(result.config.port))}\n`);
process.stdout.write(`CPCLAW_LISTEN_HOST=${shQuote(result.config.listenHost)}\n`);
process.stdout.write(`CPCLAW_SESSION_SECRET=${shQuote(result.config.sessionSecret)}\n`);
process.stdout.write(`CPCLAW_PLATFORM_SEED=${shQuote(result.config.seed.kind === "fixture" ? "fixture" : "")}\n`);
if (result.config.seed.kind === "bootstrap") {
  process.stdout.write(`CPCLAW_BOOTSTRAP_FILE=${shQuote(result.config.seed.path)}\n`);
}
process.stdout.write(`CPCLAW_ACCESS_TTL_SEC=${shQuote(String(result.config.accessTtlSec))}\n`);
process.stdout.write(`CPCLAW_REFRESH_TTL_SEC=${shQuote(String(result.config.refreshTtlSec))}\n`);

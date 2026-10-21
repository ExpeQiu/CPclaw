import { homedir } from "node:os";
import { resolveDevHostConfig } from "@cpclaw/contracts";

const targetFlag = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetFlag === undefined ? "local" : targetFlag.slice("--target=".length);

function pick(name) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
    return undefined;
  }
  return process.env[name];
}

const result = resolveDevHostConfig(
  {
    AI_MOCK_MODE: pick("AI_MOCK_MODE"),
    CPCLAW_DATA_DIR: pick("CPCLAW_DATA_DIR"),
    CPCLAW_DEV_HOST_PORT: pick("CPCLAW_DEV_HOST_PORT"),
  },
  { homeDir: homedir(), target },
);

if (!result.ok) {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: "cpclaw-lifecycle",
      event: "config_rejected",
      message: result.message,
      code: result.code,
    })}\n`,
  );
  process.exit(1);
}

function shQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

process.stdout.write(`AI_MOCK_MODE=${shQuote("true")}\n`);
process.stdout.write(`CPCLAW_DATA_DIR=${shQuote(result.config.dataDir)}\n`);
process.stdout.write(`CPCLAW_DEV_HOST_PORT=${shQuote(String(result.config.port))}\n`);
process.stdout.write(`CPCLAW_TARGET=${shQuote(result.config.target)}\n`);

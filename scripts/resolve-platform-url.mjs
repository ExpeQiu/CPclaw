/**
 * 解析本机联调用的平台基址。
 * 有 CPCLAW_PLATFORM_URL 时用远程；否则用环回与端口。
 * 空字符串拒绝回落。
 */
function presence(env, key) {
  if (!Object.prototype.hasOwnProperty.call(env, key)) {
    return "missing";
  }
  const value = env[key];
  if (value === undefined) {
    return "missing";
  }
  if (value === "") {
    return "empty";
  }
  return "value";
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    service: "cpclaw-lifecycle",
    event: "platform_url_rejected",
    message,
  })}\n`);
  process.exit(1);
}

const env = process.env;
const urlState = presence(env, "CPCLAW_PLATFORM_URL");
if (urlState === "empty") {
  fail("CPCLAW_PLATFORM_URL 为空字符串，不会回落到本机平台");
}

let base;
let mode;
if (urlState === "value") {
  const raw = env.CPCLAW_PLATFORM_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("CPCLAW_PLATFORM_URL 必须是合法 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("CPCLAW_PLATFORM_URL 只接受 http 或 https");
  }
  if (parsed.username || parsed.password) {
    fail("CPCLAW_PLATFORM_URL 不得包含用户名或密码");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    fail("CPCLAW_PLATFORM_URL 不得带路径");
  }
  if (parsed.search || parsed.hash) {
    fail("CPCLAW_PLATFORM_URL 不得带查询或片段");
  }
  if (!parsed.port) {
    fail("CPCLAW_PLATFORM_URL 必须显式包含端口");
  }
  base = `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
  mode = "remote";
} else {
  const port = env.CPCLAW_PLATFORM_PORT;
  if (port === undefined || port === "") {
    fail("未设置 CPCLAW_PLATFORM_URL 时需要 CPCLAW_PLATFORM_PORT");
  }
  if (!/^[1-9][0-9]{0,4}$/.test(port)) {
    fail("CPCLAW_PLATFORM_PORT 无效");
  }
  base = `http://127.0.0.1:${port}`;
  mode = "local";
}

function shQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

process.stdout.write(`CPCLAW_PLATFORM_BASE=${shQuote(base)}\n`);
process.stdout.write(`CPCLAW_PLATFORM_MODE=${shQuote(mode)}\n`);

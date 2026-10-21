export type DevHostConfig = {
  aiMockMode: true;
  dataDir: string;
  port: number;
  target: "local";
};

export type ConfigFailureCode =
  | "MOCK_MODE_REQUIRED"
  | "CONFIG_INVALID"
  | "TARGET_UNAVAILABLE";

export type ConfigResult =
  | { ok: true; config: DevHostConfig }
  | { ok: false; code: ConfigFailureCode; message: string };

const DEFAULT_PORT = 3927;
const MAX_PATH_LENGTH = 1024;

function fail(code: ConfigFailureCode, message: string): ConfigResult {
  return { ok: false, code, message };
}

function presence(
  env: Record<string, string | undefined>,
  key: string,
): "missing" | "empty" | "value" {
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

function normalizeAbsolute(value: string): string | undefined {
  if (!value.startsWith("/") || value.includes("\0") || value.length > MAX_PATH_LENGTH) {
    return undefined;
  }
  const stripped = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = stripped.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return stripped;
}

function defaultDataDir(homeDir: string): string {
  const home = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
  return `${home}/Library/Application Support/CPclaw`;
}

export function resolveDevHostConfig(
  env: Record<string, string | undefined>,
  options: { homeDir: string; target: string },
): ConfigResult {
  if (options.target === "docker" || options.target === "cloud") {
    return fail("TARGET_UNAVAILABLE", `P0-02.a 只实现 local，收到 ${options.target}`);
  }
  if (options.target !== "local") {
    return fail("CONFIG_INVALID", "target 只接受 local、docker、cloud");
  }

  const mockMode = presence(env, "AI_MOCK_MODE");
  if (mockMode === "missing") {
    return fail(
      "MOCK_MODE_REQUIRED",
      "缺少 AI_MOCK_MODE。复制 .env.example 为 .env，或设置为精确值 true",
    );
  }
  if (mockMode === "empty") {
    return fail("CONFIG_INVALID", "AI_MOCK_MODE 为空字符串，不会回落到 true");
  }
  if (env.AI_MOCK_MODE !== "true") {
    return fail("MOCK_MODE_REQUIRED", "本增量只接受 AI_MOCK_MODE=true");
  }

  const dataDirState = presence(env, "CPCLAW_DATA_DIR");
  let dataDir: string;
  if (dataDirState === "empty") {
    return fail("CONFIG_INVALID", "CPCLAW_DATA_DIR 为空字符串，不会回落到默认目录");
  }
  if (dataDirState === "missing") {
    if (normalizeAbsolute(options.homeDir) === undefined) {
      return fail("CONFIG_INVALID", "无法解析默认数据目录：HOME 不是绝对路径");
    }
    dataDir = defaultDataDir(options.homeDir);
  } else {
    const configured = env.CPCLAW_DATA_DIR;
    const normalized = configured === undefined ? undefined : normalizeAbsolute(configured);
    if (normalized === undefined) {
      return fail("CONFIG_INVALID", "CPCLAW_DATA_DIR 必须是不含 . 或 .. 段的绝对路径");
    }
    dataDir = normalized;
  }

  const portState = presence(env, "CPCLAW_DEV_HOST_PORT");
  let port = DEFAULT_PORT;
  if (portState === "empty") {
    return fail("CONFIG_INVALID", "CPCLAW_DEV_HOST_PORT 为空字符串，不会回落到 3927");
  }
  if (portState === "value") {
    const raw = env.CPCLAW_DEV_HOST_PORT;
    if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw)) {
      return fail("CONFIG_INVALID", "CPCLAW_DEV_HOST_PORT 必须是 1024 到 65535 的整数");
    }
    port = Number(raw);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return fail("CONFIG_INVALID", "CPCLAW_DEV_HOST_PORT 必须是 1024 到 65535 的整数");
    }
  }

  return {
    ok: true,
    config: {
      aiMockMode: true,
      dataDir,
      port,
      target: "local",
    },
  };
}

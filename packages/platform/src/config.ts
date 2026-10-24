import { resolveGatewayConfig, type RealGatewayConfig } from "@cpclaw/model-gateway";
import { fixtureEmployees, type SeedEmployee } from "./fixture.js";

export type PlatformSeed =
  | { kind: "fixture"; employees: readonly SeedEmployee[] }
  | { kind: "bootstrap"; path: string };

export type PlatformConfig = {
  dataDir: string;
  port: number;
  listenHost: string;
  sessionSecret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  seed: PlatformSeed;
  keyPresent: boolean;
  reportGateway?: RealGatewayConfig;
  aiMockMode?: boolean;
  now: () => number;
};

export type PlatformConfigFailure = {
  ok: false;
  code: "MOCK_MODE_REQUIRED" | "CONFIG_INVALID";
  message: string;
};

const DEFAULT_PORT = 3928;
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_ACCESS_TTL_SEC = 900;
const DEFAULT_REFRESH_TTL_SEC = 604_800;
const MAX_PATH_LENGTH = 1024;

function fail(code: PlatformConfigFailure["code"], message: string): PlatformConfigFailure {
  return { ok: false, code, message };
}

function presence(env: Record<string, string | undefined>, key: string): "missing" | "empty" | "value" {
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

function readPort(env: Record<string, string | undefined>): number | PlatformConfigFailure {
  const state = presence(env, "CPCLAW_PLATFORM_PORT");
  if (state === "empty") {
    return fail("CONFIG_INVALID", "CPCLAW_PLATFORM_PORT 为空字符串，不会回落到 3928");
  }
  if (state === "missing") {
    return DEFAULT_PORT;
  }
  const raw = env.CPCLAW_PLATFORM_PORT;
  if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw)) {
    return fail("CONFIG_INVALID", "CPCLAW_PLATFORM_PORT 必须是 1024 到 65535 的整数");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return fail("CONFIG_INVALID", "CPCLAW_PLATFORM_PORT 必须是 1024 到 65535 的整数");
  }
  return port;
}

function readListenHost(env: Record<string, string | undefined>): string | PlatformConfigFailure {
  const state = presence(env, "CPCLAW_LISTEN_HOST");
  if (state === "empty") {
    return fail("CONFIG_INVALID", "CPCLAW_LISTEN_HOST 为空字符串，不会回落到 127.0.0.1");
  }
  if (state === "missing") {
    return DEFAULT_LISTEN_HOST;
  }
  const raw = env.CPCLAW_LISTEN_HOST;
  if (raw === undefined) {
    return DEFAULT_LISTEN_HOST;
  }
  if (raw === "127.0.0.1" || raw === "0.0.0.0" || raw === "::1" || raw === "::") {
    return raw;
  }
  return fail("CONFIG_INVALID", "CPCLAW_LISTEN_HOST 只接受 127.0.0.1、0.0.0.0、::1 或 ::");
}

function readTtl(
  env: Record<string, string | undefined>,
  key: string,
  missing: number,
  min: number,
  max: number,
): number | PlatformConfigFailure {
  const state = presence(env, key);
  if (state === "empty") {
    return fail("CONFIG_INVALID", `${key} 为空字符串，不会回落到默认值`);
  }
  if (state === "missing") {
    return missing;
  }
  const raw = env[key];
  if (raw === undefined || !/^[1-9][0-9]{0,7}$/.test(raw)) {
    return fail("CONFIG_INVALID", `${key} 必须是 ${min} 到 ${max} 的整数`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return fail("CONFIG_INVALID", `${key} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}

export function resolvePlatformConfig(
  env: Record<string, string | undefined>,
  options: { homeDir: string; now?: () => number },
): { ok: true; config: PlatformConfig } | PlatformConfigFailure {
  if (presence(env, "AI_MOCK_MODE") === "missing") {
    return fail("MOCK_MODE_REQUIRED", "缺少 AI_MOCK_MODE。本增量只接受精确值 true");
  }
  if (env.AI_MOCK_MODE === "") {
    return fail("CONFIG_INVALID", "AI_MOCK_MODE 为空字符串，不会回落到 true");
  }
  if (env.AI_MOCK_MODE !== "true" && env.AI_MOCK_MODE !== "false") {
    return fail("MOCK_MODE_REQUIRED", "AI_MOCK_MODE 只接受 true 或 false");
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

  const port = readPort(env);
  if (typeof port !== "number") {
    return port;
  }
  const listenHost = readListenHost(env);
  if (typeof listenHost !== "string") {
    return listenHost;
  }
  const accessTtlSec = readTtl(env, "CPCLAW_ACCESS_TTL_SEC", DEFAULT_ACCESS_TTL_SEC, 60, 3600);
  if (typeof accessTtlSec !== "number") {
    return accessTtlSec;
  }
  const refreshTtlSec = readTtl(env, "CPCLAW_REFRESH_TTL_SEC", DEFAULT_REFRESH_TTL_SEC, 120, 2_592_000);
  if (typeof refreshTtlSec !== "number") {
    return refreshTtlSec;
  }
  if (refreshTtlSec <= accessTtlSec) {
    return fail("CONFIG_INVALID", "刷新有效期必须长于访问令牌");
  }

  const secretState = presence(env, "CPCLAW_SESSION_SECRET");
  if (secretState === "missing") {
    return fail("CONFIG_INVALID", "缺少 CPCLAW_SESSION_SECRET");
  }
  if (secretState === "empty") {
    return fail("CONFIG_INVALID", "CPCLAW_SESSION_SECRET 为空字符串，不会生成默认密钥");
  }
  const sessionSecret = env.CPCLAW_SESSION_SECRET;
  if (
    sessionSecret === undefined ||
    sessionSecret.length < 32 ||
    sessionSecret.length > 200 ||
    !/^[A-Za-z0-9+/=_-]+$/.test(sessionSecret)
  ) {
    return fail("CONFIG_INVALID", "CPCLAW_SESSION_SECRET 需要 32 到 200 位字母、数字或 +/=_-");
  }

  const seedState = presence(env, "CPCLAW_PLATFORM_SEED");
  const fileState = presence(env, "CPCLAW_BOOTSTRAP_FILE");
  if (seedState === "empty") {
    return fail("CONFIG_INVALID", "CPCLAW_PLATFORM_SEED 为空字符串，不会回落到引导文件");
  }
  if (fileState === "empty") {
    return fail("CONFIG_INVALID", "CPCLAW_BOOTSTRAP_FILE 为空字符串，不会改用合成账号");
  }
  let seed: PlatformSeed;
  if (seedState === "value") {
    if (env.CPCLAW_PLATFORM_SEED !== "fixture") {
      return fail("CONFIG_INVALID", "CPCLAW_PLATFORM_SEED 只接受 fixture");
    }
    seed = { kind: "fixture", employees: fixtureEmployees };
  } else if (fileState === "value") {
    const configured = env.CPCLAW_BOOTSTRAP_FILE;
    const path = configured === undefined ? undefined : normalizeAbsolute(configured);
    if (path === undefined) {
      return fail("CONFIG_INVALID", "CPCLAW_BOOTSTRAP_FILE 必须是不含 . 或 .. 段的绝对路径");
    }
    seed = { kind: "bootstrap", path };
  } else {
    return fail("CONFIG_INVALID", "空库启动需要 CPCLAW_PLATFORM_SEED=fixture，或提供 CPCLAW_BOOTSTRAP_FILE");
  }

  const rawKey = env.MINIMAX_API_KEY;
  const config: PlatformConfig = {
    dataDir,
    port,
    listenHost,
    sessionSecret,
    accessTtlSec,
    refreshTtlSec,
    seed,
    keyPresent: rawKey !== undefined && rawKey !== "",
    aiMockMode: env.AI_MOCK_MODE === "true",
    now: options.now ?? (() => Date.now()),
  };
  if (env.CPCLAW_REPORT_MODEL_MODE !== undefined && env.CPCLAW_REPORT_MODEL_MODE !== "mock" && env.CPCLAW_REPORT_MODEL_MODE !== "real") return fail("CONFIG_INVALID", "CPCLAW_REPORT_MODEL_MODE 只接受 mock 或 real");
  if (env.CPCLAW_REPORT_MODEL_MODE === "real" || env.AI_MOCK_MODE === "false") {
    const gateway = resolveGatewayConfig({ ...env, AI_MOCK_MODE: "false" });
    if ("ok" in gateway) return fail("CONFIG_INVALID", gateway.message);
    if (gateway.mode === "real") config.reportGateway = { ...gateway, timeoutMs: 60_000 };
  }
  return { ok: true, config };
}

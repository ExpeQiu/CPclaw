import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { resolveKernelStatus } from "./workspace-client.mjs";

const SETTINGS_FILE = "desktop-settings.json";
const CONNECTION_FILE = "desktop-connection.json";

/** 已写出的字段（含空串）优先；仅缺 key 时用回落值。禁止用 ||。 */
export function coalesceSaved(saved, fallback) {
  return saved !== undefined ? saved : fallback;
}

function defaultHarnessRoot(desktopDir) {
  return resolve(desktopDir, "../../../../13 Github/deepseek-harness");
}

export function settingsPath(dataDir) {
  return join(dataDir, SETTINGS_FILE);
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, value: null };
    return { ok: false, message: error instanceof Error ? error.message : "配置无法读取" };
  }
}

/** 读取已保存行；文件不存在视为空对象（尚未经 UI 写出）。 */
export function readSavedSettings(dataDir) {
  const parsed = readJson(settingsPath(dataDir));
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: true, saved: {}, exists: false };
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, message: "桌面设置文件损坏" };
  }
  return { ok: true, saved: parsed.value, exists: true };
}

export function readPlatformUrl(dataDir, env = process.env) {
  const parsed = readJson(join(dataDir, CONNECTION_FILE));
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const written = parsed.value && typeof parsed.value.platformUrl === "string" ? parsed.value.platformUrl : undefined;
  return { ok: true, platformUrl: coalesceSaved(written, env.CPCLAW_PLATFORM_URL == null ? "" : env.CPCLAW_PLATFORM_URL) };
}

/**
 * 把已保存设置叠到 env 副本上，供内核解析与工作区进程使用。
 * 仅对「已写出」的字段覆盖；未写出的键保留 env。
 */
export function envWithDesktopSettings(saved, env = process.env) {
  const next = { ...env };
  if (Object.prototype.hasOwnProperty.call(saved, "reportEngine")) {
    if (saved.reportEngine === "harness") next.CPCLAW_REPORT_ENGINE = "harness";
    else delete next.CPCLAW_REPORT_ENGINE;
  }
  if (Object.prototype.hasOwnProperty.call(saved, "harnessRoot")) {
    const root = typeof saved.harnessRoot === "string" ? saved.harnessRoot.trim() : "";
    if (root) next.CPCLAW_HARNESS_ROOT = root;
    else delete next.CPCLAW_HARNESS_ROOT;
  }
  if (Object.prototype.hasOwnProperty.call(saved, "reportModelMode")) {
    const mode = saved.reportModelMode;
    if (mode === "mock" || mode === "real") next.CPCLAW_REPORT_MODEL_MODE = mode;
    else delete next.CPCLAW_REPORT_MODEL_MODE;
  }
  return next;
}

export function applyDesktopSettingsToProcessEnv(dataDir, desktopDir, env = process.env) {
  const loaded = readSavedSettings(dataDir);
  if (!loaded.ok) {
    process.stderr.write(`${JSON.stringify({ level: "warn", event: "desktop_settings_read_failed", message: loaded.message })}\n`);
    return { ok: false, message: loaded.message };
  }
  const merged = envWithDesktopSettings(loaded.saved, env);
  for (const key of ["CPCLAW_REPORT_ENGINE", "CPCLAW_HARNESS_ROOT", "CPCLAW_REPORT_MODEL_MODE"]) {
    if (merged[key] === undefined) delete env[key];
    else env[key] = merged[key];
  }
  process.stderr.write(`${JSON.stringify({
    level: "info",
    event: "desktop_settings_applied",
    reportEngine: env.CPCLAW_REPORT_ENGINE ?? null,
    harnessRoot: env.CPCLAW_HARNESS_ROOT ? basename(env.CPCLAW_HARNESS_ROOT) : null,
    reportModelMode: env.CPCLAW_REPORT_MODEL_MODE ?? null,
    fromFile: loaded.exists,
    desktop: basename(desktopDir),
  })}\n`);
  return { ok: true, exists: loaded.exists };
}

function fieldSource(saved, key, envUsed) {
  if (Object.prototype.hasOwnProperty.call(saved, key)) return "settings";
  if (envUsed) return "env";
  return "default";
}

export function getDesktopSettingsView(dataDir, desktopDir, { appVersion = "", env = process.env } = {}) {
  const loaded = readSavedSettings(dataDir);
  if (!loaded.ok) return { ok: false, code: "CONFIG_INVALID", message: loaded.message };
  const saved = loaded.saved;
  const platform = readPlatformUrl(dataDir, env);
  if (!platform.ok) return { ok: false, code: "CONFIG_INVALID", message: platform.message };

  const envEngine = env.CPCLAW_REPORT_ENGINE === "harness" ? "harness" : "none";
  const reportEngine = coalesceSaved(saved.reportEngine, envEngine);
  const envRoot = typeof env.CPCLAW_HARNESS_ROOT === "string" ? env.CPCLAW_HARNESS_ROOT : undefined;
  const harnessRoot = coalesceSaved(saved.harnessRoot, envRoot !== undefined ? envRoot : defaultHarnessRoot(desktopDir));
  const envMode = env.CPCLAW_REPORT_MODEL_MODE === "real" || env.CPCLAW_REPORT_MODEL_MODE === "mock"
    ? env.CPCLAW_REPORT_MODEL_MODE
    : "mock";
  const reportModelMode = coalesceSaved(saved.reportModelMode, envMode);

  const runtimeEnv = envWithDesktopSettings({
    ...saved,
    reportEngine,
    harnessRoot,
    reportModelMode,
  }, env);
  const kernel = resolveKernelStatus(desktopDir, runtimeEnv);
  const bundled = kernel.source === "bundle";

  return {
    ok: true,
    dataDir,
    appVersion,
    platformUrl: platform.platformUrl,
    reportEngine: reportEngine === "harness" ? "harness" : "none",
    harnessRoot: typeof harnessRoot === "string" ? harnessRoot : "",
    reportModelMode: reportModelMode === "real" ? "real" : "mock",
    kernel,
    bundled,
    sources: {
      reportEngine: fieldSource(saved, "reportEngine", env.CPCLAW_REPORT_ENGINE !== undefined),
      harnessRoot: fieldSource(saved, "harnessRoot", env.CPCLAW_HARNESS_ROOT !== undefined),
      reportModelMode: fieldSource(saved, "reportModelMode", env.CPCLAW_REPORT_MODEL_MODE !== undefined),
      platformUrl: existsSync(join(dataDir, CONNECTION_FILE)) ? "settings" : (env.CPCLAW_PLATFORM_URL !== undefined ? "env" : "default"),
    },
  };
}

function normalizeEngine(value) {
  if (value === "harness") return "harness";
  if (value === "none" || value === "direct" || value === "") return "none";
  return null;
}

function normalizeMode(value) {
  if (value === "mock" || value === "real") return value;
  return null;
}

export function saveDesktopSettings(dataDir, desktopDir, input, { env = process.env } = {}) {
  if (typeof input !== "object" || input === null) {
    return { ok: false, code: "SCHEMA_INVALID", message: "设置内容不符合形状" };
  }
  const engine = normalizeEngine(input.reportEngine);
  if (engine === null) return { ok: false, code: "SCHEMA_INVALID", message: "推理内核只接受 harness 或未启用" };
  const mode = normalizeMode(input.reportModelMode);
  if (mode === null) return { ok: false, code: "SCHEMA_INVALID", message: "报告模型模式只接受 mock 或 real" };
  const harnessRoot = typeof input.harnessRoot === "string" ? input.harnessRoot.trim() : "";
  if (harnessRoot && !isAbsolute(harnessRoot)) {
    return { ok: false, code: "SCHEMA_INVALID", message: "内核路径须为绝对路径" };
  }
  if (engine === "harness" && harnessRoot && !existsSync(join(harnessRoot, "package.json")) && !existsSync(join(harnessRoot, "manifest.json"))) {
    return { ok: false, code: "CONFIG_INVALID", message: "所选目录不是可用的 deepseek-harness（缺少 package.json 或 manifest.json）" };
  }

  mkdirSync(dataDir, { recursive: true });
  const payload = {
    schemaVersion: 1,
    reportEngine: engine,
    harnessRoot,
    reportModelMode: mode,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(settingsPath(dataDir), JSON.stringify(payload, null, 2), { mode: 0o600 });
  process.stderr.write(`${JSON.stringify({
    level: "info",
    event: "desktop_settings_saved",
    reportEngine: engine,
    harnessRoot: harnessRoot ? basename(harnessRoot) : "",
    reportModelMode: mode,
  })}\n`);
  applyDesktopSettingsToProcessEnv(dataDir, desktopDir, env);
  return getDesktopSettingsView(dataDir, desktopDir, { appVersion: input.appVersion || "", env });
}

/** 用户显式从环境变量覆盖写出（force）；不会在启动时自动调用。 */
export function syncDesktopSettingsFromEnv(dataDir, desktopDir, { env = process.env, appVersion = "" } = {}) {
  const engine = env.CPCLAW_REPORT_ENGINE === "harness" ? "harness" : "none";
  const root = typeof env.CPCLAW_HARNESS_ROOT === "string" ? env.CPCLAW_HARNESS_ROOT : "";
  const mode = env.CPCLAW_REPORT_MODEL_MODE === "real" ? "real" : "mock";
  process.stderr.write(`${JSON.stringify({ level: "info", event: "desktop_settings_sync_from_env", reportEngine: engine, reportModelMode: mode })}\n`);
  return saveDesktopSettings(dataDir, desktopDir, {
    reportEngine: engine,
    harnessRoot: root,
    reportModelMode: mode,
    appVersion,
  }, { env });
}

export async function probePlatformConnection(platformUrl) {
  let url;
  try {
    url = new URL(typeof platformUrl === "string" ? platformUrl.trim() : "");
  } catch {
    return { ok: false, code: "CONFIG_INVALID", message: "请输入完整的平台地址" };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, code: "CONFIG_INVALID", message: "平台地址须为 http 或 https" };
  }
  const healthUrl = `${url.origin}/health`;
  try {
    const response = await fetch(healthUrl, { method: "GET", signal: AbortSignal.timeout(8_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, code: "DEPENDENCY_UNAVAILABLE", message: `平台返回 ${response.status}` };
    }
    process.stderr.write(`${JSON.stringify({
      level: "info",
      event: "platform_probe_ok",
      origin: url.origin,
      mode: body.mode ?? null,
      aiMockMode: body.aiMockMode ?? null,
    })}\n`);
    return {
      ok: true,
      origin: url.origin,
      mode: typeof body.mode === "string" ? body.mode : null,
      aiMockMode: body.aiMockMode === true || body.aiMockMode === false ? body.aiMockMode : null,
      summary: `可达 · ${url.origin}${body.mode ? ` · 模式 ${body.mode}` : ""}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法连接平台";
    process.stderr.write(`${JSON.stringify({ level: "warn", event: "platform_probe_failed", origin: url.origin, message })}\n`);
    return { ok: false, code: "DEPENDENCY_UNAVAILABLE", message: `无法连接企业端：${message}` };
  }
}

import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hostLog } from "./host-log.js";

/** 本机工作区当前支持的 schema。更高版本拒绝打开，不改写旧库。 */
export const WORKSPACE_SCHEMA_SUPPORTED = 2;
/** 本机会话文件当前支持的 schema。 */
export const SESSION_SCHEMA_SUPPORTED = 1;
/** 平台库当前支持的 schema。与 platform ensureSchema 保持一致。 */
export const PLATFORM_SCHEMA_SUPPORTED = 3;

export type CompatCode = "SCHEMA_INCOMPATIBLE" | "NOT_FOUND" | "IO";

export type CompatResult =
  | { ok: true; kind: "workspace" | "session" | "platform"; version: number; supported: number }
  | { ok: false; code: CompatCode; message: string; preservedPath?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMetaSchema(dbPath: string): { ok: true; version: number } | { ok: false; code: CompatCode; message: string } {
  if (!existsSync(dbPath)) {
    return { ok: false, code: "NOT_FOUND", message: "数据库文件不存在" };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法只读打开数据库";
    return { ok: false, code: "IO", message };
  }
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (table === undefined) {
      return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "缺少 meta 表，拒绝打开" };
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (!isRecord(row) || typeof row.value !== "string") {
      return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "schema 版本无法识别" };
    }
    const version = Number(row.value);
    if (!Number.isInteger(version) || version < 1) {
      return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "schema 版本无法识别" };
    }
    return { ok: true, version };
  } finally {
    db.close();
  }
}

function readPlatformSchema(dbPath: string): { ok: true; version: number } | { ok: false; code: CompatCode; message: string } {
  if (!existsSync(dbPath)) {
    return { ok: false, code: "NOT_FOUND", message: "平台库不存在" };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法只读打开平台库";
    return { ok: false, code: "IO", message };
  }
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get();
    if (table === undefined) {
      return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "缺少 schema_meta，拒绝打开" };
    }
    const row = db.prepare("SELECT version FROM schema_meta").get();
    if (!isRecord(row) || typeof row.version !== "number" || !Number.isInteger(row.version)) {
      return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "平台 schema 版本无法识别" };
    }
    return { ok: true, version: row.version };
  } finally {
    db.close();
  }
}

/** 只读检查工作区 schema。不迁移、不写入。 */
export function inspectWorkspaceCompat(dataDir: string): CompatResult {
  const dbPath = join(dataDir, "workspace.sqlite");
  const read = readMetaSchema(dbPath);
  if (!read.ok) {
    if (existsSync(dbPath)) {
      return { ...read, preservedPath: dbPath };
    }
    return read;
  }
  if (read.version > WORKSPACE_SCHEMA_SUPPORTED) {
    return {
      ok: false,
      code: "SCHEMA_INCOMPATIBLE",
      message: `工作区 schema ${read.version} 高于本机支持的 ${WORKSPACE_SCHEMA_SUPPORTED}，已保留原文件`,
      preservedPath: dbPath,
    };
  }
  if (read.version < 1) {
    return {
      ok: false,
      code: "SCHEMA_INCOMPATIBLE",
      message: "工作区 schema 过低，拒绝打开",
      preservedPath: dbPath,
    };
  }
  return { ok: true, kind: "workspace", version: read.version, supported: WORKSPACE_SCHEMA_SUPPORTED };
}

/** 只读检查平台库 schema。不迁移、不写入。 */
export function inspectPlatformCompat(dataDir: string): CompatResult {
  const dbPath = join(dataDir, "platform.sqlite");
  const read = readPlatformSchema(dbPath);
  if (!read.ok) {
    if (existsSync(dbPath)) {
      return { ...read, preservedPath: dbPath };
    }
    return read;
  }
  if (read.version > PLATFORM_SCHEMA_SUPPORTED) {
    return {
      ok: false,
      code: "SCHEMA_INCOMPATIBLE",
      message: `平台 schema ${read.version} 高于本机支持的 ${PLATFORM_SCHEMA_SUPPORTED}，已保留原文件`,
      preservedPath: dbPath,
    };
  }
  return { ok: true, kind: "platform", version: read.version, supported: PLATFORM_SCHEMA_SUPPORTED };
}

/** 检查会话文件 schema。不改写文件。 */
export function inspectSessionCompat(raw: unknown): CompatResult {
  if (!isRecord(raw)) {
    return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "会话不是对象" };
  }
  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "会话 schema 无法识别" };
  }
  if (version !== SESSION_SCHEMA_SUPPORTED) {
    return {
      ok: false,
      code: "SCHEMA_INCOMPATIBLE",
      message: `会话 schema ${version} 与本机支持的 ${SESSION_SCHEMA_SUPPORTED} 不兼容，拒绝错误打开`,
    };
  }
  return { ok: true, kind: "session", version, supported: SESSION_SCHEMA_SUPPORTED };
}

/**
 * 升级前把当前库挪到旁路保护名，不删除。
 * 调用方负责之后写入新库或回滚。
 */
export function quarantineIncompatibleStore(
  dataDir: string,
  fileName: "workspace.sqlite" | "platform.sqlite",
  reason: string,
): CompatResult {
  const path = join(dataDir, fileName);
  if (!existsSync(path)) {
    return { ok: false, code: "NOT_FOUND", message: "没有可保护的数据库文件" };
  }
  const stamp = Date.now();
  const preserved = `${path}.incompatible-${stamp}`;
  try {
    renameSync(path, preserved);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法保护旧数据库";
    return { ok: false, code: "IO", message, preservedPath: path };
  }
  hostLog(dataDir, "warn", "store_quarantined", "不兼容数据库已旁路保留", {
    fileName,
    reason: reason.slice(0, 120),
    bytes: statSync(preserved).size,
  });
  return {
    ok: false,
    code: "SCHEMA_INCOMPATIBLE",
    message: `已拒绝打开并保留原库：${preserved}`,
    preservedPath: preserved,
  };
}

export function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取 JSON";
    return { ok: false, message };
  }
}

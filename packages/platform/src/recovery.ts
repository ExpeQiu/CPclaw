import { copyFileSync, existsSync, renameSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PLATFORM_SCHEMA_SUPPORTED } from "./compat-constants.js";
import { platformLog } from "./log.js";

export type RestoreResult =
  | { ok: true; fileName: string; bytes: number }
  | { ok: false; code: "NOT_FOUND" | "IO" | "SCHEMA_INCOMPATIBLE"; message: string };

/**
 * 在平台进程已关闭时，用备份覆盖当前库。
 * 旁路保留恢复前文件；重新 openPlatform 时会回放权威台账。
 */
export function restorePlatformSqlite(dataDir: string, fileName: string): RestoreResult {
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "备份文件名不合法" };
  }
  const source = join(dataDir, "backups", fileName);
  if (!existsSync(source)) {
    return { ok: false, code: "NOT_FOUND", message: "备份不存在" };
  }
  let probe: DatabaseSync;
  try {
    probe = new DatabaseSync(source, { readOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取备份";
    return { ok: false, code: "IO", message };
  }
  try {
    const row = probe.prepare("SELECT version FROM schema_meta").get();
    const version =
      typeof row === "object" && row !== null && "version" in row && typeof (row as { version: unknown }).version === "number"
        ? (row as { version: number }).version
        : undefined;
    if (version === undefined || !Number.isInteger(version)) {
      return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "备份缺少可识别 schema" };
    }
    if (version > PLATFORM_SCHEMA_SUPPORTED) {
      return {
        ok: false,
        code: "SCHEMA_INCOMPATIBLE",
        message: `备份 schema ${version} 高于本机支持的 ${PLATFORM_SCHEMA_SUPPORTED}，拒绝恢复`,
      };
    }
  } finally {
    probe.close();
  }

  const live = join(dataDir, "platform.sqlite");
  const side = `${live}.pre-restore-${Date.now()}`;
  try {
    if (existsSync(live)) {
      renameSync(live, side);
    }
    copyFileSync(source, live);
    chmodSync(live, 0o600);
  } catch (error) {
    const message = error instanceof Error ? error.message : "恢复失败";
    if (existsSync(side) && !existsSync(live)) {
      try {
        renameSync(side, live);
      } catch {
        // 保留旁路供人工处理
      }
    }
    return { ok: false, code: "IO", message };
  }
  platformLog(dataDir, "info", "platform_restored", "平台库已从备份恢复，待回放权威台账", { fileName });
  return { ok: true, fileName, bytes: statSync(live).size };
}

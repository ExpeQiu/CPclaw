import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hostLog } from "./host-log.js";

export type LocalBackupResult =
  | { ok: true; fileName: string; bytes: number }
  | { ok: false; code: "NOT_FOUND" | "IO" | "SCHEMA_INCOMPATIBLE"; message: string };

function backupDir(dataDir: string): string {
  return join(dataDir, "backups");
}

/** 备份工作区库。写前中断演练可在写出前注入失败。 */
export function backupWorkspace(
  dataDir: string,
  options?: { failBeforeWrite?: boolean; failAfterWrite?: boolean },
): LocalBackupResult {
  const source = join(dataDir, "workspace.sqlite");
  if (!existsSync(source)) {
    return { ok: false, code: "NOT_FOUND", message: "工作区库不存在" };
  }
  if (options?.failBeforeWrite === true) {
    hostLog(dataDir, "warn", "backup_interrupted_before", "写前中断，未产生备份文件", {});
    return { ok: false, code: "IO", message: "写前中断，备份未开始" };
  }
  mkdirSync(backupDir(dataDir), { recursive: true });
  const fileName = `workspace-${Date.now()}.sqlite`;
  const destination = join(backupDir(dataDir), fileName);
  try {
    const db = new DatabaseSync(source);
    try {
      db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    chmodSync(destination, 0o600);
  } catch (error) {
    const message = error instanceof Error ? error.message : "备份失败";
    return { ok: false, code: "IO", message };
  }
  if (options?.failAfterWrite === true) {
    hostLog(dataDir, "warn", "backup_interrupted_after", "写后中断，备份文件已落盘待核实", {
      fileName,
    });
    return { ok: false, code: "IO", message: "写后中断，备份文件保持待核实" };
  }
  const bytes = statSync(destination).size;
  hostLog(dataDir, "info", "workspace_backup_created", "工作区备份已写出", { bytes });
  return { ok: true, fileName, bytes };
}

/**
 * 从备份恢复工作区。先把当前库挪到旁路，再拷贝备份。
 * 恢复后由调用方重新打开并 reconcile。
 */
export function restoreWorkspace(dataDir: string, fileName: string): LocalBackupResult {
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return { ok: false, code: "SCHEMA_INCOMPATIBLE", message: "备份文件名不合法" };
  }
  const source = join(backupDir(dataDir), fileName);
  if (!existsSync(source)) {
    return { ok: false, code: "NOT_FOUND", message: "备份不存在" };
  }
  const live = join(dataDir, "workspace.sqlite");
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
        // 回滚失败时保留旁路文件供人工处理
      }
    }
    return { ok: false, code: "IO", message };
  }
  const marker = join(dataDir, "restore-marker.json");
  writeFileSync(
    marker,
    `${JSON.stringify({ schemaVersion: 1, restoredFrom: fileName, at: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  hostLog(dataDir, "info", "workspace_restored", "工作区已从备份恢复", { fileName });
  return { ok: true, fileName, bytes: statSync(live).size };
}

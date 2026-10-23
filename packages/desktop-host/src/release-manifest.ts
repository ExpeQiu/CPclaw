import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  PLATFORM_SCHEMA_SUPPORTED,
  SESSION_SCHEMA_SUPPORTED,
  WORKSPACE_SCHEMA_SUPPORTED,
} from "./compat.js";
import { hostLog } from "./host-log.js";

export type ReleaseManifest = {
  schemaVersion: 1;
  appVersion: string;
  signed: false;
  notarized: false;
  node: string;
  platform: "darwin";
  arch: "arm64";
  supportedSchemas: {
    workspace: number;
    platform: number;
    session: number;
  };
  packages: Array<{ name: string; version: string }>;
  notes: string;
  createdAt: string;
};

export type ManifestResult =
  | { ok: true; manifest: ReleaseManifest; fileName?: string }
  | { ok: false; code: "SCHEMA_INVALID" | "UNSIGNED"; message: string };

/** 固定制品清单。首期 Mock 明确 signed=false，不假装已签名。 */
export function buildReleaseManifest(input: {
  appVersion: string;
  packages: Array<{ name: string; version: string }>;
  notes?: string;
}): ManifestResult {
  if (input.appVersion.length === 0 || input.appVersion.length > 64) {
    return { ok: false, code: "SCHEMA_INVALID", message: "应用版本不符合限制" };
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return { ok: false, code: "SCHEMA_INVALID", message: "当前只登记 darwin/arm64 制品" };
  }
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    appVersion: input.appVersion,
    signed: false,
    notarized: false,
    node: process.version,
    platform: "darwin",
    arch: "arm64",
    supportedSchemas: {
      workspace: WORKSPACE_SCHEMA_SUPPORTED,
      platform: PLATFORM_SCHEMA_SUPPORTED,
      session: SESSION_SCHEMA_SUPPORTED,
    },
    packages: input.packages,
    notes: input.notes ?? "未签名 Mock 制品；真实签名账号见 005 Q3",
    createdAt: new Date().toISOString(),
  };
  return { ok: true, manifest };
}

export function writeReleaseManifest(dataDir: string, manifest: ReleaseManifest): ManifestResult {
  if (manifest.signed || manifest.notarized) {
    return { ok: false, code: "UNSIGNED", message: "Mock 清单不得声称已签名或已公证" };
  }
  const dir = join(dataDir, "release");
  mkdirSync(dir, { recursive: true });
  const fileName = `manifest-${manifest.appVersion}.json`;
  const path = join(dir, fileName);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  hostLog(dataDir, "info", "release_manifest_written", "已写出未签名制品清单", {
    appVersion: manifest.appVersion,
  });
  return { ok: true, manifest, fileName };
}

export function verifyUpgradeGate(input: {
  dataDir: string;
  targetWorkspaceSchema: number;
  targetPlatformSchema: number;
  targetSessionSchema: number;
}): { ok: true } | { ok: false; code: "SCHEMA_INCOMPATIBLE" | "UNSIGNED"; message: string } {
  const manifestPath = join(input.dataDir, "release");
  if (!existsSync(manifestPath)) {
    return { ok: false, code: "UNSIGNED", message: "缺少制品清单，拒绝按 latest 升级" };
  }
  if (input.targetWorkspaceSchema > WORKSPACE_SCHEMA_SUPPORTED) {
    return {
      ok: false,
      code: "SCHEMA_INCOMPATIBLE",
      message: "目标工作区 schema 高于本机，保留旧数据并拒绝错误打开",
    };
  }
  if (input.targetPlatformSchema > PLATFORM_SCHEMA_SUPPORTED) {
    return {
      ok: false,
      code: "SCHEMA_INCOMPATIBLE",
      message: "目标平台 schema 高于本机，保留旧数据并拒绝错误打开",
    };
  }
  if (input.targetSessionSchema !== SESSION_SCHEMA_SUPPORTED) {
    return {
      ok: false,
      code: "SCHEMA_INCOMPATIBLE",
      message: "目标会话 schema 不兼容，拒绝错误打开",
    };
  }
  return { ok: true };
}

export function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  buildReleaseManifest,
  exportDiagnosticPack,
  inspectSessionCompat,
  inspectWorkspaceCompat,
  runDoctor,
  verifyUpgradeGate,
  writeAccountSession,
  writeReleaseManifest,
  WORKSPACE_SCHEMA_SUPPORTED,
} from "../dist/index.js";
import { openLocalWorkspace as openWs } from "../dist/workspace.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-doctor-"));
}

test("只读诊断覆盖六类检查且不声明自动修复", () => {
  const dir = tempDir();
  writeAccountSession(
    dir,
    { schemaVersion: 1, employeeId: "employee-a", sessionId: "sess-1", refreshToken: "refresh-token-1" },
    { makeCurrent: true },
  );
  const grant = join(dir, "grant");
  mkdirSync(grant, { recursive: true });
  const report = runDoctor({
    dataDir: dir,
    platformReachable: true,
    modelKeyPresent: true,
    grantedDirectories: [grant],
    connectorConfigured: undefined,
    imPaired: undefined,
  });
  assert.equal(report.autoRepair, false);
  const ids = report.checks.map((item) => item.id).sort();
  assert.deepEqual(ids, ["cli_mcp", "directory", "identity", "im", "model", "sync"]);
  assert.equal(report.checks.find((item) => item.id === "identity")?.status, "ok");
  assert.equal(report.checks.find((item) => item.id === "cli_mcp")?.status, "skipped");
});

test("默认诊断包不含凭证与正文；额外范围须显式打开", () => {
  const dir = tempDir();
  writeAccountSession(
    dir,
    { schemaVersion: 1, employeeId: "employee-a", sessionId: "sess-1", refreshToken: "refresh-token-1" },
    { makeCurrent: true },
  );
  const report = runDoctor({ dataDir: dir, platformReachable: true, modelKeyPresent: false });
  const denied = exportDiagnosticPack(dir, report, {
    includeExtra: false,
    extraScopes: ["sync_meta"],
  });
  assert.equal(denied.ok, false);
  const pack = exportDiagnosticPack(dir, report, { includeExtra: false });
  assert.equal(pack.ok, true);
  if (!pack.ok) {
    throw new Error("应导出");
  }
  const body = readFileSync(join(dir, "diagnostics", pack.fileName), "utf8");
  assert.equal(body.includes("refresh-token"), false);
  assert.equal(body.includes("Bearer"), false);
  const extra = exportDiagnosticPack(dir, report, { includeExtra: true, extraScopes: ["sync_meta", "skill_meta"] });
  assert.equal(extra.ok, true);
  if (extra.ok) {
    assert.deepEqual(extra.includedExtra, ["sync_meta", "skill_meta"]);
  }
});

test("更高工作区 schema 只读检查拒绝且不改写文件", () => {
  const dir = tempDir();
  const dbPath = join(dir, "workspace.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema', '99')").run();
  db.close();
  const before = readFileSync(dbPath);
  const compat = inspectWorkspaceCompat(dir);
  assert.equal(compat.ok, false);
  if (!compat.ok) {
    assert.equal(compat.code, "SCHEMA_INCOMPATIBLE");
    assert.equal(compat.preservedPath, dbPath);
  }
  assert.deepEqual(readFileSync(dbPath), before);
  assert.throws(() => openWs(dir), /高于本机支持/);
  // 拒绝打开不得改写旧库（含不得切入 WAL）
  assert.deepEqual(readFileSync(dbPath), before);
  const again = inspectWorkspaceCompat(dir);
  assert.equal(again.ok, false);
});

test("会话 schema 不兼容被拒绝", () => {
  const compat = inspectSessionCompat({ schemaVersion: 9, employeeId: "employee-a" });
  assert.equal(compat.ok, false);
  if (!compat.ok) {
    assert.equal(compat.code, "SCHEMA_INCOMPATIBLE");
  }
});

test("未签名制品清单与升级门禁", () => {
  const dir = tempDir();
  const built = buildReleaseManifest({
    appVersion: "0.0.1",
    packages: [{ name: "@cpclaw/desktop-host", version: "0.0.1" }],
  });
  assert.equal(built.ok, true);
  if (!built.ok) {
    throw new Error("清单失败");
  }
  assert.equal(built.manifest.signed, false);
  assert.equal(built.manifest.supportedSchemas.workspace, WORKSPACE_SCHEMA_SUPPORTED);
  const written = writeReleaseManifest(dir, built.manifest);
  assert.equal(written.ok, true);
  const gate = verifyUpgradeGate({
    dataDir: dir,
    targetWorkspaceSchema: WORKSPACE_SCHEMA_SUPPORTED,
    targetPlatformSchema: 3,
    targetSessionSchema: 1,
  });
  assert.equal(gate.ok, true);
  const refuse = verifyUpgradeGate({
    dataDir: dir,
    targetWorkspaceSchema: 99,
    targetPlatformSchema: 3,
    targetSessionSchema: 1,
  });
  assert.equal(refuse.ok, false);
});

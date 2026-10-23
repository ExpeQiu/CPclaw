import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  fixtureEmployees,
  openPlatform,
  PLATFORM_SCHEMA_SUPPORTED,
  restorePlatformSqlite,
} from "../dist/index.js";

const secret = "0123456789abcdef0123456789abcdef";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-plat-recovery-"));
}

function config(dataDir) {
  return {
    dataDir,
    port: 0,
    listenHost: "127.0.0.1",
    sessionSecret: secret,
    accessTtlSec: 60,
    refreshTtlSec: 3600,
    seed: { kind: "fixture", employees: fixtureEmployees },
    keyPresent: false,
    now: () => 1_700_000_100_000,
  };
}

test("更高平台 schema 拒绝打开且保留原文件", () => {
  const dataDir = tempDir();
  const opened = openPlatform(config(dataDir));
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    return;
  }
  opened.app.close();
  const db = new DatabaseSync(join(dataDir, "platform.sqlite"));
  db.prepare("UPDATE schema_meta SET version = ?").run(PLATFORM_SCHEMA_SUPPORTED + 5);
  db.close();
  const before = readFileSync(join(dataDir, "platform.sqlite"));
  const again = openPlatform(config(dataDir));
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.match(again.message, /高于本机支持/);
  }
  assert.deepEqual(readFileSync(join(dataDir, "platform.sqlite")), before);
});

test("恢复旧备份后权威台账仍阻断已撤权原文", () => {
  const dataDir = tempDir();
  const opened = openPlatform(config(dataDir));
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    return;
  }
  const admin = opened.app.login({
    employeeId: "admin",
    password: "fixture-admin",
    deviceLabel: "device-admin",
  });
  assert.equal(admin.ok, true);
  if (!admin.ok) {
    opened.app.close();
    return;
  }
  const employee = opened.app.login({
    employeeId: "employee-a",
    password: "fixture-employee-a",
    deviceLabel: "device-a",
  });
  assert.equal(employee.ok, true);
  if (!employee.ok) {
    opened.app.close();
    return;
  }
  const ingested = opened.app.ingestKnowledge(admin.accessToken, {
    docId: "doc-recover",
    title: "恢复样例",
    format: "markdown",
    body: "# 标题\n\n可引用段落。\n",
    aclGroup: "readers",
  });
  assert.equal(ingested.ok, true);
  const backup = opened.app.backup(admin.accessToken);
  assert.equal(backup.ok, true);
  if (!backup.ok) {
    opened.app.close();
    return;
  }
  assert.equal(opened.app.revokeKnowledge(admin.accessToken, "doc-recover").ok, true);
  const afterRevoke = opened.app.searchKnowledge(employee.accessToken, "可引用");
  assert.equal(afterRevoke.ok, true);
  if (afterRevoke.ok) {
    assert.equal(afterRevoke.hits.some((item) => item.docId === "doc-recover"), false);
  }
  opened.app.close();

  const restored = restorePlatformSqlite(dataDir, backup.fileName);
  assert.equal(restored.ok, true);

  const again = openPlatform(config(dataDir));
  assert.equal(again.ok, true);
  if (!again.ok) {
    return;
  }
  const employee2 = again.app.login({
    employeeId: "employee-a",
    password: "fixture-employee-a",
    deviceLabel: "device-a-2",
  });
  assert.equal(employee2.ok, true);
  if (!employee2.ok) {
    again.app.close();
    return;
  }
  const search = again.app.searchKnowledge(employee2.accessToken, "可引用");
  assert.equal(search.ok, true);
  if (search.ok) {
    assert.equal(search.hits.some((item) => item.docId === "doc-recover"), false);
  }
  const cite = again.app.citeKnowledge(employee2.accessToken, "doc-recover", "offset:0");
  assert.equal(cite.ok, false);
  again.app.close();
  assert.equal(readFileSync(join(dataDir, "authority-ledger.json"), "utf8").includes("doc-recover"), true);
});

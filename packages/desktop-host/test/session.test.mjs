import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCurrentAccountSession, switchCurrentAccount, writeAccountSession } from "../dist/index.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-account-"));
}

test("切换当前账号后读不到上一名员工的刷新令牌", () => {
  const root = tempDir();
  const savedA = writeAccountSession(root, {
    schemaVersion: 1,
    employeeId: "employee-a",
    sessionId: "ses-a",
    refreshToken: "refresh-token-a",
  }, { makeCurrent: true });
  assert.equal(savedA.ok, true);
  const savedB = writeAccountSession(root, {
    schemaVersion: 1,
    employeeId: "employee-b",
    sessionId: "ses-b",
    refreshToken: "refresh-token-b",
  }, { makeCurrent: false });
  assert.equal(savedB.ok, true);
  const before = readCurrentAccountSession(root);
  assert.equal(before.ok, true);
  if (!before.ok || before.session === null) {
    assert.fail("切换前应读到员工甲");
  }
  assert.equal(before.session.refreshToken, "refresh-token-a");
  assert.equal(switchCurrentAccount(root, "employee-b").ok, true);
  const after = readCurrentAccountSession(root);
  assert.equal(after.ok, true);
  if (!after.ok || after.session === null) {
    assert.fail("切换后应读到员工乙");
  }
  assert.equal(after.session.employeeId, "employee-b");
  assert.equal(after.session.refreshToken, "refresh-token-b");
  assert.equal(after.session.refreshToken.includes("refresh-token-a"), false);
});

test("切到还没有会话文件的账号时不回退旧令牌", () => {
  const root = tempDir();
  writeAccountSession(root, {
    schemaVersion: 1,
    employeeId: "employee-a",
    sessionId: "ses-a",
    refreshToken: "refresh-token-a",
  }, { makeCurrent: true });
  assert.equal(switchCurrentAccount(root, "employee-b").ok, true);
  const current = readCurrentAccountSession(root);
  assert.equal(current.ok, true);
  if (!current.ok) {
    return;
  }
  assert.equal(current.session, null);
});

test("账号目录是符号链接时拒绝写入", () => {
  const root = tempDir();
  const outside = tempDir();
  mkdirSync(join(root, "accounts"), { recursive: true });
  symlinkSync(outside, join(root, "accounts", "employee-a"));
  const saved = writeAccountSession(root, {
    schemaVersion: 1,
    employeeId: "employee-a",
    sessionId: "ses-a",
    refreshToken: "refresh-token-a",
  }, { makeCurrent: true });
  assert.equal(saved.ok, false);
  assert.equal(readCurrentAccountSession(root).ok, true);
});

test("路径形式的员工编号被拒绝", () => {
  const root = tempDir();
  const saved = writeAccountSession(root, {
    schemaVersion: 1,
    employeeId: "../employee-a",
    sessionId: "ses-a",
    refreshToken: "refresh-token-a",
  }, { makeCurrent: true });
  assert.equal(saved.ok, false);
  writeFileSync(join(root, "marker.txt"), "stay", "utf8");
});

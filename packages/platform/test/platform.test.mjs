import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  fixtureEmployees,
  listenPlatform,
  openPlatform,
  resolvePlatformConfig,
} from "../dist/index.js";

const secret = "test-session-secret-0123456789abcdef";
const home = { homeDir: "/tmp/cpclaw-home" };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-platform-"));
}

function openFixture() {
  const dataDir = tempDir();
  const clock = { now: 1_700_000_000_000 };
  const opened = openPlatform({
    dataDir,
    port: 0,
    listenHost: "127.0.0.1",
    sessionSecret: secret,
    accessTtlSec: 60,
    refreshTtlSec: 3600,
    seed: { kind: "fixture", employees: fixtureEmployees },
    keyPresent: false,
    now: () => clock.now,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    throw new Error("平台没有打开");
  }
  return { dataDir, clock, app: opened.app };
}

function login(app, employeeId, deviceLabel = "device-1") {
  const passwords = {
    admin: "fixture-admin",
    "employee-a": "fixture-employee-a",
    "employee-b": "fixture-employee-b",
    "employee-c": "fixture-employee-c",
  };
  const result = app.login({ employeeId, password: passwords[employeeId], deviceLabel });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("登录失败");
  }
  return result;
}

test("空密钥、空种子和缺失种子都不能启动", () => {
  const base = { AI_MOCK_MODE: "true", CPCLAW_DATA_DIR: "/tmp/cpclaw-platform" };
  assert.equal(resolvePlatformConfig({ ...base, CPCLAW_SESSION_SECRET: "", CPCLAW_PLATFORM_SEED: "fixture" }, home).ok, false);
  assert.equal(resolvePlatformConfig({ ...base, CPCLAW_PLATFORM_SEED: "fixture" }, home).ok, false);
  assert.equal(resolvePlatformConfig({ ...base, CPCLAW_SESSION_SECRET: secret, CPCLAW_PLATFORM_SEED: "" }, home).ok, false);
  assert.equal(resolvePlatformConfig({ ...base, CPCLAW_SESSION_SECRET: secret }, home).ok, false);
  assert.equal(resolvePlatformConfig({
    ...base,
    CPCLAW_SESSION_SECRET: secret,
    CPCLAW_PLATFORM_SEED: "fixture",
    CPCLAW_LISTEN_HOST: "",
  }, home).ok, false);
  const dockerHost = resolvePlatformConfig({
    ...base,
    CPCLAW_SESSION_SECRET: secret,
    CPCLAW_PLATFORM_SEED: "fixture",
    CPCLAW_LISTEN_HOST: "0.0.0.0",
    CPCLAW_DATA_DIR: "/data",
  }, home);
  assert.equal(dockerHost.ok, true);
  if (dockerHost.ok) {
    assert.equal(dockerHost.config.listenHost, "0.0.0.0");
    assert.equal(dockerHost.config.dataDir, "/data");
  }
  const leaked = resolvePlatformConfig({
    ...base,
    CPCLAW_SESSION_SECRET: secret,
    CPCLAW_PLATFORM_SEED: "fixture",
    MINIMAX_API_KEY: "secret-value-should-not-leak",
  }, home);
  assert.equal(leaked.ok, true);
  assert.equal(JSON.stringify(leaked).includes("secret-value-should-not-leak"), false);
  if (leaked.ok) {
    assert.equal(leaked.config.keyPresent, true);
  }
});

test("未过期但已撤销的令牌不能继续调用", () => {
  const { app } = openFixture();
  try {
    const admin = login(app, "admin", "admin-device");
    const employee = login(app, "employee-a", "device-a");
    assert.equal(app.revoke(admin.accessToken, employee.sessionId).ok, true);
    const listed = app.listOwnSessions(employee.accessToken);
    assert.equal(listed.ok, false);
    if (!listed.ok) {
      assert.equal(listed.code, "SESSION_REVOKED");
      assert.equal(listed.message, "设备会话已撤销");
    }
  } finally {
    app.close();
  }
});

test("退出、续期和过期分别生效，并发续期只轮换一次", async () => {
  const { app, clock } = openFixture();
  try {
    const first = login(app, "employee-a", "device-a");
    const second = login(app, "employee-a", "device-b");
    assert.equal(app.logout(first.accessToken).ok, true);
    const loggedOut = app.listOwnSessions(first.accessToken);
    assert.equal(loggedOut.ok, false);
    if (!loggedOut.ok) {
      assert.equal(loggedOut.message, "已经退出");
    }
    assert.equal(app.listOwnSessions(second.accessToken).ok, true);
    clock.now += 61_000;
    const expired = app.listOwnSessions(second.accessToken);
    assert.equal(expired.ok, false);
    if (!expired.ok) {
      assert.equal(expired.message, "登录已过期");
    }
    const [renewedA, renewedB] = await Promise.all([
      app.refresh(second.refreshToken),
      app.refresh(second.refreshToken),
    ]);
    assert.equal(renewedA.ok, true);
    assert.equal(renewedB.ok, true);
    if (renewedA.ok && renewedB.ok) {
      assert.equal(renewedA.refreshToken, renewedB.refreshToken);
      assert.equal(app.listOwnSessions(renewedA.accessToken).ok, true);
    }
    const stale = await app.refresh(second.refreshToken);
    assert.equal(stale.ok, false);
  } finally {
    app.close();
  }
});

test("员工调不到管理接口，伪造 actor 不会记到别人的额度", async () => {
  const { app, dataDir } = openFixture();
  const started = await listenPlatform(app, { port: 0, dataDir });
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${started.port}/v1/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        employeeId: "employee-a",
        password: "fixture-employee-a",
        deviceLabel: "device-a",
        actor: "admin",
        role: "admin",
        employeeIdOverride: "employee-b",
      }),
    });
    const employee = await loginResponse.json();
    assert.equal(employee.role, "employee");
    const adminCall = await fetch(`http://127.0.0.1:${started.port}/v1/admin/employees`, {
      headers: { authorization: `Bearer ${employee.accessToken}` },
    });
    assert.equal(adminCall.status, 403);
    const reserved = await fetch(`http://127.0.0.1:${started.port}/v1/models/reserve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${employee.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "req-forge", employeeId: "employee-b", model: "MiniMax-M3" }),
    });
    assert.equal(reserved.status, 200);
    const own = app.readOwnQuota(employee.accessToken);
    assert.equal(own.ok, true);
    if (own.ok) {
      assert.equal(own.quota.concurrentInUse, 1);
    }
    const other = login(app, "employee-b", "device-b");
    const otherQuota = app.readOwnQuota(other.accessToken);
    assert.equal(otherQuota.ok, true);
    if (otherQuota.ok) {
      assert.equal(otherQuota.quota.concurrentInUse, 0);
    }
    const listed = await fetch(`http://127.0.0.1:${started.port}/v1/me/sessions?employeeId=employee-b`, {
      headers: { authorization: `Bearer ${employee.accessToken}` },
    });
    const sessions = await listed.json();
    assert.equal(sessions.sessions.every((item) => item.employeeId === "employee-a"), true);
    assert.equal(JSON.stringify(sessions).includes(other.sessionId), false);
  } finally {
    await started.close();
  }
});

test("跨组织撤销被拒绝，停用后旧令牌和再次登录都失败", () => {
  const { app } = openFixture();
  try {
    const admin = login(app, "admin");
    const other = login(app, "employee-c", "device-c");
    const denied = app.revoke(admin.accessToken, other.sessionId);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.code, "FORBIDDEN");
    }
    assert.equal(app.listOwnSessions(other.accessToken).ok, true);
    const employees = app.listEmployees(admin.accessToken);
    assert.equal(employees.ok, true);
    if (employees.ok) {
      assert.equal(employees.employees.some((item) => item.employeeId === "employee-c"), false);
    }
    const employee = login(app, "employee-a", "device-a2");
    assert.equal(app.disable(admin.accessToken, "employee-a").ok, true);
    const after = app.listOwnSessions(employee.accessToken);
    assert.equal(after.ok, false);
    if (!after.ok) {
      assert.equal(after.message, "账号已停用");
    }
    const again = app.login({ employeeId: "employee-a", password: "fixture-employee-a", deviceLabel: "device-a3" });
    assert.equal(again.ok, false);
    if (!again.ok) {
      assert.equal(again.message, "账号已停用");
    }
  } finally {
    app.close();
  }
});

test("第二台设备并发被拒绝，另一名员工仍可预留；未知用量不记为零", () => {
  const { app } = openFixture();
  try {
    const admin = login(app, "admin");
    const deviceA = login(app, "employee-a", "device-a");
    const deviceB = login(app, "employee-a", "device-b");
    const other = login(app, "employee-b", "device-other");
    const first = app.reserve(deviceA.accessToken, { requestId: "req-a" });
    assert.equal(first.ok, true);
    const second = app.reserve(deviceB.accessToken, { requestId: "req-b" });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.message, "并发已达上限");
    }
    assert.equal(app.reserve(other.accessToken, { requestId: "req-other" }).ok, true);
    assert.equal(app.settle(other.accessToken, { requestId: "req-other", usage: { state: "known", inputTokens: 1, outputTokens: 1 } }).ok, true);
    const unknown = app.settle(deviceA.accessToken, {
      requestId: "req-a",
      usage: { state: "unknown", inputTokens: 0, outputTokens: 0 },
    });
    assert.equal(unknown.ok, true);
    if (unknown.ok) {
      assert.equal(unknown.usage.state, "unknown");
    }
    const quota = app.readOwnQuota(deviceA.accessToken);
    assert.equal(quota.ok, true);
    if (quota.ok) {
      assert.equal(quota.quota.settledKnown, 0);
      assert.equal(quota.quota.unsettledUnknown, 100);
      assert.equal(quota.quota.openReserved, 0);
      assert.equal(quota.quota.availableTokens, 900);
    }
    const repeated = app.settle(deviceA.accessToken, { requestId: "req-a", usage: { state: "known", inputTokens: 1, outputTokens: 1 } });
    assert.equal(repeated.ok, true);
    const afterRepeat = app.readOwnQuota(deviceA.accessToken);
    assert.equal(afterRepeat.ok, true);
    if (afterRepeat.ok) {
      assert.equal(afterRepeat.quota.settledKnown, 0);
      assert.equal(afterRepeat.quota.unsettledUnknown, 100);
    }
    assert.equal(app.setQuota(deviceB.accessToken, { employeeId: "employee-a", limitTokens: 150, concurrentLimit: 5 }).ok, false);
    assert.equal(app.setQuota(admin.accessToken, { employeeId: "employee-b", limitTokens: 150, concurrentLimit: 5 }).ok, true);
    const tight = login(app, "employee-b", "device-tight");
    assert.equal(app.reserve(tight.accessToken, { requestId: "req-tight-1" }).ok, true);
    const budget = app.reserve(tight.accessToken, { requestId: "req-tight-2" });
    assert.equal(budget.ok, false);
    if (!budget.ok) {
      assert.equal(budget.message, "额度不足");
    }
  } finally {
    app.close();
  }
});

test("已知用量只结算一次，取消和超时保持未知", () => {
  const { app } = openFixture();
  try {
    const employee = login(app, "employee-a");
    const text = app.invoke(employee.accessToken, { requestId: "req-text", kind: "text" });
    assert.equal(text.ok, true);
    if (text.ok) {
      assert.equal(text.usage.state, "known");
    }
    const again = app.invoke(employee.accessToken, { requestId: "req-text", kind: "text" });
    assert.equal(again.ok, true);
    const quota = app.readOwnQuota(employee.accessToken);
    assert.equal(quota.ok, true);
    if (quota.ok) {
      assert.equal(quota.quota.settledKnown, 5);
      assert.equal(quota.quota.concurrentInUse, 0);
    }
    const cancelled = app.invoke(employee.accessToken, { requestId: "req-cancel", kind: "cancel" });
    assert.equal(cancelled.ok, true);
    if (cancelled.ok) {
      assert.equal(cancelled.usage.state, "unknown");
      assert.equal(cancelled.reservationStatus, "unknown");
    }
    const after = app.readOwnQuota(employee.accessToken);
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.equal(after.quota.settledKnown, 5);
      assert.equal(after.quota.unsettledUnknown, 100);
    }
  } finally {
    app.close();
  }
});

test("流式响应分片返回，管理接口不包含供应商密钥", async () => {
  const dataDir = tempDir();
  const opened = openPlatform({
    dataDir,
    port: 0,
    listenHost: "127.0.0.1",
    sessionSecret: secret,
    accessTtlSec: 60,
    refreshTtlSec: 3600,
    seed: { kind: "fixture", employees: fixtureEmployees },
    keyPresent: true,
    now: () => 1_700_000_000_000,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    return;
  }
  const started = await listenPlatform(opened.app, { port: 0, dataDir });
  try {
    const admin = login(opened.app, "admin");
    const employee = login(opened.app, "employee-a");
    const provider = await fetch(`http://127.0.0.1:${started.port}/v1/admin/provider`, {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const providerBody = await provider.json();
    assert.equal(providerBody.model, "MiniMax-M3");
    assert.equal(providerBody.keyPresent, true);
    assert.equal(Object.hasOwn(providerBody, "apiKey"), false);
    assert.equal(JSON.stringify(providerBody).includes("secret"), false);
    const denied = await fetch(`http://127.0.0.1:${started.port}/v1/admin/provider`, {
      headers: { authorization: `Bearer ${employee.accessToken}` },
    });
    assert.equal(denied.status, 403);
    const stream = await fetch(`http://127.0.0.1:${started.port}/v1/models/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${employee.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "req-stream", kind: "stream", model: "MiniMax-M3" }),
    });
    const raw = await stream.text();
    assert.equal(raw.includes("合成"), true);
    assert.equal(raw.includes("流结束"), true);
    assert.equal(raw.includes("\"state\":\"known\""), true);
    const otherModel = await fetch(`http://127.0.0.1:${started.port}/v1/models/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${employee.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "req-other-model", kind: "text", model: "MiniMax-M3-pro" }),
    });
    assert.equal(otherModel.status, 403);
    const backupDenied = await fetch(`http://127.0.0.1:${started.port}/v1/admin/backup`, {
      method: "POST",
      headers: { authorization: `Bearer ${employee.accessToken}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(backupDenied.status, 403);
    const backup = opened.app.backup(admin.accessToken);
    assert.equal(backup.ok, true);
    if (backup.ok) {
      const copy = new DatabaseSync(join(dataDir, "backups", backup.fileName), { readOnly: true });
      const row = copy.prepare("SELECT COUNT(*) AS count FROM employees").get();
      assert.equal(row.count, 4);
      copy.close();
    }
  } finally {
    await started.close();
  }
});

test("引导文件可以初始化，已有员工不会被合成账号覆盖", () => {
  const dataDir = tempDir();
  const bootstrap = join(dataDir, "bootstrap.json");
  writeFileSync(bootstrap, JSON.stringify({
    orgs: [{
      orgId: "org-file",
      orgName: "文件组织",
      employees: [{
        employeeId: "admin",
        name: "文件管理员",
        role: "admin",
        password: "file-admin-pass",
        limitTokens: 500,
        concurrentLimit: 1,
        reserveTokens: 50,
      }],
    }],
  }));
  const config = {
    dataDir,
    port: 0,
    listenHost: "127.0.0.1",
    sessionSecret: secret,
    accessTtlSec: 60,
    refreshTtlSec: 3600,
    seed: { kind: "bootstrap", path: bootstrap },
    keyPresent: false,
    now: () => 1_700_000_000_000,
  };
  const opened = openPlatform(config);
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    return;
  }
  const admin = opened.app.login({ employeeId: "admin", password: "file-admin-pass", deviceLabel: "device-file" });
  assert.equal(admin.ok, true);
  opened.app.close();
  const again = openPlatform({
    ...config,
    seed: { kind: "fixture", employees: fixtureEmployees },
  });
  assert.equal(again.ok, true);
  if (!again.ok) {
    return;
  }
  const still = again.app.login({ employeeId: "admin", password: "file-admin-pass", deviceLabel: "device-file-2" });
  assert.equal(still.ok, true);
  const fixtureLogin = again.app.login({ employeeId: "employee-a", password: "fixture-employee-a", deviceLabel: "device-a" });
  assert.equal(fixtureLogin.ok, false);
  again.app.close();
  assert.equal(readFileSync(bootstrap, "utf8").includes("file-admin-pass"), true);
});

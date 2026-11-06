import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureEmployees, listenPlatform, openPlatform } from "../dist/index.js";

const secret = "test-session-secret-0123456789abcdef";

test("已登录账号领取直连授权，日志不含密钥", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cpclaw-model-access-"));
  const opened = openPlatform({
    dataDir, port: 0, listenHost: "127.0.0.1", sessionSecret: secret, accessTtlSec: 60, refreshTtlSec: 3600,
    seed: { kind: "fixture", employees: fixtureEmployees }, keyPresent: true, now: () => 1_700_000_000_000,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const started = await listenPlatform(opened.app, {
    port: 0, dataDir,
    reportGateway: { mode: "real", baseUrl: "https://api.minimaxi.com/v1", apiKey: "secret-model-key", timeoutMs: 1000 },
  });
  try {
    const login = await fetch(`http://127.0.0.1:${started.port}/v1/session/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ employeeId: "employee-a", password: "fixture-employee-a", deviceLabel: "desktop" }),
    });
    const session = await login.json();
    const granted = await fetch(`http://127.0.0.1:${started.port}/v1/me/model-access`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    assert.equal(granted.status, 200);
    const body = await granted.json();
    assert.equal(body.mode, "real");
    assert.equal(body.model, "MiniMax-M3");
    assert.equal(body.baseUrl, "https://api.minimaxi.com/v1");
    assert.equal(body.apiKey, "secret-model-key");
    assert.equal(typeof body.limitTokens, "number");
    const anonymous = await fetch(`http://127.0.0.1:${started.port}/v1/me/model-access`);
    assert.equal(anonymous.status, 401);
    const log = readFileSync(join(dataDir, "logs", "platform.log"), "utf8");
    assert.match(log, /model_access_issued/);
    assert.equal(log.includes("secret-model-key"), false);
  } finally {
    await started.close();
    opened.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

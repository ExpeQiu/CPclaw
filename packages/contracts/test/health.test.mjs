import assert from "node:assert/strict";
import test from "node:test";

import {
  createHealthReport,
  createLogEvent,
  parseHealthReport,
  resolveDevHostConfig,
} from "../dist/index.js";

const home = { homeDir: "/tmp/cpclaw-home", target: "local" };

function validReport() {
  return {
    schemaVersion: 1,
    status: "ok",
    service: "cpclaw-dev-host",
    mode: "mock",
    aiMockMode: true,
    runtime: { node: "v22.23.3", platform: "darwin", arch: "arm64" },
  };
}

test("精确的 mock 配置使用默认目录和端口", () => {
  const result = resolveDevHostConfig({ AI_MOCK_MODE: "true" }, home);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.config.port, 3927);
  assert.equal(result.config.dataDir, "/tmp/cpclaw-home/Library/Application Support/CPclaw");
  assert.equal(result.config.aiMockMode, true);
});

test("缺失、空字符串和其他布尔写法都不能启动", () => {
  assert.equal(resolveDevHostConfig({}, home).ok, false);
  const empty = resolveDevHostConfig({ AI_MOCK_MODE: "" }, home);
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.code, "CONFIG_INVALID");
  }
  for (const value of ["false", "TRUE", "1", "true "]) {
    const result = resolveDevHostConfig({ AI_MOCK_MODE: value }, home);
    assert.equal(result.ok, false, value);
    if (!result.ok) {
      assert.equal(result.code, "MOCK_MODE_REQUIRED");
    }
  }
});

test("空数据目录和空端口不回落默认值", () => {
  const dir = resolveDevHostConfig(
    { AI_MOCK_MODE: "true", CPCLAW_DATA_DIR: "" },
    home,
  );
  assert.equal(dir.ok, false);
  if (!dir.ok) {
    assert.equal(dir.code, "CONFIG_INVALID");
  }
  const port = resolveDevHostConfig(
    { AI_MOCK_MODE: "true", CPCLAW_DEV_HOST_PORT: "" },
    home,
  );
  assert.equal(port.ok, false);
  if (!port.ok) {
    assert.equal(port.code, "CONFIG_INVALID");
  }
});

test("相对路径、同名前缀之外的 .. 和未实现目标被拒绝", () => {
  const relative = resolveDevHostConfig(
    { AI_MOCK_MODE: "true", CPCLAW_DATA_DIR: "var/data" },
    home,
  );
  assert.equal(relative.ok, false);
  const parent = resolveDevHostConfig(
    { AI_MOCK_MODE: "true", CPCLAW_DATA_DIR: "/tmp/cpclaw/../secret" },
    home,
  );
  assert.equal(parent.ok, false);
  const docker = resolveDevHostConfig({ AI_MOCK_MODE: "true" }, { ...home, target: "docker" });
  assert.equal(docker.ok, false);
  if (!docker.ok) {
    assert.equal(docker.code, "TARGET_UNAVAILABLE");
  }
});

test("健康报告拒绝额外字段、真实模式和未验证系统", () => {
  assert.equal(parseHealthReport(validReport()).ok, true);
  const extra = validReport();
  extra.note = "x";
  assert.equal(parseHealthReport(extra).ok, false);
  const real = validReport();
  real.mode = "real";
  real.aiMockMode = false;
  assert.equal(parseHealthReport(real).ok, false);
  assert.equal(
    createHealthReport({ node: "v22.23.3", platform: "linux", arch: "x64" }).ok,
    false,
  );
  assert.equal(
    createHealthReport({ node: "v22.23.3", platform: "darwin", arch: "arm64" }).ok,
    true,
  );
});

test("日志只接受白名单字段", () => {
  const ok = createLogEvent({
    timestamp: "2026-10-21T09:00:00.000Z",
    level: "info",
    service: "cpclaw-dev-host",
    event: "listening",
    message: "健康端口已监听",
    fields: { port: 3927 },
  });
  assert.equal(ok.ok, true);
  const bad = createLogEvent({
    timestamp: "2026-10-21T09:00:00.000Z",
    level: "info",
    service: "cpclaw-dev-host",
    event: "listening",
    message: "x",
    requestId: "../secret",
  });
  assert.equal(bad.ok, false);
});

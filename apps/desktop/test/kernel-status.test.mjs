import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveKernelStatus } from "../workspace-client.mjs";

test("包内 harness 清单存在时标为可用 deepseek-harness", () => {
  const root = mkdtempSync(join(tmpdir(), "cpclaw-kernel-"));
  const desktopDir = join(root, "desktop");
  const harness = join(root, "harness");
  mkdirSync(desktopDir);
  mkdirSync(harness);
  writeFileSync(join(harness, "manifest.json"), JSON.stringify({ version: "0.1.6-alpha.2" }));
  const status = resolveKernelStatus(desktopDir, {});
  assert.equal(status.name, "deepseek-harness");
  assert.equal(status.ready, true);
  assert.equal(status.source, "bundle");
  assert.equal(status.version, "0.1.6-alpha.2");
});

test("开发检出路径可用时显示目录名", () => {
  const root = mkdtempSync(join(tmpdir(), "cpclaw-kernel-checkout-"));
  const desktopDir = join(root, "desktop");
  const checkout = join(root, "deepseek-harness");
  mkdirSync(desktopDir);
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-root", version: "0.1.6-alpha.2" }));
  const status = resolveKernelStatus(desktopDir, {
    CPCLAW_REPORT_ENGINE: "harness",
    CPCLAW_HARNESS_ROOT: checkout,
  });
  assert.equal(status.name, "deepseek-harness");
  assert.equal(status.ready, true);
  assert.equal(status.source, "checkout");
});

test("未启用 harness 时红色不可用", () => {
  const root = mkdtempSync(join(tmpdir(), "cpclaw-kernel-none-"));
  const desktopDir = join(root, "desktop");
  mkdirSync(desktopDir);
  const status = resolveKernelStatus(desktopDir, {});
  assert.equal(status.ready, false);
  assert.equal(status.name, "未配置");
  assert.equal(status.source, "none");
});

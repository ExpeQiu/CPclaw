import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyDesktopSettingsToProcessEnv,
  coalesceSaved,
  getDesktopSettingsView,
  saveDesktopSettings,
  syncDesktopSettingsFromEnv,
} from "../desktop-settings.mjs";

test("coalesceSaved：已写出空串不回落", () => {
  assert.equal(coalesceSaved("", "/env/path"), "");
  assert.equal(coalesceSaved(undefined, "/env/path"), "/env/path");
});

test("首次无文件时视图回落 env，不写出设置文件", () => {
  const root = mkdtempSync(join(tmpdir(), "cpclaw-settings-"));
  const desktopDir = join(root, "desktop");
  const dataDir = join(root, "data");
  mkdirSync(desktopDir);
  mkdirSync(dataDir);
  const checkout = join(root, "deepseek-harness");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "0.1.6-alpha.2" }));
  const view = getDesktopSettingsView(dataDir, desktopDir, {
    appVersion: "0.0.21",
    env: {
      CPCLAW_REPORT_ENGINE: "harness",
      CPCLAW_HARNESS_ROOT: checkout,
      CPCLAW_REPORT_MODEL_MODE: "real",
    },
  });
  assert.equal(view.ok, true);
  assert.equal(view.reportEngine, "harness");
  assert.equal(view.harnessRoot, checkout);
  assert.equal(view.reportModelMode, "real");
  assert.equal(view.sources.reportEngine, "env");
  assert.equal(view.kernel.ready, true);
  assert.throws(() => readFileSync(join(dataDir, "desktop-settings.json")));
});

test("保存后以 UI 为准，env 变更不盖回", () => {
  const root = mkdtempSync(join(tmpdir(), "cpclaw-settings-save-"));
  const desktopDir = join(root, "desktop");
  const dataDir = join(root, "data");
  mkdirSync(desktopDir);
  mkdirSync(dataDir);
  const checkout = join(root, "deepseek-harness");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "9.9.9" }));
  const env = {
    CPCLAW_REPORT_ENGINE: "harness",
    CPCLAW_HARNESS_ROOT: "/tmp/should-not-win",
    CPCLAW_REPORT_MODEL_MODE: "real",
  };
  const saved = saveDesktopSettings(dataDir, desktopDir, {
    reportEngine: "harness",
    harnessRoot: checkout,
    reportModelMode: "mock",
    appVersion: "0.0.21",
  }, { env });
  assert.equal(saved.ok, true);
  assert.equal(saved.reportModelMode, "mock");
  assert.equal(saved.sources.reportModelMode, "settings");

  env.CPCLAW_REPORT_MODEL_MODE = "real";
  env.CPCLAW_HARNESS_ROOT = "/tmp/other";
  const view = getDesktopSettingsView(dataDir, desktopDir, { appVersion: "0.0.21", env });
  assert.equal(view.reportModelMode, "mock");
  assert.equal(view.harnessRoot, checkout);
  assert.equal(view.sources.harnessRoot, "settings");
});

test("显式从 env 同步会覆盖已保存行", () => {
  const root = mkdtempSync(join(tmpdir(), "cpclaw-settings-sync-"));
  const desktopDir = join(root, "desktop");
  const dataDir = join(root, "data");
  mkdirSync(desktopDir);
  mkdirSync(dataDir);
  const first = join(root, "harness-a");
  const second = join(root, "harness-b");
  for (const dir of [first, second]) {
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
  }
  saveDesktopSettings(dataDir, desktopDir, {
    reportEngine: "harness",
    harnessRoot: first,
    reportModelMode: "mock",
  }, { env: {} });
  const synced = syncDesktopSettingsFromEnv(dataDir, desktopDir, {
    appVersion: "0.0.21",
    env: {
      CPCLAW_REPORT_ENGINE: "harness",
      CPCLAW_HARNESS_ROOT: second,
      CPCLAW_REPORT_MODEL_MODE: "real",
    },
  });
  assert.equal(synced.ok, true);
  assert.equal(synced.harnessRoot, second);
  assert.equal(synced.reportModelMode, "real");
});

test("applyDesktopSettingsToProcessEnv 只改已写出字段", () => {
  const root = mkdtempSync(join(tmpdir(), "cpclaw-settings-apply-"));
  const desktopDir = join(root, "desktop");
  const dataDir = join(root, "data");
  mkdirSync(desktopDir);
  mkdirSync(dataDir);
  const checkout = join(root, "deepseek-harness");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "0.1.0" }));
  const env = { CPCLAW_REPORT_MODEL_MODE: "real", KEEP_ME: "1" };
  applyDesktopSettingsToProcessEnv(dataDir, desktopDir, env);
  assert.equal(env.CPCLAW_REPORT_MODEL_MODE, "real");
  assert.equal(env.KEEP_ME, "1");
  assert.equal(env.CPCLAW_REPORT_ENGINE, undefined);

  saveDesktopSettings(dataDir, desktopDir, {
    reportEngine: "harness",
    harnessRoot: checkout,
    reportModelMode: "mock",
  }, { env });
  assert.equal(env.CPCLAW_REPORT_ENGINE, "harness");
  assert.equal(env.CPCLAW_HARNESS_ROOT, checkout);
  assert.equal(env.CPCLAW_REPORT_MODEL_MODE, "mock");
});

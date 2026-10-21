import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function walk(directory, hit) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path, hit);
      continue;
    }
    if (!/\.(mjs|cjs|js|html|ts)$/.test(path)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (text.includes("@deepseek-ai/") || text.includes("harness-adapter") || text.includes("DeepSeekHarness")) {
      hit.push(path);
    }
  }
}

const desktopHits = [];
walk(join(root, "apps", "desktop"), desktopHits);
if (desktopHits.length > 0) {
  fail(`界面引用了 Harness：${desktopHits.join(", ")}`);
}

const tests = spawnSync("pnpm", ["--filter", "./packages/*", "--if-present", "run", "test"], {
  cwd: root,
  stdio: "inherit",
});
if (tests.status !== 0) {
  process.exit(tests.status ?? 1);
}

const staged = spawnSync("node", ["scripts/stage-unsigned.mjs"], { cwd: root, encoding: "utf8" });
if (staged.status !== 0) {
  process.stderr.write(staged.stderr ?? "");
  process.exit(staged.status ?? 1);
}
const stageLine = staged.stdout.trim().split("\n").at(-1);
const stage = JSON.parse(stageLine ?? "{}").stage;
if (typeof stage !== "string") {
  fail("未得到未签名包目录");
}
const installed = spawnSync("node", ["run-report.mjs"], { cwd: stage, stdio: "inherit" });
if (installed.status !== 0) {
  process.exit(installed.status ?? 1);
}

const clickDir = spawnSync("mktemp", ["-d"], { encoding: "utf8" });
const clickData = (clickDir.stdout ?? "").trim();
const clicks = spawnSync("apps/desktop/node_modules/.bin/electron", ["apps/desktop", "--verify-clicks"], {
  cwd: root,
  env: { ...process.env, CPCLAW_DATA_DIR: clickData },
  encoding: "utf8",
});
process.stdout.write(clicks.stdout ?? "");
process.stderr.write(clicks.stderr ?? "");
if (clicks.status !== 0) {
  process.exit(clicks.status ?? 1);
}

const harness = spawnSync(
  "node",
  ["--import", "tsx", "scripts/run-harness-stream.mjs"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
process.stderr.write(harness.stderr ?? "");
process.stdout.write(harness.stdout ?? "");
if (harness.status !== 0) {
  process.exit(harness.status ?? 1);
}
const cancelled = spawnSync(
  "node",
  ["--import", "tsx", "scripts/run-harness-stream.mjs", "cancel"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
process.stderr.write(cancelled.stderr ?? "");
process.stdout.write(cancelled.stdout ?? "");
if (cancelled.status !== 0) {
  process.exit(cancelled.status ?? 1);
}

process.stdout.write("P0 工程检查完成。签名安装包未做。真实 MiniMax 仅在本机有密钥时另计。\n");

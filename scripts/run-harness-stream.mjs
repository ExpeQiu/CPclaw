import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockLlm } from "./mock-llm.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessRoot = process.env.CPCLAW_HARNESS_ROOT === undefined || process.env.CPCLAW_HARNESS_ROOT === ""
  ? resolve(root, "../../13 Github/deepseek-harness")
  : process.env.CPCLAW_HARNESS_ROOT;
const tsconfigPath = join(harnessRoot, "tsconfig.base.json");
if (process.env.TSX_TSCONFIG_PATH !== tsconfigPath) {
  const relaunched = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath, CPCLAW_HARNESS_ROOT: harnessRoot },
    stdio: "inherit",
  });
  process.exit(relaunched.status ?? 1);
}

await register(pathToFileURL(join(root, "scripts/harness-hooks.mjs")).href, {
  parentURL: import.meta.url,
  data: { harnessRoot },
});

const { cancelHarness, runTextStream } = await import("@cpclaw/harness-adapter");
const commit = spawnSync("git", ["-C", harnessRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
if (!commit.startsWith("ddefc45fbc")) {
  process.stderr.write(`Harness 提交不是候选 ddefc45fbc，实际 ${commit}\n`);
  process.exit(1);
}
const mode = process.argv[2] ?? "stream";
const llm = await startMockLlm({ hang: mode === "cancel" });
const dshHome = mkdtempSync(join(tmpdir(), "cpclaw-dsh-"));
try {
  if (mode === "cancel") {
    const measurement = await cancelHarness({ harnessRoot, dshHome, baseUrl: llm.baseUrl });
    const callsAtClose = llm.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.stdout.write(`${JSON.stringify({ commit, ...measurement, modelRequests: llm.requests.length })}\n`);
    if (!measurement.runRejected || measurement.childCommandSeenAfterClose || callsAtClose < 1 || llm.requests.length !== callsAtClose) {
      process.exitCode = 1;
    }
  } else {
    const measurement = await runTextStream({
      harnessRoot,
      dshHome,
      baseUrl: llm.baseUrl,
      prompt: "只回复：合成流结束",
    });
    process.stdout.write(`${JSON.stringify({ ...measurement, modelRequests: llm.requests })}\n`);
    const forwardedSecret = measurement.childEnvNames.some((name) => name.includes("MINIMAX"));
    if (!measurement.streamEnded || measurement.childCommandSeenAfterClose || !measurement.finalResponse.includes("合成流结束") || forwardedSecret) {
      process.exitCode = 1;
    }
  }
} finally {
  await llm.close();
}

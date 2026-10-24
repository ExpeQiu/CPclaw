import { register } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { runReportLoop } from "@cpclaw/harness-adapter";

/** 宿主拥有内核装配；桌面只提交类型化命令。 */
export async function runBoundReportLoop(input: Parameters<typeof runReportLoop>[0]): ReturnType<typeof runReportLoop> {
  if (!process.env.CPCLAW_HARNESS_BUNDLE) register(pathToFileURL(resolve(import.meta.dirname, "../../../scripts/harness-hooks.mjs")).href, {
    parentURL: import.meta.url,
    data: { harnessRoot: process.env.CPCLAW_HARNESS_ROOT },
  });
  const adapter = await import("@cpclaw/harness-adapter");
  return adapter.runReportLoop(input);
}

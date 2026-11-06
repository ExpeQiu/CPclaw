import {existsSync} from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { runReportLoop } from "@cpclaw/harness-adapter";

let sourceRootLoaded="";
/** 宿主拥有内核装配；桌面只提交类型化命令。 */
export async function runBoundReportLoop(input: Parameters<typeof runReportLoop>[0]): ReturnType<typeof runReportLoop> {
  if (!process.env.CPCLAW_HARNESS_BUNDLE) {
    const harnessRoot=process.env.CPCLAW_HARNESS_ROOT||resolve(import.meta.dirname,'../../../../../13 Github/deepseek-harness');
    if(!existsSync(resolve(harnessRoot,'packages/sdk/client/src/index.ts')))throw Error('未找到必需的 Harness 内核，请配置或安装完整应用');
    if(sourceRootLoaded&&sourceRootLoaded!==harnessRoot)throw Error('内核检出路径已改变，请重启工作进程');
    if(!sourceRootLoaded){const tsx=await import('tsx/esm/api');tsx.register({tsconfig:resolve(harnessRoot,'tsconfig.base.json')});sourceRootLoaded=harnessRoot;
    register(pathToFileURL(resolve(import.meta.dirname,'../../../scripts/harness-hooks.mjs')).href,{parentURL:import.meta.url,data:{harnessRoot}});}
  }
  const adapter = await import("@cpclaw/harness-adapter");
  return adapter.runReportLoop(input);
}

#!/usr/bin/env node
/**
 * 端到端验证技能市场首屏：并发走一遍真实调用链，确认不再出现「登录凭证无效」。
 * 直接驱动桌面端工作进程（与技能市场 iframe 相同的 market.call 通道）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceClient } from "../apps/desktop/workspace-client.mjs";

const desktopDir = fileURLToPath(new URL("../apps/desktop", import.meta.url));
const dataDir = process.env.CPCLAW_DESKTOP_DIR || join(process.env.HOME, "Library/Application Support/CPclaw");
const worker = createWorkspaceClient(dataDir, desktopDir);
const request = (method, input = {}, actorId = "employee-a") => worker.request({ method, input, actorId });

try {
  const status = await request("account.status");
  if (!status.ok) throw new Error(`账号状态读取失败: ${status.message}`);
  console.log(`[verify] 当前账号: ${status.employeeId} 平台: ${status.platformUrl}`);

  // 技能市场首屏会并发触发列表与目录请求。
  const results = await Promise.all([
    request("market.call", { action: "list", input: { summary: true } }),
    request("market.call", { action: "catalog", input: { scope: "market" } }),
    request("market.call", { action: "list", input: { summary: true } }),
    request("chat.services", {}),
  ]);

  let failed = 0;
  for (const [index, result] of results.entries()) {
    if (result.ok) {
      console.log(`[verify] 调用 ${index + 1}: 成功`);
    } else {
      failed += 1;
      console.error(`[verify] 调用 ${index + 1}: 失败 -> ${result.message} (${result.code ?? "无错误码"})`);
    }
  }
  if (failed > 0) {
    console.error("[verify] 技能市场仍不可用");
    process.exitCode = 1;
  } else {
    console.log("[verify] 技能市场首屏全部调用成功，未出现「登录凭证无效」");
  }
} finally {
  worker.stop();
}

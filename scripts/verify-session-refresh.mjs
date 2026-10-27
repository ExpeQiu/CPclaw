#!/usr/bin/env node
/**
 * 端到端验证：桌面端修复后的续期逻辑在真实平台上不会让会话失效。
 *
 * 场景与线上故障一致：
 *   1. 用桌面端本地会话调一次续期，平台轮换出新令牌；
 *   2. 立刻用「同一个旧令牌」再调一次——这正是并发续期会发生的事；
 *   3. 断言：第二次必须失败（平台一次性令牌语义），但
 *      桌面端修复后不会再出现这种情况——因为并发调用会共享同一次续期。
 *
 * 本脚本只做「单飞」验证：连续两次 refresh 复用同一 Promise，
 * 平台侧只会收到一次请求，因此不会作废任何令牌。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionRefresher, persistDesktopSession, readDesktopSession } from "../packages/desktop-host/dist/index.js";

const DESKTOP_DIR = process.env.CPCLAW_DESKTOP_DIR || join(process.env.HOME, "Library/Application Support/CPclaw");
const CONNECTION_PATH = join(DESKTOP_DIR, "desktop-connection.json");

const { platformUrl } = JSON.parse(readFileSync(CONNECTION_PATH, "utf8"));
const base = platformUrl.replace(/\/$/, "");

let platformCalls = 0;
const refresher = createSessionRefresher({
  read: () => readDesktopSession(DESKTOP_DIR),
  renew: async (current) => {
    platformCalls += 1;
    const response = await fetch(`${base}/v1/session/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `平台返回 ${response.status}`);
    return result;
  },
  persist: (session) => persistDesktopSession(DESKTOP_DIR, session),
});

// 模拟技能市场首屏：多个并发调用同时取令牌。
const results = await Promise.all([refresher.refresh(), refresher.refresh(), refresher.refresh(), refresher.refresh(), refresher.refresh()]);

const failures = results.filter((r) => !r.ok);
console.log(`[verify] 并发 5 次续期 -> 平台收到 ${platformCalls} 次请求，失败 ${failures.length} 次`);
if (failures.length > 0) {
  console.error(`[verify] 失败原因: ${failures.map((f) => f.message).join(" | ")}`);
  process.exit(1);
}
if (platformCalls !== 1) {
  console.error(`[verify] 期望平台只收到 1 次请求，实际 ${platformCalls} 次`);
  process.exit(1);
}

// 关键断言：本机令牌必须仍是平台上的有效令牌。
// 注意：平台续期是单次使用语义，这次校验同样会轮换令牌，
// 因此必须把新令牌写回，否则会再次把本机会话作废。
const stored = readDesktopSession(DESKTOP_DIR);
const verify = await fetch(`${base}/v1/session/refresh`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ refreshToken: stored.refreshToken }),
  signal: AbortSignal.timeout(15_000),
}).then((r) => r.json()).catch(() => ({}));

if (!verify.accessToken) {
  console.error(`[verify] 本机令牌已被平台作废，后续请求都会报「登录凭证无效」: ${verify.message ?? "未知原因"}`);
  process.exit(1);
}
persistDesktopSession(DESKTOP_DIR, {
  employeeId: verify.employeeId,
  sessionId: verify.sessionId,
  refreshToken: verify.refreshToken,
});
console.log("[verify] 本机令牌与平台一致，会话可用（最新令牌已写回本机）");

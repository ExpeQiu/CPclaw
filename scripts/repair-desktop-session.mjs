#!/usr/bin/env node
/**
 * 修复因刷新令牌竞态而失效的桌面端会话：重新登录并写回本机会话文件。
 *
 * 背景：平台续期是单次使用语义，桌面端并发续期会互相作废令牌，
 * 且最新令牌从未写回本机，导致本机令牌与平台永久不一致。
 * 单飞修复已上线，但已经失效的会话需要重新登录一次才能恢复。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESKTOP_DIR = process.env.CPCLAW_DESKTOP_DIR || join(process.env.HOME, "Library/Application Support/CPclaw");
const CONNECTION_PATH = join(DESKTOP_DIR, "desktop-connection.json");
const SESSION_DIR = join(DESKTOP_DIR, "accounts");

const employeeId = process.env.CPCLAW_EMPLOYEE_ID || "employee-a";
const password = process.env.CPCLAW_PASSWORD;
if (!password) {
  console.error("请通过环境变量 CPCLAW_PASSWORD 提供口令（不写入命令行与日志）");
  process.exit(1);
}

const { platformUrl } = JSON.parse(readFileSync(CONNECTION_PATH, "utf8"));
const base = platformUrl.replace(/\/$/, "");

const response = await fetch(`${base}/v1/session/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ employeeId, password, deviceLabel: "CPclaw-Desktop" }),
  signal: AbortSignal.timeout(15_000),
});
const result = await response.json().catch(() => ({}));
if (!response.ok || !result.accessToken) {
  console.error(`重新登录失败: ${result.message ?? response.status}`);
  process.exit(1);
}

const dir = join(SESSION_DIR, employeeId);
const session = {
  schemaVersion: 1,
  employeeId: result.employeeId,
  sessionId: result.sessionId,
  refreshToken: result.refreshToken,
};
writeFileSync(join(dir, "session.json"), `${JSON.stringify(session)}\n`, { mode: 0o600 });
writeFileSync(join(SESSION_DIR, "current.json"), `${JSON.stringify({ schemaVersion: 1, employeeId: result.employeeId })}\n`, { mode: 0o600 });

// 立刻验证：刚写入的令牌必须可续期。
const probe = await fetch(`${base}/v1/session/refresh`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ refreshToken: result.refreshToken }),
  signal: AbortSignal.timeout(15_000),
}).then((r) => r.json()).catch(() => ({}));

if (!probe.accessToken) {
  console.error(`写入后校验失败: ${probe.message ?? "未知原因"}`);
  process.exit(1);
}
writeFileSync(join(dir, "session.json"), `${JSON.stringify({
  schemaVersion: 1,
  employeeId: probe.employeeId,
  sessionId: probe.sessionId,
  refreshToken: probe.refreshToken,
})}\n`, { mode: 0o600 });

console.log(`[repair] 会话已重建并校验通过 employee=${probe.employeeId} session=${probe.sessionId}`);

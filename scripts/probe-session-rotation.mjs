#!/usr/bin/env node
/**
 * 只读探针：验证「刷新令牌轮换 + 并发刷新」竞态假设。
 *
 * 探针动作（对目标平台）：
 *  1. 用桌面端本地会话的 refreshToken 调 /v1/session/refresh 一次，取回新的 refreshToken；
 *  2. 立刻用「同一个旧 refreshToken」再调一次，观察是否被拒。
 *
 * 关键：脚本会把轮换后的新 refreshToken 写回桌面端会话文件，
 * 保证本地会话与平台一致（否则会把用户踢下线）。
 * 若步骤 2 返回 AUTH_REQUIRED，则证明平台执行单次轮换（一次性令牌）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESKTOP_DIR = process.env.CPCLAW_DESKTOP_DIR || join(process.env.HOME, "Library/Application Support/CPclaw");
const SESSION_PATH = join(DESKTOP_DIR, "accounts", "employee-a", "session.json");
const CONNECTION_PATH = join(DESKTOP_DIR, "desktop-connection.json");

function fail(message) {
  process.stderr.write(`[probe] ${message}\n`);
  process.exit(1);
}

const session = JSON.parse(readFileSync(SESSION_PATH, "utf8"));
const { platformUrl } = JSON.parse(readFileSync(CONNECTION_PATH, "utf8"));
const base = platformUrl.replace(/\/$/, "");

async function refresh(refreshToken) {
  const response = await fetch(`${base}/v1/session/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const first = await refresh(session.refreshToken);
console.log(`[probe] 第 1 次刷新（旧令牌）-> HTTP ${first.status} code=${first.body.code ?? "-"}`);
// 平台续期成功响应不含 ok 字段，只能依据 HTTP 状态与 accessToken 判断。
if (first.status !== 200 || !first.body.accessToken) fail(`第 1 次刷新就失败，无法继续：${first.body.message ?? ""}`);

const second = await refresh(session.refreshToken);
console.log(`[probe] 第 2 次刷新（同一旧令牌）-> HTTP ${second.status} code=${second.body.code ?? "-"} message=${second.body.message ?? "-"}`);

if (first.body.refreshToken) {
  const next = {
    schemaVersion: 1,
    employeeId: first.body.employeeId,
    sessionId: first.body.sessionId,
    refreshToken: first.body.refreshToken,
  };
  writeFileSync(SESSION_PATH, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  console.log(`[probe] 已把轮换后的新令牌写回本地会话（employee=${first.body.employeeId}）`);
}

const verdict = second.status === 200 && second.body.accessToken
  ? "旧令牌可重复使用：平台不做单次轮换，竞态假设不成立"
  : `旧令牌被拒（${second.body.code ?? second.status}）：平台执行单次轮换，客户端并发刷新必然踩雷`;
console.log(`[probe] 结论：${verdict}`);

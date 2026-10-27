import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionLock, createSessionRefresher } from "../dist/index.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-refresh-"));
}

test("并发续期只发出一次请求，其余调用方复用同一结果", async () => {
  const root = tempDir();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const refresher = createSessionRefresher({
    read: () => ({ employeeId: "employee-a", sessionId: "ses-a", refreshToken: "token-1" }),
    renew: async () => {
      calls += 1;
      await gate;
      return { employeeId: "employee-a", sessionId: "ses-a", refreshToken: "token-2", accessToken: "access-2" };
    },
    persist: () => true,
  });
  const all = Promise.all([refresher.refresh(), refresher.refresh(), refresher.refresh(), refresher.refresh()]);
  release();
  const results = await all;
  assert.equal(calls, 1, "并发续期应收敛为一次请求");
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.accessToken, "access-2");
  }
  assert.equal(refresher.busy, false);
  rmSync(root, { recursive: true, force: true });
});

test("续期失败不写回，并保留失败原因", async () => {
  const root = tempDir();
  let persisted = 0;
  const refresher = createSessionRefresher({
    read: () => ({ employeeId: "employee-a", sessionId: "ses-a", refreshToken: "token-1" }),
    renew: async () => {
      throw new Error("登录凭证无效");
    },
    persist: () => {
      persisted += 1;
      return true;
    },
  });
  const result = await refresher.refresh();
  assert.equal(result.ok, false);
  assert.match(result.message, /登录凭证无效/);
  assert.equal(persisted, 0, "失败时不应写回会话");
  rmSync(root, { recursive: true, force: true });
});

test("未登录时给出明确提示而不是崩溃", async () => {
  const root = tempDir();
  const refresher = createSessionRefresher({
    read: () => null,
    renew: async () => {
      throw new Error("不应调用");
    },
    persist: () => true,
  });
  const result = await refresher.refresh();
  assert.equal(result.ok, false);
  assert.match(result.message, /请先登录/);
  rmSync(root, { recursive: true, force: true });
});

test("跨进程锁把续期串行化", async () => {
  const root = tempDir();
  const lock = createSessionLock(root);
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = lock(async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
    return 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = lock(async () => {
    order.push("second-start");
    return 2;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, ["first-start"], "第二个续期必须等第一个完成");
  release();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  rmSync(root, { recursive: true, force: true });
});

test("陈旧锁会被回收，不会永久阻塞", async () => {
  const root = tempDir();
  const lock = createSessionLock(root);
  const lockDir = join(root, "locks");
  const lockPath = join(lockDir, "session-refresh.lock");
  mkdirSync(lockDir, { recursive: true });
  const stale = new Date(Date.now() - 120_000);
  writeFileSync(lockPath, "999999\n");
  utimesSync(lockPath, stale, stale);
  const result = await lock(async () => "ok");
  assert.equal(result, "ok");
  rmSync(root, { recursive: true, force: true });
});

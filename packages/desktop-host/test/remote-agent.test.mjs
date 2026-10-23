import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRemoteSessionAgent } from "../dist/remote-agent.js";
import { openLocalWorkspace } from "../dist/workspace.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-remote-"));
}

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    commandId: "cmd-1",
    channel: "feishu",
    channelTenantId: "tenant-fs",
    appId: "app-fs",
    conversationId: "conv-1",
    bindingId: "bind-1",
    bindingRevision: 1,
    deviceId: "pc-1",
    employeeId: "employee-a",
    kind: "ask",
    text: "IM 补充目标",
    expiresAtMs: 1_700_000_100_000,
    inboundKey: "feishu:tenant-fs:app-fs:msg-1",
    ...overrides,
  };
}

test("P4 远程代理：持久化回执、入队有序、重复 commandId 不重跑", () => {
  const dir = tempDir();
  const ws = openLocalWorkspace(dir);
  const agent = openRemoteSessionAgent(join(dir, "remote"), ws);
  try {
    assert.equal(
      ws.createTask({
        taskId: "task-1",
        revisionId: "rev-1",
        actorId: "employee-a",
        goal: "同任务双入口",
        acceptance: "桌面与 IM 有序",
        mode: "execute",
        budgetLimitCalls: 3,
        grants: [],
      }).ok,
      true,
    );

    const desktop = ws.enqueueInput("task-1", "桌面先补充");
    assert.equal(desktop.ok, true);
    assert.equal(desktop.source, "desktop");

    const first = agent.acceptEnvelope(envelope(), { taskId: "task-1", nowMs: 1_700_000_000_000 });
    assert.equal(first.ok, true);
    assert.equal(first.receipt.replayed, false);

    const replay = agent.acceptEnvelope(envelope({ text: "被改写也不该重跑" }), {
      taskId: "task-1",
      nowMs: 1_700_000_000_000,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.receipt.replayed, true);
    assert.equal(replay.receipt.text, "IM 补充目标");

    const wecom = agent.acceptEnvelope(
      envelope({
        commandId: "cmd-2",
        channel: "wecom",
        text: "企微再补充",
        inboundKey: "wecom:tenant-wc:app-wc:msg-2",
      }),
      { taskId: "task-1", nowMs: 1_700_000_000_000 },
    );
    assert.equal(wecom.ok, true);

    const bench = ws.readWorkbench("employee-a");
    assert.equal(bench.ok, true);
    const inputs = bench.tasks[0].inputs;
    assert.equal(inputs.length, 3);
    assert.equal(inputs[0].source, "desktop");
    assert.equal(inputs[0].body, "桌面先补充");
    assert.equal(inputs[1].source, "feishu");
    assert.equal(inputs[1].commandId, "cmd-1");
    assert.equal(inputs[2].source, "wecom");
    assert.equal(inputs[2].body, "企微再补充");

    const expired = agent.acceptEnvelope(envelope({ commandId: "cmd-old", expiresAtMs: 1 }), {
      taskId: "task-1",
      nowMs: 1_700_000_000_000,
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) {
      assert.equal(expired.code, "EXPIRED");
    }
  } finally {
    agent.close();
    ws.close();
  }
});

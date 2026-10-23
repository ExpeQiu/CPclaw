import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupWorkspace, restoreWorkspace } from "../dist/index.js";
import { openLocalWorkspace } from "../dist/workspace.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-recovery-"));
}

test("写前中断不产生备份；写后中断保留待核实文件", () => {
  const dir = tempDir();
  const ws = openLocalWorkspace(dir);
  ws.createTask({
    taskId: "task-1",
    revisionId: "rev-1",
    actorId: "employee-a",
    goal: "目标",
    acceptance: "验收",
    mode: "execute",
    budgetLimitCalls: 2,
    grants: [],
  });
  ws.close();

  const before = backupWorkspace(dir, { failBeforeWrite: true });
  assert.equal(before.ok, false);
  assert.equal(existsSync(join(dir, "backups")), false);

  const after = backupWorkspace(dir, { failAfterWrite: true });
  assert.equal(after.ok, false);
  assert.equal(existsSync(join(dir, "backups")), true);
});

test("备份恢复后可重新打开并保留任务", () => {
  const dir = tempDir();
  const ws = openLocalWorkspace(dir);
  ws.createTask({
    taskId: "task-restore",
    revisionId: "rev-1",
    actorId: "employee-a",
    goal: "恢复目标",
    acceptance: "验收",
    mode: "execute",
    budgetLimitCalls: 2,
    grants: [],
  });
  ws.close();
  const backup = backupWorkspace(dir);
  assert.equal(backup.ok, true);
  if (!backup.ok) {
    throw new Error("备份失败");
  }
  const ws2 = openLocalWorkspace(dir);
  ws2.createTask({
    taskId: "task-new",
    revisionId: "rev-2",
    actorId: "employee-a",
    goal: "新任务",
    acceptance: "验收",
    mode: "execute",
    budgetLimitCalls: 1,
    grants: [],
  });
  ws2.close();
  const restored = restoreWorkspace(dir, backup.fileName);
  assert.equal(restored.ok, true);
  const ws3 = openLocalWorkspace(dir);
  const board = ws3.readWorkbench("employee-a");
  assert.equal(board.ok, true);
  assert.equal(board.tasks.some((item) => item.taskId === "task-restore"), true);
  assert.equal(board.tasks.some((item) => item.taskId === "task-new"), false);
  ws3.close();
  assert.equal(readFileSync(join(dir, "restore-marker.json"), "utf8").includes(backup.fileName), true);
});

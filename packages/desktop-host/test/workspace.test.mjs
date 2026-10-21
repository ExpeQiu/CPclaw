import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSyntheticReport } from "@cpclaw/contracts";
import { WIKI_REVISION_CAP, openLocalWorkspace } from "../dist/workspace.js";

const materials = [
  { fileName: "policy-excerpt.md", paragraphs: [{ id: "p1", text: "制度要求保留来源" }] },
  { fileName: "project-note.md", paragraphs: [{ id: "p1", text: "项目记录只覆盖本机材料" }] },
];
const materialNames = materials.map((item) => item.fileName);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-ws-"));
}

function taskInput(overrides = {}) {
  return {
    taskId: "task-1",
    revisionId: "rev-1",
    actorId: "employee-a",
    goal: "生成带来源的报告",
    acceptance: "四节且来源可核对",
    mode: "execute",
    budgetLimitCalls: 2,
    grants: [],
    ...overrides,
  };
}

test("同一员工只有一个活动槽，重启后标为中断", () => {
  const dir = tempDir();
  const first = openLocalWorkspace(dir);
  try {
    assert.equal(first.createTask(taskInput()).ok, true);
    assert.equal(
      first.createTask(taskInput({ taskId: "task-2", revisionId: "rev-2" })).ok,
      true,
    );
    assert.equal(
      first.createTask({ ...taskInput(), taskId: "task-b", revisionId: "rev-b", actorId: "employee-b" }).ok,
      true,
    );
    const started = first.startRun({
      taskId: "task-1",
      runId: "run-1",
      idempotencyKey: "start-1",
      expectedRevisionId: "rev-1",
    });
    const replay = first.startRun({
      taskId: "task-1",
      runId: "run-x",
      idempotencyKey: "start-1",
      expectedRevisionId: "rev-1",
    });
    const blocked = first.startRun({
      taskId: "task-2",
      runId: "run-2",
      idempotencyKey: "start-2",
      expectedRevisionId: "rev-2",
    });
    const other = first.startRun({
      taskId: "task-b",
      runId: "run-b",
      idempotencyKey: "start-b",
      expectedRevisionId: "rev-b",
    });
    assert.equal(started.ok, true);
    assert.equal(replay.ok, true);
    if (started.ok && replay.ok) {
      assert.equal(replay.replayed, true);
      assert.equal(replay.runId, "run-1");
    }
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.code, "SLOT_BUSY");
    }
    assert.equal(other.ok, true);
  } finally {
    first.close();
  }

  const second = openLocalWorkspace(dir);
  try {
    assert.deepEqual(second.interruptedOnOpen.slice().sort(), ["run-1", "run-b"]);
    const interrupted = second.readRun("run-1");
    assert.equal(interrupted.ok, true);
    if (interrupted.ok) {
      assert.equal(interrupted.status, "interrupted");
      assert.equal(interrupted.controlReason, "restart");
    }
    const resumed = second.continueRun({
      taskId: "task-1",
      runId: "run-3",
      idempotencyKey: "start-3",
      expectedRevisionId: "rev-1",
    });
    assert.equal(resumed.ok, true);
    if (resumed.ok) {
      assert.equal(resumed.attempt, 2);
    }
  } finally {
    second.close();
  }
});

test("最终消息只保留一条，重复事件不重复投影", () => {
  const dir = tempDir();
  const ws = openLocalWorkspace(dir);
  try {
    ws.createTask(taskInput());
    ws.startRun({ taskId: "task-1", runId: "run-1", idempotencyKey: "start-1", expectedRevisionId: "rev-1" });
    ws.appendToken("run-1", "片");
    ws.appendToken("run-1", "段");
    const final = ws.appendFinal("run-1", "msg-1", "完成");
    const replaced = ws.appendFinal("run-1", "msg-1", "完成。补充");
    assert.equal(final.ok, true);
    assert.equal(replaced.ok, true);
    if (!final.ok || !replaced.ok) {
      return;
    }
    const events = ws.readEvents("run-1", 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].body, "完成。补充");
    assert.equal(events[0].body.includes("片段"), false);
    assert.equal(ws.readEvents("run-1", replaced.seq).length, 0);

    const noted = ws.projectEvent("run-1", replaced.seq + 1, "记录");
    const replayed = ws.projectEvent("run-1", replaced.seq + 1, "记录");
    const conflict = ws.projectEvent("run-1", replaced.seq + 1, "另一条");
    assert.equal(noted.ok, true);
    assert.equal(replayed.ok, true);
    if (replayed.ok) {
      assert.equal(replayed.replayed, true);
    }
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
    }
    assert.equal(ws.readEvents("run-1", replaced.seq).length, 1);
  } finally {
    ws.close();
  }
});

test("问答和规划不能暂存写入，补充按顺序取出", () => {
  const dir = tempDir();
  const output = join(dir, "out");
  mkdirSync(output);
  const ws = openLocalWorkspace(dir);
  try {
    for (const mode of ["ask", "plan"]) {
      const taskId = `task-${mode}`;
      ws.createTask(taskInput({ taskId, revisionId: `rev-${mode}`, mode, grants: [{ kind: "directory", path: output, access: "write" }] }));
      ws.startRun({ taskId, runId: `run-${mode}`, idempotencyKey: `key-${mode}`, expectedRevisionId: `rev-${mode}` });
      const staged = ws.stageChange({
        changeId: `chg-${mode}`,
        taskId,
        runId: `run-${mode}`,
        path: join(output, "report.md"),
        body: "不能写",
        materialNames,
      });
      assert.equal(staged.ok, false);
      if (!staged.ok) {
        assert.equal(staged.code, "MODE_READONLY");
      }
      ws.cancelRun(`run-${mode}`, "cancel");
    }
    assert.equal(existsSync(join(output, "report.md")), false);
    ws.createTask(taskInput({ taskId: "task-q", revisionId: "rev-q" }));
    const first = ws.enqueueInput("task-q", "先补充来源");
    const second = ws.enqueueInput("task-q", "再补充范围");
    const takenFirst = ws.takeInput("task-q");
    const takenSecond = ws.takeInput("task-q");
    assert.equal(first.ok && second.ok && takenFirst.ok && takenSecond.ok, true);
    if (takenFirst.ok && takenSecond.ok) {
      assert.equal(takenFirst.body, "先补充来源");
      assert.equal(takenSecond.body, "再补充范围");
      assert.ok(takenFirst.seq < takenSecond.seq);
    }
  } finally {
    ws.close();
  }
});

test("预算跨执行累计，未知用量不记为零，暂停保留已写文件", () => {
  const dir = tempDir();
  const file = join(dir, "already.txt");
  writeFileSync(file, "已经写过", "utf8");
  const ws = openLocalWorkspace(dir);
  try {
    ws.createTask(taskInput());
    ws.startRun({ taskId: "task-1", runId: "run-1", idempotencyKey: "start-1", expectedRevisionId: "rev-1" });
    const first = ws.recordUsage("task-1", { kind: "known", calls: 1, runId: "run-1" });
    assert.equal(first.ok, true);
    ws.noteSideEffect("run-1", file);
    const paused = ws.cancelRun("run-1", "pause");
    assert.equal(paused.ok, true);
    if (paused.ok) {
      assert.equal(paused.status, "cancelled");
      assert.equal(paused.controlReason, "pause");
      assert.deepEqual(paused.sideEffectPaths, [file]);
    }
    assert.equal(readFileSync(file, "utf8"), "已经写过");
    const afterStop = ws.recordUsage("task-1", { kind: "known", calls: 1, runId: "run-1" });
    assert.equal(afterStop.ok, false);
    if (!afterStop.ok) {
      assert.equal(afterStop.code, "CANCELLED");
    }

    const continued = ws.continueRun({
      taskId: "task-1",
      runId: "run-2",
      idempotencyKey: "start-2",
      expectedRevisionId: "rev-1",
    });
    assert.equal(continued.ok, true);
    const second = ws.recordUsage("task-1", { kind: "known", calls: 1, runId: "run-2" });
    const third = ws.recordUsage("task-1", { kind: "known", calls: 1, runId: "run-2" });
    assert.equal(second.ok, true);
    assert.equal(third.ok, false);
    if (!third.ok) {
      assert.equal(third.code, "BUDGET_EXCEEDED");
    }
    const budget = ws.readBudget("task-1");
    assert.equal(budget.ok, true);
    if (budget.ok) {
      assert.equal(budget.spentCalls, 2);
      assert.equal(budget.unknownUsageCount, 0);
    }
    ws.cancelRun("run-2", "budget");

    ws.createTask(taskInput({ taskId: "task-u", revisionId: "rev-u", budgetLimitCalls: 4 }));
    ws.startRun({ taskId: "task-u", runId: "run-u", idempotencyKey: "start-u", expectedRevisionId: "rev-u" });
    const unknown = ws.recordUsage("task-u", { kind: "unknown", operationId: "op-unknown", runId: "run-u" });
    assert.equal(unknown.ok, true);
    if (unknown.ok) {
      assert.equal(unknown.spentCalls, 0);
      assert.equal(unknown.unknownUsageCount, 1);
    }
    const unknownBudget = ws.readBudget("task-u");
    assert.equal(unknownBudget.ok, true);
    if (unknownBudget.ok) {
      assert.deepEqual(unknownBudget.unknownOperationIds, ["op-unknown"]);
    }
    const stopped = ws.cancelRun("run-u", "cancel");
    assert.equal(stopped.ok, true);
    if (stopped.ok) {
      assert.equal(stopped.status, "reconcile_required");
    }
    const blocked = ws.continueRun({
      taskId: "task-u",
      runId: "run-u2",
      idempotencyKey: "start-u2",
      expectedRevisionId: "rev-u",
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.code, "RECONCILE_REQUIRED");
    }
    const compressed = ws.compressTask("task-u");
    assert.equal(compressed.ok, true);
    if (compressed.ok) {
      assert.equal(compressed.owner, "host");
      assert.equal(compressed.budgetSpentCalls, 0);
      assert.deepEqual(compressed.unknownOperationIds, ["op-unknown"]);
    }
    const kept = ws.readBudget("task-u");
    assert.equal(kept.ok, true);
    if (kept.ok) {
      assert.equal(kept.unknownUsageCount, 1);
      assert.equal(kept.spentCalls, 0);
    }
  } finally {
    ws.close();
  }
});

test("拒绝不落盘，接受后可打开，改目标后旧变更失效", () => {
  const dir = tempDir();
  const output = join(dir, "out");
  const outside = join(dir, "out-side");
  mkdirSync(output);
  mkdirSync(outside);
  const report = join(output, "report.md");
  const body = buildSyntheticReport({ goal: "生成带来源的报告", materials });
  const ws = openLocalWorkspace(dir);
  try {
    ws.createTask(taskInput({ grants: [{ kind: "directory", path: output, access: "write" }] }));
    ws.startRun({ taskId: "task-1", runId: "run-1", idempotencyKey: "start-1", expectedRevisionId: "rev-1" });
    const outsideStage = ws.stageChange({
      changeId: "chg-out",
      taskId: "task-1",
      runId: "run-1",
      path: join(outside, "report.md"),
      body,
      materialNames,
    });
    assert.equal(outsideStage.ok, false);
    if (!outsideStage.ok) {
      assert.equal(outsideStage.code, "OUTSIDE_GRANT");
    }
    ws.stageChange({ changeId: "chg-no", taskId: "task-1", runId: "run-1", path: report, body, materialNames });
    const rejected = ws.decideChange("chg-no", "reject");
    assert.equal(rejected.ok, true);
    assert.equal(existsSync(report), false);

    ws.stageChange({ changeId: "chg-stale", taskId: "task-1", runId: "run-1", path: report, body, materialNames });
    const revised = ws.reviseTask({
      taskId: "task-1",
      revisionId: "rev-2",
      expectedRevisionId: "rev-1",
      goal: "改写报告目标",
      acceptance: "四节且来源可核对",
    });
    assert.equal(revised.ok, true);
    const stale = ws.decideChange("chg-stale", "accept");
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.code, "REVISION_CONFLICT");
    }
    assert.equal(existsSync(report), false);

    ws.cancelRun("run-1", "cancel");
    ws.startRun({ taskId: "task-1", runId: "run-2", idempotencyKey: "start-2", expectedRevisionId: "rev-2" });
    ws.stageChange({ changeId: "chg-yes", taskId: "task-1", runId: "run-2", path: report, body, materialNames });
    const accepted = ws.decideChange("chg-yes", "accept");
    assert.equal(accepted.ok, true);
    const opened = ws.readAcceptedFile("chg-yes");
    assert.equal(opened.ok, true);
    if (opened.ok) {
      assert.equal(opened.text.includes("# 任务目标"), true);
      assert.equal(opened.text.includes("policy-excerpt.md#p1"), true);
    }
  } finally {
    ws.close();
  }
});

test("用户改过已接受文件时，恢复提示冲突且不覆盖", () => {
  const dir = tempDir();
  const output = join(dir, "out");
  mkdirSync(output);
  const report = join(output, "report.md");
  const body = buildSyntheticReport({ goal: "生成带来源的报告", materials });
  const ws = openLocalWorkspace(dir);
  try {
    ws.createTask(taskInput({ grants: [{ kind: "directory", path: output, access: "write" }] }));
    ws.startRun({ taskId: "task-1", runId: "run-1", idempotencyKey: "start-1", expectedRevisionId: "rev-1" });
    ws.stageChange({ changeId: "chg-1", taskId: "task-1", runId: "run-1", path: report, body, materialNames });
    assert.equal(ws.decideChange("chg-1", "accept").ok, true);
    writeFileSync(report, "用户后来改过这一段", "utf8");
    const restored = ws.restoreChange("chg-1");
    assert.equal(restored.ok, false);
    if (!restored.ok) {
      assert.equal(restored.code, "REVISION_CONFLICT");
    }
    assert.equal(readFileSync(report, "utf8"), "用户后来改过这一段");
  } finally {
    ws.close();
  }
});

test("项目不扩大目录授权，记忆按域隔离", () => {
  const dir = tempDir();
  const output = join(dir, "out");
  mkdirSync(output);
  const ws = openLocalWorkspace(dir);
  try {
    ws.createProject({ projectId: "project-1", actorId: "employee-a", name: "甲项目" });
    ws.createProject({ projectId: "project-2", actorId: "employee-a", name: "乙项目" });
    ws.createTask(taskInput({ grants: [{ kind: "file", path: join(dir, "note.md"), access: "read" }] }));
    const before = ws.readTask("task-1");
    const attached = ws.attachProject("task-1", "project-1");
    const after = ws.readTask("task-1");
    assert.equal(before.ok && attached.ok && after.ok, true);
    if (before.ok && attached.ok && after.ok) {
      assert.equal(after.grantCount, before.grantCount);
      assert.equal(attached.grantCount, before.grantCount);
      assert.equal(after.projectId, "project-1");
    }
    ws.startRun({ taskId: "task-1", runId: "run-1", idempotencyKey: "start-1", expectedRevisionId: "rev-1" });
    const write = ws.stageChange({
      changeId: "chg-1",
      taskId: "task-1",
      runId: "run-1",
      path: join(output, "report.md"),
      body: "x",
      materialNames,
    });
    assert.equal(write.ok, false);
    if (!write.ok) {
      assert.equal(write.code, "OUTSIDE_GRANT");
    }

    ws.remember({ memoryId: "mem-p", actorId: "employee-a", scope: "project", projectId: "project-1", body: "只属于甲项目" });
    ws.remember({ memoryId: "mem-self", actorId: "employee-a", scope: "personal", body: "个人备忘" });
    ws.remember({ memoryId: "mem-org", actorId: "employee-a", scope: "org", orgId: "org-1", body: "组织备忘" });
    const otherProject = ws.listMemories({ actorId: "employee-a", projectId: "project-2", orgId: "org-1" });
    const otherActor = ws.listMemories({ actorId: "employee-b", projectId: "project-1", orgId: "org-2" });
    assert.equal(otherProject.ok && otherActor.ok, true);
    if (otherProject.ok && otherActor.ok) {
      assert.equal(otherProject.memories.some((item) => item.body === "只属于甲项目"), false);
      assert.equal(otherProject.memories.some((item) => item.body === "个人备忘"), true);
      assert.equal(otherActor.memories.some((item) => item.memoryId === "mem-self"), false);
      assert.equal(otherActor.memories.some((item) => item.body === "组织备忘"), false);
    }
    assert.equal(ws.editMemory("mem-p", "甲项目已修改").ok, true);
    assert.equal(ws.deleteMemory("mem-self").ok, true);
    const edited = ws.listMemories({ actorId: "employee-a", projectId: "project-1", orgId: "org-1" });
    assert.equal(edited.ok, true);
    if (edited.ok) {
      assert.equal(edited.memories.some((item) => item.body === "只属于甲项目"), false);
      assert.equal(edited.memories.some((item) => item.body === "甲项目已修改"), true);
      assert.equal(edited.memories.some((item) => item.memoryId === "mem-self"), false);
    }
  } finally {
    ws.close();
  }
});

test("个人笔记只收录选出的文件，不改原件，冲突可见，重启仍可引用", () => {
  const dir = tempDir();
  const source = join(dir, "note.md");
  const sibling = join(dir, "other.md");
  const original = "原始材料，不要改";
  writeFileSync(source, original, "utf8");
  writeFileSync(sibling, "没有被选中", "utf8");
  const first = openLocalWorkspace(dir);
  try {
    const directory = first.selectWikiSource({
      sourceId: "src-dir",
      pageId: "page-dir",
      actorId: "employee-a",
      filePath: dir,
      maintenance: false,
    });
    assert.equal(directory.ok, false);
    if (!directory.ok) {
      assert.equal(directory.code, "DIRECTORY_NOT_ALLOWED");
    }
    assert.equal(
      first.selectWikiSource({
        sourceId: "src-1",
        pageId: "page-1",
        actorId: "employee-a",
        filePath: source,
        maintenance: false,
      }).ok,
      true,
    );
    assert.equal(first.listWiki("employee-a").length, 1);
    assert.equal(first.listWiki("employee-a").some((item) => item.path === sibling), false);
    const denied = first.reviseWiki({
      pageId: "page-1",
      actorId: "employee-a",
      body: "自动改写",
      origin: "auto",
      baseRevision: 1,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.code, "MAINTENANCE_DENIED");
    }
  } finally {
    first.close();
  }

  const dir2 = tempDir();
  const source2 = join(dir2, "note.md");
  writeFileSync(source2, original, "utf8");
  const ws = openLocalWorkspace(dir2);
  try {
    ws.selectWikiSource({
      sourceId: "src-1",
      pageId: "page-1",
      actorId: "employee-a",
      filePath: source2,
      maintenance: true,
    });
    const human = ws.reviseWiki({
      pageId: "page-1",
      actorId: "employee-a",
      body: "人工修订",
      origin: "human",
      baseRevision: 1,
    });
    assert.equal(human.ok, true);
    const conflict = ws.reviseWiki({
      pageId: "page-1",
      actorId: "employee-a",
      body: "按旧修订自动维护",
      origin: "auto",
      baseRevision: 1,
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.code, "WIKI_CONFLICT");
    }
    const revisions = ws.listWikiRevisions("page-1");
    assert.equal(revisions.length, 2);
    assert.equal(revisions.some((item) => item.body === "人工修订"), true);
    assert.equal(revisions.some((item) => item.body === "按旧修订自动维护"), false);
    assert.equal(readFileSync(source2, "utf8"), original);
    const cited = ws.citeWiki("page-1");
    assert.equal(cited.ok, true);
    if (cited.ok) {
      assert.equal(cited.revision, 2);
      assert.equal(cited.excerpt.includes("人工修订"), true);
    }
  } finally {
    ws.close();
  }

  const reopened = openLocalWorkspace(dir2);
  try {
    const cited = reopened.citeWiki("page-1");
    assert.equal(cited.ok, true);
    if (cited.ok) {
      assert.equal(cited.revision, 2);
    }
    assert.equal(readFileSync(source2, "utf8"), original);
    const capFile = join(dir2, "cap.md");
    writeFileSync(capFile, "上限", "utf8");
    assert.equal(
      reopened.selectWikiSource({
        sourceId: "src-cap",
        pageId: "page-cap",
        actorId: "employee-a",
        filePath: capFile,
        maintenance: false,
      }).ok,
      true,
    );
    let revision = 1;
    while (revision < WIKI_REVISION_CAP) {
      const next = reopened.reviseWiki({
        pageId: "page-cap",
        actorId: "employee-a",
        body: `修订${revision + 1}`,
        origin: "human",
        baseRevision: revision,
      });
      assert.equal(next.ok, true);
      if (!next.ok) {
        break;
      }
      revision = next.revision;
    }
    const capped = reopened.reviseWiki({
      pageId: "page-cap",
      actorId: "employee-a",
      body: "超出工程上限",
      origin: "human",
      baseRevision: WIKI_REVISION_CAP,
    });
    assert.equal(capped.ok, false);
    if (!capped.ok) {
      assert.equal(capped.code, "CAP_REACHED");
    }
  } finally {
    reopened.close();
  }
});

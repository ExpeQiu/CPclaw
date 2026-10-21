import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { buildSyntheticReport, parseTaskMode } from "@cpclaw/contracts";
import { openLocalWorkspace } from "@cpclaw/desktop-host/workspace";

const dataDir = process.env.CPCLAW_DATA_DIR;
if (dataDir === undefined || dataDir === "") {
  process.stderr.write("工作区进程缺少 CPCLAW_DATA_DIR\n");
  process.exit(1);
}

const workspace = openLocalWorkspace(dataDir);
const materials = [
  { fileName: "policy-excerpt.md", paragraphs: [{ id: "p1", text: "制度要求保留来源" }] },
  { fileName: "project-note.md", paragraphs: [{ id: "p1", text: "项目记录只覆盖本机材料" }] },
];

function fail(code, message) {
  return { ok: false, code, message };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dispatch(message) {
  const input = isRecord(message.input) ? message.input : {};
  const actorId = message.actorId;
  if (typeof actorId !== "string") {
    return fail("SCHEMA_INVALID", "缺少员工标识");
  }
  switch (message.method) {
    case "snapshot":
      return workspace.readWorkbench(actorId);
    case "createTask":
      return createTask(actorId, input);
    case "enqueue":
      return enqueue(input);
    case "stageReport":
      return stageReport(actorId, input);
    case "decide":
      return decide(input);
    case "selectWiki":
      return selectWiki(actorId, input);
    default:
      return fail("SCHEMA_INVALID", "未知工作台命令");
  }
}

function createTask(actorId, input) {
  const mode = parseTaskMode(input.mode);
  const outputDir = input.outputDir;
  const budgetLimitCalls = input.budgetLimitCalls;
  if (mode === undefined || typeof outputDir !== "string") {
    return fail("SCHEMA_INVALID", "模式或目录不符合形状");
  }
  if (typeof budgetLimitCalls !== "number" || !Number.isInteger(budgetLimitCalls)) {
    return fail("SCHEMA_INVALID", "预算次数不符合限制");
  }
  return workspace.createTask({
    taskId: `task-${randomUUID()}`,
    revisionId: `rev-${randomUUID()}`,
    actorId,
    goal: "生成带来源的报告",
    acceptance: "四节 Markdown，来源指向本地文件",
    mode,
    budgetLimitCalls,
    grants: [{ kind: "directory", path: outputDir, access: "write" }],
  });
}

function enqueue(input) {
  if (typeof input.taskId !== "string" || typeof input.body !== "string") {
    return fail("SCHEMA_INVALID", "补充内容不符合形状");
  }
  return workspace.enqueueInput(input.taskId, input.body);
}

function stageReport(actorId, input) {
  if (typeof input.taskId !== "string" || typeof input.outputDir !== "string") {
    return fail("SCHEMA_INVALID", "暂存命令不符合形状");
  }
  const task = workspace.readTask(input.taskId);
  if (!task.ok) {
    return task;
  }
  const board = workspace.readWorkbench(actorId);
  const current = board.tasks.find((item) => item.taskId === input.taskId);
  let runId = current !== undefined && current.runStatus === "running" ? current.runId : null;
  if (runId === null) {
    const started = workspace.startRun({
      taskId: input.taskId,
      runId: `run-${randomUUID()}`,
      idempotencyKey: `stage-${randomUUID()}`,
      expectedRevisionId: task.revisionId,
    });
    if (!started.ok) {
      return started;
    }
    runId = started.runId;
  }
  const body = buildSyntheticReport({ goal: task.goal, materials });
  return workspace.stageChange({
    changeId: `chg-${randomUUID()}`,
    taskId: input.taskId,
    runId,
    path: `${input.outputDir.replace(/\/$/, "")}/report.md`,
    body,
    materialNames: materials.map((item) => item.fileName),
  });
}

function decide(input) {
  if (typeof input.changeId !== "string" || (input.decision !== "accept" && input.decision !== "reject")) {
    return fail("SCHEMA_INVALID", "审阅命令不符合形状");
  }
  return workspace.decideChange(input.changeId, input.decision);
}

function selectWiki(actorId, input) {
  if (typeof input.filePath !== "string" || typeof input.maintenance !== "boolean") {
    return fail("SCHEMA_INVALID", "笔记来源不符合形状");
  }
  const id = randomUUID();
  return workspace.selectWikiSource({
    sourceId: `src-${id}`,
    pageId: `page-${id}`,
    actorId,
    filePath: input.filePath,
    maintenance: input.maintenance,
  });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "无法解析命令";
    process.stdout.write(`${JSON.stringify({ id: null, result: fail("SCHEMA_INVALID", reason) })}\n`);
    return;
  }
  const id = isRecord(message) ? message.id : null;
  const result = isRecord(message) ? dispatch(message) : fail("SCHEMA_INVALID", "命令不符合形状");
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
});

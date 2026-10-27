import { createChatService } from "./chat-service.mjs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { buildSyntheticReport, checkReport, parseTaskMode } from "@cpclaw/contracts";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { readCurrentAccountSession, runBoundReportLoop, exportDiagnosticPack, runDoctor } from "@cpclaw/desktop-host";
import { sessionRefresher } from "./session-refresh.mjs";
import { openLocalWorkspace } from "@cpclaw/desktop-host/workspace";

const dataDir = process.env.CPCLAW_DATA_DIR;
if (dataDir === undefined || dataDir === "") {
  process.stderr.write("工作区进程缺少 CPCLAW_DATA_DIR\n");
  process.exit(1);
}

if (process.env.CPCLAW_REPORT_MODEL_MODE !== undefined && !["mock", "real"].includes(process.env.CPCLAW_REPORT_MODEL_MODE)) {
  process.stderr.write("CPCLAW_REPORT_MODEL_MODE 只接受 mock 或 real\n");
  process.exit(1);
}
const servicePending=new Map();
function executeService(request,signal){
  signal.throwIfAborted(); const id=randomUUID();
  return new Promise((resolve,reject)=>{
    const abort=()=>{servicePending.delete(id);process.stdout.write(JSON.stringify({serviceCancel:id})+'\n');reject(Error('服务操作已取消'));};
    servicePending.set(id,result=>{signal.removeEventListener('abort',abort);resolve(result);});
    signal.addEventListener('abort',abort,{once:true});
    process.stdout.write(JSON.stringify({serviceRequest:{id,...request}})+'\n');
  });
}
const chat = createChatService(dataDir, event => process.stdout.write(JSON.stringify({ event }) + "\n"),{executeService});
const workspace = openLocalWorkspace(dataDir);
const activeReports = new Map();
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
  if (message.method?.startsWith("knowledge.") || message.method?.startsWith("project.") || message.method?.startsWith("chat.") || message.method?.startsWith("account.") || message.method?.startsWith("market.") || message.method?.startsWith("document.")) return chat.dispatch(message.method, actorId, input);
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
    case "cancelReport": {
      const active = activeReports.get(input.taskId);
      if (active?.actorId !== actorId) return fail("NOT_FOUND", "没有该员工的活动报告");
      if (active.attempted) workspace.recordUsage(input.taskId, { kind: "unknown", operationId: active.operationId, runId: active.runId });
      active.controller.abort();
      return workspace.cancelRun(active.runId, "cancel");
    }
    case "stageReport":
      return stageReport(actorId, input);
    case "decide":
      return decide(input);
    case "selectWiki":
      return selectWiki(actorId, input);
    case "doctor.run":
      return doctorRun(input);
    case "doctor.export":
      return doctorExport(input);
    default:
      return fail("SCHEMA_INVALID", "未知工作台命令");
  }
}

function doctorRun(input) {
  const grants = Array.isArray(input.grantedDirectories) ? input.grantedDirectories : [];
  const report = runDoctor({
    dataDir,
    platformReachable: input.platformReachable,
    modelKeyPresent: input.modelKeyPresent,
    grantedDirectories: grants.filter((item) => typeof item === "string"),
    connectorConfigured: input.connectorConfigured,
    imPaired: input.imPaired,
  });
  return { ok: true, report };
}

function doctorExport(input) {
  if (typeof input.report !== "object" || input.report === null) {
    return fail("SCHEMA_INVALID", "诊断报告不符合形状");
  }
  return exportDiagnosticPack(dataDir, input.report, {
    includeExtra: input.includeExtra === true,
    extraScopes: Array.isArray(input.extraScopes) ? input.extraScopes : [],
  });
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

async function stageReport(actorId, input) {
  if (typeof input.taskId !== "string" || typeof input.outputDir !== "string") {
    return fail("SCHEMA_INVALID", "暂存命令不符合形状");
  }
  const task = workspace.readTask(input.taskId);
  if (!task.ok) {
    return task;
  }
  const board = workspace.readWorkbench(actorId);
  const current = board.tasks.find((item) => item.taskId === input.taskId);
  if (current === undefined) return fail("FORBIDDEN", "任务不属于当前员工");
  if (activeReports.has(input.taskId)) return fail("SLOT_BUSY", "报告正在生成");
  if (task.mode !== "execute") return fail("MODE_READONLY", "问答和规划模式不能生成文件变更");
  const target = workspace.checkWriteTarget(input.taskId, `${input.outputDir.replace(/\/$/, "")}/report.md`);
  if (!target.ok) return target;
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
  let body;
  if (process.env.CPCLAW_REPORT_MODEL_MODE === "real") {
    const controller = new AbortController();
    const active = { actorId, controller, runId, attempted: false, operationId: `usage-${randomUUID()}` };
    activeReports.set(input.taskId, active);
    let attempted = false;
    try {
      if (typeof input.materialPath !== "string" || input.materialPath === "") throw new Error("请选择要送入模型的材料文件");
      const { lstatSync } = await import("node:fs");
      const info = lstatSync(input.materialPath);
      if (!info.isFile() || info.size > 8000) throw new Error("材料必须是 8 KB 以内的普通文本文件");
      const text = readFileSync(input.materialPath, "utf8");
      const fileName = basename(input.materialPath);
      if (!/^[\w.\-\u4e00-\u9fff]{1,100}$/.test(fileName) || !text.trim()) throw new Error("材料文件名或正文不符合限制");
      const paragraphs = text.split(/\r?\n/).filter(line => line.trim()).map((text, i) => ({ id: `p${i+1}`, text }));
      if (paragraphs.length > 64 || paragraphs.some(p => p.text.length > 4000)) throw new Error("材料段落超过限制");
      const session = readCurrentAccountSession(dataDir);
      if (!session.ok || session.session?.employeeId !== actorId) throw new Error("当前员工未登录");
      const base = process.env.CPCLAW_PLATFORM_URL;
      if (!base) throw new Error("缺少 CPCLAW_PLATFORM_URL");
      const post = async (path, payload, accessToken) => {
        const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
          method: "POST", headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
          body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(70_000)]),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message ?? "平台请求失败");
        return result;
      };
      // 与聊天、技能市场共用同一续期单例，避免并发续期互相作废刷新令牌。
      const refreshed = await sessionRefresher(dataDir).refresh();
      if (!refreshed.ok) throw new Error(refreshed.message);
      if (refreshed.employeeId !== actorId) throw new Error("平台会话员工不匹配");
      if (process.env.CPCLAW_REPORT_ENGINE === "harness") {
        const generated = await runBoundReportLoop({
          homeParent: dataDir, platformBase: base, accessToken: refreshed.accessToken, materials: [{ fileName, paragraphs }], goal: task.goal, signal: controller.signal,
          beforeCall: () => {
            const charged = workspace.recordUsage(input.taskId, { kind: "known", calls: 1, runId });
            if (!charged.ok) throw new Error(charged.message);
            attempted = true; active.attempted = true; active.operationId = `usage-${randomUUID()}`;
          },
          unknownUsage: () => workspace.recordUsage(input.taskId, { kind: "unknown", operationId: active.operationId, runId }),
        });
        attempted = false; active.attempted = false;
        if (controller.signal.aborted || !checkReport(generated.finalResponse, [fileName]).ok || !paragraphs.every(p => generated.finalResponse.includes(`${fileName}#${p.id}`))) throw new Error("Harness 报告未完成或来源检查失败");
        return { ...workspace.stageChange({ changeId: `chg-${randomUUID()}`, taskId: input.taskId, runId, path: `${input.outputDir.replace(/\/$/, "")}/report.md`, body: generated.finalResponse, materialNames: [fileName] }), harness: { toolCalls: generated.toolCalls, modelCalls: generated.modelCalls, childCommandSeenAfterClose: generated.childCommandSeenAfterClose } };
      }
      const charged = workspace.recordUsage(input.taskId, { kind: "known", calls: 1, runId });
      if (!charged.ok) throw new Error(charged.message);
      attempted = true;
      active.attempted = true;
      const generated = await post("/v1/reports/generate", { requestId: `report-${randomUUID()}`, goal: task.goal, materials: [{ fileName, paragraphs }] }, refreshed.accessToken);
      if (controller.signal.aborted) throw new Error("报告已取消");
      if (generated.usage?.state !== "known") workspace.recordUsage(input.taskId, { kind: "unknown", operationId: `usage-${randomUUID()}`, runId });
      const currentSession = readCurrentAccountSession(dataDir);
      if (!currentSession.ok || currentSession.session?.employeeId !== actorId) throw new Error("账号已切换，报告不进入待审区");
      body = generated.text;
      // 以下公共暂存路径仍由工作区授权检查守护。
      const staged = workspace.stageChange({ changeId: `chg-${randomUUID()}`, taskId: input.taskId, runId, path: `${input.outputDir.replace(/\/$/, "")}/report.md`, body, materialNames: [fileName] });
      return staged;
    } catch (error) {
      if (attempted && !controller.signal.aborted && process.env.CPCLAW_REPORT_ENGINE !== "harness") workspace.recordUsage(input.taskId, { kind: "unknown", operationId: `usage-${randomUUID()}`, runId });
      workspace.cancelRun(runId, "cancel");
      return fail(controller.signal.aborted ? "CANCELLED" : "MODEL_FAILED", controller.signal.aborted ? "报告已取消，未创建待审变更" : (error instanceof Error ? error.message : "模型调用失败"));
    } finally { activeReports.delete(input.taskId); }
  }
  body = buildSyntheticReport({ goal: task.goal, materials });
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
lines.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "无法解析命令";
    process.stdout.write(`${JSON.stringify({ id: null, result: fail("SCHEMA_INVALID", reason) })}\n`);
    return;
  }
  if(message?.serviceResult){servicePending.get(message.serviceResult.id)?.(message.serviceResult.result);servicePending.delete(message.serviceResult.id);return;}
  const id = isRecord(message) ? message.id : null;
  let result;
  try { result = isRecord(message) ? await dispatch(message) : fail("SCHEMA_INVALID", "命令不符合形状"); }
  catch { result = fail("INTERNAL_ERROR", "工作区命令执行失败"); }
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
});

lines.on("close", () => { chat.stop(); process.exit(0); });

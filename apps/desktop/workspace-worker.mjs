import {desktopLog} from './desktop-log.mjs';
import {errorMetadata} from '@cpclaw/model-gateway';
import {createDiagnosticCenter} from './diagnostic-center.mjs';
import { createChatService } from "./chat-service.mjs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { parseTaskMode } from "@cpclaw/contracts";
import { readFileSync } from "node:fs";
import { exportDiagnosticPack, runDoctor } from "@cpclaw/desktop-host";
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
const diagnosticCenter=createDiagnosticCenter({dataDir,chat,appVersion:JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version});
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

let maintenance=false;
function dispatch(message) {
  const input = isRecord(message.input) ? message.input : {};
  const actorId = message.actorId;
  if(maintenance&&!message.method?.startsWith("doctor.")&&message.method!=="chat.history")return fail("SLOT_BUSY","运行环境正在修复，请稍后再试。");
  if (message.method?.startsWith("extensions.") || message.method?.startsWith("knowledge.") || message.method?.startsWith("project.") || message.method?.startsWith("chat.") || message.method?.startsWith("account.") || message.method?.startsWith("market.") || message.method?.startsWith("document.") || message.method?.startsWith("learning.") || message.method === "formal.tracks") return chat.dispatch(message.method, actorId, input);
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
    case "doctor.preflight":
      { const busy=Boolean(activeReports.size||chat.isBusy());if(!busy&&input.reserve===true)maintenance=true;return {ok:true,busy}; }
    case "doctor.center":
      return diagnosticCenter.dispatch(input.action,actorId,input);
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
    firstCli: process.env.CPCLAW_FIRST_CLI,
    firstMcp: process.env.CPCLAW_FIRST_MCP,
    imPaired: input.imPaired,
    imCallbackVerified: process.env.CPCLAW_IM_CALLBACK_VERIFIED === "1",
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

async function stageReport(_actorId,_input){return fail('LEGACY_TASK_READONLY','早期报告链路已退役，请在聊天中通过统一内核创建新任务；原记录和待审变更仍可查看。');}

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
  let result, failureDetails={};const rpcStarted=Date.now();
  try { result = isRecord(message) ? await dispatch(message) : fail("SCHEMA_INVALID", "命令不符合形状"); }
  catch(error) {failureDetails=errorMetadata(error);result = fail("INTERNAL_ERROR", "工作区命令执行失败"); }
  if(result?.ok===false){
    const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,64}$/.test(v)?v:'';
    desktopLog(dataDir,'cpclaw-desktop-worker','error','rpc_request_failed','工作区请求失败',{method:safeId(message?.method),requestId:safeId(message?.input?.requestId),chatId:safeId(message?.input?.chatId),code:safeId(result.code),durationMs:Date.now()-rpcStarted,...failureDetails});
  }
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
});

lines.on("close", () => { chat.stop(); process.exit(0); });

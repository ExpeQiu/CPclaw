import { registerExtensionHost } from './extension-host.mjs';
import { performKnowledgeAction } from './knowledge-actions.mjs';
import { performProjectAction } from './project-actions.mjs';
import { performDocumentAction } from "./document-actions.mjs";
import {
  applyDesktopSettingsToProcessEnv,
  getDesktopSettingsView,
  probePlatformConnection,
  saveDesktopSettings,
  syncDesktopSettingsFromEnv,
} from "./desktop-settings.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
// Electron 主进程不得加载 desktop-host 桶导出（会拉进 node:sqlite）。
// 无库模块用子路径；诊断与工作台走系统 Node 的 workspace-worker。
import { acceptTask } from "@cpclaw/desktop-host/accept-task";
import { readCurrentAccountSession } from "@cpclaw/desktop-host/account-session";
import { createWorkspaceClient, resolveKernelStatus } from "./workspace-client.mjs";
import { desktopLog } from "./desktop-log.mjs";

const here = dirname(fileURLToPath(import.meta.url));
app.setName("CPclaw");
const dataDir = process.env.CPCLAW_DATA_DIR || join(app.getPath("appData"), "CPclaw");
mkdirSync(dataDir, { recursive: true });
if (app.isPackaged) {
  process.env.CPCLAW_NODE_BINARY = join(process.resourcesPath, "runtime", "bin", "node");
}
process.env.CPCLAW_DATA_DIR = dataDir;
app.setPath("userData", dataDir);
applyDesktopSettingsToProcessEnv(dataDir, here);
if (!app.requestSingleInstanceLock()) app.exit(0);

function appVersion() {
  try {
    return JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version || app.getVersion();
  } catch {
    return app.getVersion();
  }
}

function restartWorkspace(reason) {
  process.stderr.write(`${JSON.stringify({ level: "info", event: "workspace_restart", reason })}\n`);
  workspaceClient.stop();
}

let mainWindow = null;
const extensionHost = registerExtensionHost({ dataDir, ipcMain, getWindow: () => mainWindow, getActor: currentActor });
const workspaceClient = createWorkspaceClient(dataDir, here, { onService: (request,signal) => extensionHost.executeService(request,signal), onEvent(event) {
  if (event.actorId === currentActor() && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("chat.event", event);
} });

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
});
app.on("activate", () => {
  if (app.isReady() && (!mainWindow || mainWindow.isDestroyed())) void createWindow().catch(error => process.stderr.write(`${error.message}\n`));
});

function currentActor() {
  const current = readCurrentAccountSession(dataDir);
  if (!current.ok || current.session === null) {
    return null;
  }
  return current.session.employeeId;
}

ipcMain.handle("tasks.accept", (_event, command) => {
  return acceptTask(dataDir, command, { runId: `run-${randomUUID()}` });
});

ipcMain.handle("runtime.status", () => {
  const status = resolveKernelStatus(here);
  desktopLog(dataDir, "cpclaw-desktop-host", "info", "kernel_status", status.ready ? "内核可用" : "内核不可用", {
    ready: Boolean(status.ready),
    source: String(status.source || "none").slice(0, 32),
  });
  return status;
});

ipcMain.handle("ui.log", (_event, input) => {
  const level = ["debug", "info", "warn", "error"].includes(input?.level) ? input.level : "info";
  const event = typeof input?.event === "string" && /^[a-z0-9_]{1,64}$/.test(input.event) ? input.event : "ui_event";
  const message = typeof input?.message === "string" && input.message ? input.message.slice(0, 500) : "renderer event";
  const fields = {};
  if (typeof input?.chatId === "string" && input.chatId) fields.chatId = input.chatId.slice(0, 64);
  desktopLog(dataDir, "cpclaw-desktop-ui", level, event, message, Object.keys(fields).length ? fields : undefined);
  return { ok: true };
});

ipcMain.handle("settings.get", () => getDesktopSettingsView(dataDir, here, { appVersion: appVersion() }));

ipcMain.handle("settings.save", (_event, input) => {
  const result = saveDesktopSettings(dataDir, here, { ...input, appVersion: appVersion() });
  if (result.ok) restartWorkspace("settings_saved");
  return result;
});

ipcMain.handle("settings.syncEnv", () => {
  const result = syncDesktopSettingsFromEnv(dataDir, here, { appVersion: appVersion() });
  if (result.ok) restartWorkspace("settings_sync_env");
  return result;
});

ipcMain.handle("settings.probePlatform", (_event, input) => {
  const url = typeof input?.platformUrl === "string" ? input.platformUrl : "";
  return probePlatformConnection(url);
});

ipcMain.handle("settings.pickHarnessRoot", async () => {
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: "选择 deepseek-harness 目录",
    properties: ["openDirectory"],
  });
  if (choice.canceled || !choice.filePaths[0]) return { ok: true, cancelled: true };
  return { ok: true, path: choice.filePaths[0] };
});

ipcMain.handle("workspace.call", async (_event, call) => {
  const actorId = currentActor();
  if (typeof call !== "object" || call === null || typeof call.method !== "string") {
    return { ok: false, code: "SCHEMA_INVALID", message: "命令不符合形状" };
  }
  if (actorId === null && !["account.status", "account.login", "account.logout"].includes(call.method)) return { ok: false, code: "AUTH_REQUIRED", message: "请先在设置中登录平台" };
  if (['account.login', 'account.logout'].includes(call.method)) extensionHost.clearContext();
  if (['chat.history', 'chat.send'].includes(call.method)) extensionHost.setContext(actorId, call.input?.chatId ?? '');
  const result = await workspaceClient.request({ method: call.method, input: call.input, actorId });
  if (call.method === 'market.probe' && result.code === 'LOCAL_EXECUTION_REQUIRED') return extensionHost.probeConnector(result.localExecution, actorId);
  if (call.method === 'chat.create' && result.ok) extensionHost.setContext(actorId, result.chatId);
  if (call.method === 'chat.history' && !result.ok) extensionHost.clearContext();
  return result;
});

ipcMain.handle("document.action", (_event, input) => performDocumentAction({
  input, actor: currentActor(), request: call => workspaceClient.request(call),
  isCurrent: actor => currentActor() === actor, dialog, shell, parent: mainWindow,
}));

ipcMain.handle('project.action',(_event,input)=>{
  const actor=currentActor();
  return performProjectAction({input,actor,request:call=>workspaceClient.request({...call,actorId:actor}),isCurrent:id=>currentActor()===id,dialog,shell,parent:mainWindow});
});

ipcMain.handle('knowledge.action', (_event,input) => {
 const actor=currentActor();
 return performKnowledgeAction({input,actor,request:call=>workspaceClient.request({...call,actorId:actor}),isCurrent:id=>currentActor()===id,dialog,shell,parent:mainWindow});
});

ipcMain.handle("doctor.run", (_event, input) => {
  const grants = Array.isArray(input?.grantedDirectories) ? input.grantedDirectories : [];
  return workspaceClient.request({
    method: "doctor.run",
    actorId: currentActor() ?? "local-doctor",
    input: {
      platformReachable: input?.platformReachable,
      modelKeyPresent: input?.modelKeyPresent,
      grantedDirectories: grants.filter((item) => typeof item === "string"),
      connectorConfigured: input?.connectorConfigured,
      imPaired: input?.imPaired,
    },
  });
});

ipcMain.handle("doctor.export", (_event, payload) => {
  if (typeof payload !== "object" || payload === null || typeof payload.report !== "object") {
    return { ok: false, code: "SCHEMA_INVALID", message: "诊断报告不符合形状" };
  }
  return workspaceClient.request({
    method: "doctor.export",
    actorId: currentActor() ?? "local-doctor",
    input: {
      report: payload.report,
      includeExtra: payload.includeExtra === true,
      extraScopes: Array.isArray(payload.extraScopes) ? payload.extraScopes : [],
    },
  });
});

async function createWindow() {
  const verifyClicks = process.argv.includes("--verify-clicks");
  const verifyPackage = process.argv.includes("--verify-package");
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: !verifyClicks && !verifyPackage,
    title: "CPclaw",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) extensionHost.clearContext(); });
  window.once("closed", () => extensionHost.clearContext());
  await window.loadFile(join(here, "renderer", "index.html"));
  if (verifyPackage) {
    const result = await workspaceClient.request({ method: "doctor.run", actorId: "package-check", input: {} });
    if (!result.ok) throw new Error(result.message);
    const ui = await window.webContents.executeJavaScript(`({ title: document.title, tasks: Boolean(document.getElementById("tasks")), bridge: typeof window.cpclaw.workspace === "function" })`);
    const ok = ui.tasks && ui.bridge;
    process.stdout.write(`${JSON.stringify({ packaged: app.isPackaged, worker: result.ok, ui, dataDir })}\n`);
    app.exit(ok ? 0 : 1);
    return;
  }
  if (!verifyClicks) {
    return;
  }
  const outcome = await window.webContents.executeJavaScript(`
    (async () => {
      const first = await window.cpclaw.acceptTask(window.__command);
      const second = await window.cpclaw.acceptTask({ ...window.__command, requestId: "req-click-2" });
      return { first, second };
    })()
  `);
  const sameRun = outcome.first.ok === true && outcome.second.ok === true && outcome.first.receipt.runId === outcome.second.receipt.runId;
  process.stdout.write(`${JSON.stringify({ sameRun, runId: outcome.second.receipt?.runId ?? null })}\n`);
  app.exit(sameRun ? 0 : 1);
}

app.on("before-quit", () => {
  workspaceClient.stop();
});

app.whenReady().then(createWindow).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "桌面启动失败"}\n`);
  process.exit(1);
});

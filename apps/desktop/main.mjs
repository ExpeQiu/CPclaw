import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
// Electron 主进程不得加载 desktop-host 桶导出（会拉进 node:sqlite）。
// 无库模块用子路径；诊断与工作台走系统 Node 的 workspace-worker。
import { acceptTask } from "@cpclaw/desktop-host/accept-task";
import { readCurrentAccountSession } from "@cpclaw/desktop-host/account-session";
import { createWorkspaceClient } from "./workspace-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.CPCLAW_DATA_DIR;
if (dataDir === undefined || dataDir === "") {
  process.stderr.write("桌面宿主缺少 CPCLAW_DATA_DIR\n");
  process.exit(1);
}

const workspaceClient = createWorkspaceClient(dataDir, here);

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

ipcMain.handle("workspace.call", (_event, call) => {
  const actorId = currentActor();
  if (actorId === null) {
    return { ok: false, code: "AUTH_REQUIRED", message: "未登录" };
  }
  if (typeof call !== "object" || call === null || typeof call.method !== "string") {
    return { ok: false, code: "SCHEMA_INVALID", message: "命令不符合形状" };
  }
  return workspaceClient.request({ method: call.method, input: call.input, actorId });
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
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: !verifyClicks,
    title: "CPclaw",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(join(here, "renderer", "index.html"));
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

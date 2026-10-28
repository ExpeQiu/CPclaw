import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** 解析当前推理内核（Harness）名称与是否可用，供标题栏状态显示。 */
export function resolveKernelStatus(desktopDir, env = process.env) {
  const bundled = resolve(desktopDir, "../harness");
  const bundleManifest = join(bundled, "manifest.json");
  if (existsSync(bundleManifest)) {
    let version = "";
    try { version = JSON.parse(readFileSync(bundleManifest, "utf8")).version || ""; } catch { /* 清单损坏仍标可用，路径存在即可 */ }
    return { ok: true, name: "deepseek-harness", ready: true, source: "bundle", version };
  }
  if (env.CPCLAW_REPORT_ENGINE === "harness") {
    const root = env.CPCLAW_HARNESS_ROOT || resolve(desktopDir, "../../../../13 Github/deepseek-harness");
    const ready = existsSync(join(root, "package.json"));
    let version = "";
    if (ready) {
      try { version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || ""; } catch { /* ignore */ }
    }
    return { ok: true, name: basename(root) || "deepseek-harness", ready, source: "checkout", version };
  }
  return { ok: true, name: "未配置", ready: false, source: "none", version: "" };
}

export function createWorkspaceClient(dataDir, desktopDir, { onEvent = () => {}, onService = async () => ({ok:false,message:"本机服务执行未接入"}) } = {}) {
  let child = null;
  let seq = 0;
  const pending = new Map();
  const serviceCalls = new Map();

  function failAll(message) {
    for (const wait of pending.values()) {
      wait({ ok: false, code: "DEPENDENCY_UNAVAILABLE", message });
    }
    pending.clear();
    for (const c of serviceCalls.values()) c.abort(); serviceCalls.clear();
  }

  function ensure() {
    if (child !== null) {
      return child;
    }
    // 使用独立 Node（含 node:sqlite）；安装包提供内置运行时，开发模式使用 PATH。
    const workerEnv = { ...process.env, CPCLAW_DATA_DIR: dataDir };
    delete workerEnv.MINIMAX_API_KEY;
    delete workerEnv.MINIMAX_CODING_API_KEY;
    const nodeArgs = [];
    const bundledHarness = resolve(desktopDir, "../harness");
    if (existsSync(join(bundledHarness, "manifest.json"))) {
      workerEnv.CPCLAW_HARNESS_BUNDLE = bundledHarness;
      delete workerEnv.CPCLAW_HARNESS_ROOT;
      delete workerEnv.TSX_TSCONFIG_PATH;
    } else if (workerEnv.CPCLAW_REPORT_ENGINE === "harness") {
      const harnessRoot = workerEnv.CPCLAW_HARNESS_ROOT || resolve(desktopDir, "../../../../13 Github/deepseek-harness");
      workerEnv.CPCLAW_HARNESS_ROOT = harnessRoot;
      workerEnv.TSX_TSCONFIG_PATH = join(harnessRoot, "tsconfig.base.json");
      nodeArgs.push("--import", "tsx");
    }
    const next = spawn(process.env.CPCLAW_NODE_BINARY || "node", [...nodeArgs, join(desktopDir, "workspace-worker.mjs")], {
      cwd: desktopDir,
      env: workerEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = next;
    const lines = createInterface({ input: next.stdout });
    lines.on("line", (line) => {
      if(child!==next)return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "工作区返回无法解析";
        process.stderr.write(`${JSON.stringify({ level: "error", event: "workspace_reply_invalid", message: reason })}\n`);
        return;
      }
      if (message.serviceCancel) { serviceCalls.get(message.serviceCancel)?.abort(); return; }
      if (message.serviceRequest) {
        const request=message.serviceRequest, controller=new AbortController(); serviceCalls.set(request.id,controller);
        void Promise.resolve().then(()=>onService(request,controller.signal)).catch(()=>({ok:false,message:"服务调用未完成，请检查操作记录后恢复。"})).then(result=>{
          serviceCalls.delete(request.id); if(child===next&&!next.stdin.destroyed)next.stdin.write(JSON.stringify({serviceResult:{id:request.id,result}})+"\n");
        }); return;
      }
      if (message.event) { onEvent(message.event); return; }
      const wait = pending.get(message.id);
      if (wait === undefined) {
        return;
      }
      pending.delete(message.id);
      wait(message.result);
    });
    next.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    next.on("exit", (code) => {
      if(child!==next)return;
      child = null;
      failAll(`工作区进程已退出，code=${code ?? "null"}`);
    });
    next.on("error", (error) => {
      if(child!==next)return;
      child = null;
      failAll(error.message);
    });
    return next;
  }

  return {
    request(call) {
      const current = ensure();
      const id = seq + 1;
      seq = id;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        current.stdin.write(`${JSON.stringify({ id, ...call })}\n`, (error) => {
          if (error === null || error === undefined) {
            return;
          }
          pending.delete(id);
          resolve({ ok: false, code: "DEPENDENCY_UNAVAILABLE", message: error.message });
        });
      });
    },
    stop() {
      if (child === null) {
        return;
      }
      failAll("工作区已停止");
      child.kill();
      child = null;
    },
  };
}

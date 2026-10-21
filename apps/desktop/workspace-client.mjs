import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

export function createWorkspaceClient(dataDir, desktopDir) {
  let child = null;
  let seq = 0;
  const pending = new Map();

  function failAll(message) {
    for (const wait of pending.values()) {
      wait({ ok: false, code: "DEPENDENCY_UNAVAILABLE", message });
    }
    pending.clear();
  }

  function ensure() {
    if (child !== null) {
      return child;
    }
    const next = spawn("node", [join(desktopDir, "workspace-worker.mjs")], {
      cwd: desktopDir,
      env: { ...process.env, CPCLAW_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = next;
    const lines = createInterface({ input: next.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "工作区返回无法解析";
        process.stderr.write(`${JSON.stringify({ level: "error", event: "workspace_reply_invalid", message: reason })}\n`);
        return;
      }
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
      child = null;
      failAll(`工作区进程已退出，code=${code ?? "null"}`);
    });
    next.on("error", (error) => {
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
      child.kill();
      child = null;
    },
  };
}

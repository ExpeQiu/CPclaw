const command = {
  schemaVersion: 1,
  requestId: "req-click-1",
  idempotencyKey: "desktop-intent-1",
  payload: { taskId: "report-task", expectedTaskRevisionId: "rev-1" },
};

window.__command = command;
let board = null;
let activeTaskId = "";
let desktopView = "chat";

onAction("send", async () => {
  const status = document.getElementById("status");
  const result = await window.cpclaw.acceptTask({
    ...window.__command,
    requestId: `req-${Date.now()}`,
  });
  if (!result.ok) {
    status.textContent = result.message;
    return;
  }
  status.textContent = result.receipt.replayed
    ? `已受理，未创建新任务\nrunId=${result.receipt.runId}`
    : `已排队\nrunId=${result.receipt.runId}`;
});

function selectedTaskId() {
  if (board === null || !Array.isArray(board.tasks) || board.tasks.length === 0) {
    return "";
  }
  return activeTaskId;
}

function renderBoard(result) {
  const tasks = document.getElementById("tasks");
  const changes = document.getElementById("changes");
  if (!result.ok) {
    tasks.textContent = result.message;
    return;
  }
  board = result;
  if (!result.tasks.some((task) => task.taskId === activeTaskId)) {
    activeTaskId = result.tasks.at(-1)?.taskId ?? "";
  }
  renderTasks();
  renderCurrentTask();
  const pendingCount = result.changes.filter((change) => change.status === "pending").length;
  document.getElementById("change-count").textContent = pendingCount;
  document.getElementById("review-toggle").hidden = !pendingCount && desktopView !== "task";
  changes.replaceChildren();
  if (result.changes.length === 0) {
    changes.textContent = "没有待审变更";
  }
  for (const change of result.changes) {
    const row = document.createElement("div");
    row.textContent = `${change.status} ${change.path}`;
    if (change.status === "pending") {
      const reject = document.createElement("button");
      reject.type = "button";
      reject.textContent = "拒绝";
      reject.addEventListener("click", () => decide(change.changeId, "reject"));
      const accept = document.createElement("button");
      accept.type = "button";
      accept.textContent = "接受";
      accept.addEventListener("click", () => decide(change.changeId, "accept"));
      row.append(reject, accept);
    }
    changes.append(row);
  }
}

async function refresh() {
  const result = await window.cpclaw.workspace({ method: "snapshot", input: {} });
  renderBoard(result);
}

async function decide(changeId, decision) {
  const result = await window.cpclaw.workspace({ method: "decide", input: { changeId, decision } });
  if (!result.ok) {
    document.getElementById("status").textContent = result.message;
  }
  await refresh();
}

onAction("enqueue", async () => {
  if (!selectedTaskId()) { setStatus("请先创建或选择任务。"); openPanel("settings"); return; }
  if (!document.getElementById("note").value.trim()) { setStatus("请填写补充内容。"); return; }
  const result = await window.cpclaw.workspace({
    method: "enqueue",
    input: { taskId: selectedTaskId(), body: document.getElementById("note").value },
  });
  if (!result.ok) {
    document.getElementById("status").textContent = result.message;
  }
  if (result.ok) { document.getElementById("note").value = ""; setStatus("已加入当前任务队列。"); }
  await refresh();
});

onAction("stage", async () => {
  setStatus("正在生成报告，请稍候…");
  const result = await window.cpclaw.workspace({
    method: "stageReport",
    input: { taskId: selectedTaskId(), outputDir: document.getElementById("output").value, materialPath: document.getElementById("material-path").value },
  });
  if (!result.ok) {
    document.getElementById("status").textContent = result.message;
  }
  if (result.ok) { setStatus("报告已暂存，请在审阅面板确认变更。"); openPanel("review"); }
  await refresh();
});

onAction("cancel-report", async () => {
  const result = await window.cpclaw.workspace({ method: "cancelReport", input: { taskId: selectedTaskId() } });
  document.getElementById("status").textContent = result.ok ? "生成已取消" : result.message;
  await refresh();
});

let lastDoctorReport = null;

onAction("doctor", async () => {
  const output = document.getElementById("output").value;
  const result = await window.cpclaw.runDoctor({
    grantedDirectories: output ? [output] : [],
  });
  const out = document.getElementById("doctor-out");
  if (!result.ok) {
    out.textContent = result.message;
    return;
  }
  lastDoctorReport = result.report;
  out.textContent = result.report.checks
    .map((item) => `${item.id}\t${item.status}\t${item.summary}`)
    .join("\n");
});

onAction("doctor-export", async () => {
  const out = document.getElementById("doctor-out");
  if (lastDoctorReport === null) {
    out.textContent = "请先运行诊断";
    return;
  }
  const includeExtra = document.getElementById("diag-extra").checked;
  const result = await window.cpclaw.exportDiagnostic({
    report: lastDoctorReport,
    includeExtra,
    extraScopes: includeExtra ? ["sync_meta"] : [],
  });
  if (!result.ok) {
    out.textContent = result.message;
    return;
  }
  out.textContent = `已导出 ${result.fileName}（${result.bytes} 字节）\n` + out.textContent;
});

function onAction(id, action) {
  const button = document.getElementById(id);
  button.addEventListener("click", async () => {
    if (button.dataset.busy) return;
    button.dataset.busy = "true";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try { await action(); }
    catch (error) { setStatus(error instanceof Error ? error.message : "操作失败，请重试。"); }
    finally {
      delete button.dataset.busy;
      button.removeAttribute("aria-busy");
      button.disabled = ["enqueue", "stage", "cancel-report"].includes(id) && !selectedTaskId();
    }
  });
}

function setStatus(message) { document.getElementById("status").textContent = message; }

function openPanel(name) {
  if(name === "sources" && typeof loadKnowledge === "function")void loadKnowledge().catch(error=>setStatus(error.message));
  if(name==="documents" && typeof documentStructureTab!=="undefined" && documentStructureTab==="folders")void renderProjectFolder();
  if(name!=="documents" && typeof dismissDocumentWorkspace==="function")dismissDocumentWorkspace();
  document.getElementById("inspector").hidden = false;
  for (const panel of ["settings", "sources", "review", "documents", "extensions"]) {
    document.getElementById(`panel-${panel}`).hidden = panel !== name;
  }
  document.getElementById("panel-title").textContent = { extensions: "即梦 · 操作面板", settings: "设置", sources: "知识库", review: "审阅成果", documents: "文档与预览" }[name];
}

function renderTasks() {
  const list = document.getElementById("tasks");
  list.replaceChildren();
  const query = document.getElementById("task-search").value.trim().toLowerCase();
  const tasks = (board?.tasks ?? []).filter((task) => `${task.goal} ${task.taskId}`.toLowerCase().includes(query));
  for (const task of [...tasks].reverse()) {
    const button = document.createElement("button");
    button.className = `task-row${desktopView === "task" && task.taskId === activeTaskId ? " active" : ""}`;
    button.setAttribute("aria-current", task.taskId === activeTaskId ? "true" : "false");
    const title = document.createElement("strong");
    title.textContent = task.goal;
    const meta = document.createElement("small");
    meta.textContent = `${task.runStatus ?? "未启动"} · ${task.taskId.slice(-6)}`;
    button.title = `${task.goal}\n${task.taskId}`;
    button.append(title, meta);
    button.addEventListener("click", () => { void window.cpclaw.extensionAction?.({ action: "clear-context" }).catch(() => {}); desktopView = "task"; activeTaskId = task.taskId; renderTasks(); renderCurrentTask(); });
    list.append(button);
  }
  document.getElementById("legacy-history").hidden = !tasks.length;
}

function renderCurrentTask() {
  document.getElementById("review-toggle").hidden = desktopView !== "task" && !(board?.changes ?? []).some(change => change.status === "pending");
  if (desktopView !== "task") return;
  if (typeof renderComposer === "function") { renderComposer(); renderChatList(); }
  document.getElementById("chat-view").hidden = true;
  if (typeof clearDocumentView === "function") clearDocumentView();
  const task = board?.tasks.find((item) => item.taskId === activeTaskId);
  document.getElementById("welcome").hidden = Boolean(task);
  document.getElementById("task-detail").hidden = !task;
  document.getElementById("task-title").textContent = task?.goal ?? "新任务";
  document.getElementById("task-state").textContent = task?.runStatus ?? "准备就绪";
  document.getElementById("enqueue").disabled = !task;
  document.getElementById("stage").disabled = !task;
  document.getElementById("cancel-report").disabled = !task;
  if (!task) return;
  document.getElementById("detail-title").textContent = task.goal;
  document.getElementById("task-meta").textContent = `${{ ask: "问答", plan: "规划", execute: "执行" }[task.mode] ?? task.mode} · 模型调用 ${task.spentCalls} / ${task.budgetLimitCalls} · 用量待确认 ${task.unknownUsageCount}`;
  const queue = document.getElementById("queue");
  queue.replaceChildren();
  for (const input of task.inputs) {
    const item = document.createElement("div");
    item.className = "input-item";
    item.textContent = input.body;
    const meta = document.createElement("small");
    meta.textContent = input.consumed ? "已读取" : "等待处理";
    item.append(meta);
    queue.append(item);
  }
  if (!task.inputs.length) queue.textContent = "还没有补充输入，可以在下方添加任务要求。";
}

document.querySelectorAll("[data-panel]").forEach((button) => button.addEventListener("click", () => openPanel(button.dataset.panel)));
document.getElementById("close-panel").addEventListener("click", () => { document.getElementById("inspector").hidden = true; if(typeof dismissDocumentWorkspace==="function")dismissDocumentWorkspace(); document.body.classList.remove("document-expanded"); const expand=document.getElementById("document-expand");if(expand)expand.textContent="展开 ↗"; });
document.getElementById("task-search").addEventListener("input", renderTasks);
document.getElementById("refresh").addEventListener("click", () => refresh());
document.querySelectorAll("[data-suggest]").forEach((button) => button.addEventListener("click", () => {
  document.getElementById("note").value = button.dataset.suggest;
  document.getElementById("note").focus();
  if (desktopView === "task" && !activeTaskId) openPanel("settings");
}));
document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === "n") { event.preventDefault(); document.getElementById("rail-chat").click(); }
  if (event.key === "Enter" && document.activeElement === document.getElementById("note")) { event.preventDefault(); document.getElementById(desktopView === "chat" ? "chat-send" : "enqueue").click(); }
});

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  setStatus(event.reason instanceof Error ? event.reason.message : "操作失败，请重试。");
});
refresh().catch((error) => {
  setStatus(error instanceof Error ? error.message : "工作台无法加载");
  document.getElementById("tasks").textContent = "工作台无法加载，点击刷新重试。";
});

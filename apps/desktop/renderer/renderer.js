const command = {
  schemaVersion: 1,
  requestId: "req-click-1",
  idempotencyKey: "desktop-intent-1",
  payload: { taskId: "report-task", expectedTaskRevisionId: "rev-1" },
};

window.__command = command;
let board = null;

document.getElementById("send").addEventListener("click", async () => {
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
  return board.tasks[board.tasks.length - 1].taskId;
}

function renderBoard(result) {
  const tasks = document.getElementById("tasks");
  const queue = document.getElementById("queue");
  const changes = document.getElementById("changes");
  const wikiList = document.getElementById("wiki-list");
  if (!result.ok) {
    tasks.textContent = result.message;
    return;
  }
  board = result;
  tasks.textContent = result.tasks.length === 0
    ? "还没有任务"
    : result.tasks
        .map((task) => `${task.goal}\n${task.mode} 预算 ${task.spentCalls}/${task.budgetLimitCalls} 未知 ${task.unknownUsageCount}\n${task.runStatus ?? "未启动"}`)
        .join("\n\n");
  const inputs = result.tasks.flatMap((task) => task.inputs.map((item) => `${item.seq}. ${item.body}${item.consumed ? "（已取）" : ""}`));
  queue.textContent = inputs.join("\n");
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
  wikiList.textContent = result.wiki.map((page) => `r${page.revision} ${page.excerpt}`).join("\n");
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

document.getElementById("create").addEventListener("click", async () => {
  const budget = Number(document.getElementById("budget").value);
  const result = await window.cpclaw.workspace({
    method: "createTask",
    input: {
      mode: document.getElementById("mode").value,
      outputDir: document.getElementById("output").value,
      budgetLimitCalls: budget,
    },
  });
  if (!result.ok) {
    document.getElementById("status").textContent = result.message;
  }
  await refresh();
});

document.getElementById("enqueue").addEventListener("click", async () => {
  const result = await window.cpclaw.workspace({
    method: "enqueue",
    input: { taskId: selectedTaskId(), body: document.getElementById("note").value },
  });
  if (!result.ok) {
    document.getElementById("status").textContent = result.message;
  }
  await refresh();
});

document.getElementById("stage").addEventListener("click", async () => {
  const result = await window.cpclaw.workspace({
    method: "stageReport",
    input: { taskId: selectedTaskId(), outputDir: document.getElementById("output").value },
  });
  if (!result.ok) {
    document.getElementById("status").textContent = result.message;
  }
  await refresh();
});

document.getElementById("wiki").addEventListener("click", async () => {
  const result = await window.cpclaw.workspace({
    method: "selectWiki",
    input: { filePath: document.getElementById("wiki-path").value, maintenance: false },
  });
  if (!result.ok) {
    document.getElementById("status").textContent = result.message;
  }
  await refresh();
});

let lastDoctorReport = null;

document.getElementById("doctor").addEventListener("click", async () => {
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

document.getElementById("doctor-export").addEventListener("click", async () => {
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

refresh().catch((error) => {
  document.getElementById("tasks").textContent = error instanceof Error ? error.message : "工作台无法加载";
});

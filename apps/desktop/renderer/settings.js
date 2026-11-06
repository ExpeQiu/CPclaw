const settingsById = (id) => document.getElementById(id);

function sourceLabel(source) {
  if (source === "settings") return "来源：本机已保存";
  if (source === "env") return "来源：环境变量（尚未保存到本机）";
  return "来源：默认值";
}

function kernelSummary(view) {
  if (!view?.kernel) return "内核状态未知";
  const k = view.kernel;
  const source = k.source === "bundle" ? "包内内核" : k.source === "checkout" ? "本机检出" : "未启用";
  const ready = k.ready ? "可用" : "不可用";
  const version = k.version ? ` · v${k.version}` : "";
  return `${ready} · ${k.name || "未配置"} · ${source}${version}`;
}

function fillSettingsForm(view) {
  if (!view?.ok) {
    settingsById("settings-feedback").textContent = view?.message || "无法读取设置";
    return;
  }
  settingsById("settings-app-version").textContent = view.appVersion || "—";
  settingsById("settings-data-dir").textContent = view.dataDir || "—";
  settingsById("settings-report-mode").value = "real";
  settingsById("settings-mode-source").textContent = "由企业端配置";
  window.renderComposerModel?.("platform");
  settingsById("settings-report-engine").value = "harness";
  settingsById("settings-harness-root").value = view.harnessRoot || "";
  settingsById("settings-kernel-status").textContent = kernelSummary(view);
  settingsById("settings-kernel-status").classList.toggle("settings-ok", Boolean(view.kernel?.ready));
  settingsById("settings-kernel-status").classList.toggle("settings-fail", !view.kernel?.ready);
  const bundledNote = view.bundled
    ? "当前检测到包内 deepseek-harness，运行时优先使用包内内核；上方检出路径可留空（仅开发机需要）。"
    : "未检测到包内内核；对话运行需要上方检出路径可用。";
  settingsById("settings-kernel-hint").textContent =
    `${bundledNote} 保存后工作区进程按新配置重启。路径来源：${sourceLabel(view.sources?.harnessRoot)}；引擎：${sourceLabel(view.sources?.reportEngine)}。`;
  if (view.platformUrl && !settingsById("platform-url").value) {
    settingsById("platform-url").value = view.platformUrl;
  }
}

async function loadDesktopSettings() {
  const feedback = settingsById("settings-feedback");
  try {
    const view = await window.cpclaw.settingsGet();
    fillSettingsForm(view);
    if (view?.ok) feedback.textContent = "";
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "读取设置失败";
  }
}

async function loadLearningGrant() {
  const feedback = settingsById("learning-feedback");
  if (!feedback) return;
  try {
    const result = await chatCall("learning.grant");
    if (!result.ok) throw new Error(result.message);
    settingsById("learning-enabled").checked = result.grant.enabled === true && result.grant.autoSubmit === true;
    settingsById("learning-budget").value = String(result.grant.budget ?? 0);
    settingsById("learning-pause").textContent = result.grant.paused ? "恢复学习" : "暂停学习";
    settingsById("learning-pause").dataset.paused = result.grant.paused ? "1" : "0";
    const tracks = await chatCall("formal.tracks");
    const list = settingsById("formal-tracks");
    list.replaceChildren();
    for (const track of tracks.tracks ?? []) {
      if (track.open) continue;
      const item = document.createElement("li");
      item.textContent = track.missing;
      list.append(item);
    }
    if (!list.children.length) list.append(Object.assign(document.createElement("li"), { textContent: "除自动更新外，正式输入已登记。自动更新仍不在首期。" }));
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "无法读取学习授权";
  }
}

settingsById("learning-save")?.addEventListener("click", async () => {
  const feedback = settingsById("learning-feedback");
  const budget = Number(settingsById("learning-budget").value);
  const enabled = settingsById("learning-enabled").checked;
  const result = await chatCall("learning.grant", { save: true, enabled, autoSubmit: enabled, paused: false, budget: Number.isInteger(budget) ? budget : 0, kinds: ["experience"], includeHistory: false });
  feedback.textContent = result.ok ? (enabled ? "已开启授权自学习" : "学习授权已关闭") : result.message;
  if (result.ok) await loadLearningGrant();
});

settingsById("learning-pause")?.addEventListener("click", async () => {
  const current = await chatCall("learning.grant");
  if (!current.ok) return;
  const paused = current.grant.paused !== true;
  const result = await chatCall("learning.grant", { save: true, ...current.grant, paused });
  settingsById("learning-feedback").textContent = result.ok ? (paused ? "已暂停学习" : "已恢复学习") : result.message;
  if (result.ok) await loadLearningGrant();
});

window.loadDesktopSettings = async () => {
  await loadDesktopSettings();
  await loadLearningGrant();
};
window.fillSettingsForm = fillSettingsForm;

function settingsPayload() {
  return {
    reportEngine: settingsById("settings-report-engine").value,
    harnessRoot: settingsById("settings-harness-root").value.trim(),
    reportModelMode: settingsById("settings-report-mode").value,
  };
}

settingsById("settings-save").addEventListener("click", async () => {
  const button = settingsById("settings-save");
  const feedback = settingsById("settings-feedback");
  if (button.dataset.busy) return;
  button.dataset.busy = "true";
  button.disabled = true;
  try {
    const result = await window.cpclaw.settingsSave(settingsPayload());
    fillSettingsForm(result);
    feedback.textContent = result.ok ? "已保存本机配置" : (result.message || "保存失败");
    if (result.ok && typeof window.refreshKernelStatus === "function") await window.refreshKernelStatus();
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "保存失败";
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
  }
});

settingsById("settings-sync-env").addEventListener("click", async () => {
  const button = settingsById("settings-sync-env");
  const feedback = settingsById("settings-feedback");
  if (button.dataset.busy) return;
  if (!window.confirm("将用当前进程环境变量覆盖本机已保存的内核与模型模式设置。确定继续？")) return;
  button.dataset.busy = "true";
  button.disabled = true;
  try {
    const result = await window.cpclaw.settingsSyncEnv();
    fillSettingsForm(result);
    feedback.textContent = result.ok ? "已从 .env / 环境变量同步并保存" : (result.message || "同步失败");
    if (result.ok && typeof window.refreshKernelStatus === "function") await window.refreshKernelStatus();
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "同步失败";
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
  }
});

settingsById("settings-pick-harness").addEventListener("click", async () => {
  const result = await window.cpclaw.settingsPickHarnessRoot();
  if (!result?.ok || result.cancelled) return;
  settingsById("settings-harness-root").value = result.path || "";
});

settingsById("settings-probe-platform").addEventListener("click", async () => {
  const button = settingsById("settings-probe-platform");
  const out = settingsById("settings-platform-probe");
  if (button.dataset.busy) return;
  button.dataset.busy = "true";
  button.disabled = true;
  out.textContent = "正在探测企业端…";
  try {
    const result = await window.cpclaw.settingsProbePlatform({
      platformUrl: settingsById("platform-url").value.trim(),
    });
    out.textContent = result.ok ? result.summary : (result.message || "探测失败");
  } catch (error) {
    out.textContent = error instanceof Error ? error.message : "探测失败";
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
  }
});

void loadDesktopSettings();

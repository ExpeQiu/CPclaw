(() => {
  const picker = document.getElementById("composer-model");
  const label = document.getElementById("composer-model-label");
  const labels = { real: "MiniMax-M3", mock: "Mock" };
  let busy = false;

  function render(mode = "real") {
    const current = mode === "mock" ? "mock" : "real";
    label.textContent = labels[current];
    label.title = `模型：${labels[current]} · 点击切换`;
    picker.dataset.mode = current;
    for (const button of picker.querySelectorAll("[data-model-mode]")) {
      button.setAttribute("aria-checked", String(button.dataset.modelMode === current));
    }
    const select = document.getElementById("settings-report-mode");
    if (select && select.value !== current) select.value = current;
  }

  async function load() {
    try {
      const view = await window.cpclaw.settingsGet();
      if (view?.ok) render(view.reportModelMode === "mock" ? "mock" : "real");
      else render("real");
    } catch {
      render("real");
    }
  }

  window.refreshComposerModel = load;
  window.renderComposerModel = render;

  picker.addEventListener("toggle", () => {
    if (picker.open) void load();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!picker.contains(event.target)) picker.open = false;
  });
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      picker.open = false;
      label.focus();
    }
  });

  for (const button of picker.querySelectorAll("[data-model-mode]")) {
    button.onclick = async () => {
      if (busy) return;
      busy = true;
      const mode = button.dataset.modelMode === "mock" ? "mock" : "real";
      try {
        const view = await window.cpclaw.settingsGet();
        if (!view?.ok) throw new Error(view?.message || "无法读取当前设置");
        const result = await window.cpclaw.settingsSave({
          reportEngine: view.reportEngine === "harness" ? "harness" : "none",
          harnessRoot: view.harnessRoot || "",
          reportModelMode: mode,
        });
        if (!result.ok) throw new Error(result.message || "模型模式未保存");
        render(result.reportModelMode === "mock" ? "mock" : "real");
        picker.open = false;
        if (typeof window.fillSettingsForm === "function") window.fillSettingsForm(result);
        else if (typeof window.loadDesktopSettings === "function") await window.loadDesktopSettings();
        setStatus(mode === "mock" ? "已切换为 Mock 演示模式" : "已切换为 MiniMax-M3（企业端网关）");
        if (typeof window.refreshKernelStatus === "function") await window.refreshKernelStatus();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "模型模式未更改");
      } finally {
        busy = false;
      }
    };
  }

  void load();
})();

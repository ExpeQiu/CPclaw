const diagnosticsDialog = byId('diagnostics-dialog');
const diagnosticsRepairBtn = byId('diagnostics-repair');
let lastDiagnoseResult = null;
let lastDiagnoseChatId = '';

byId('diagnostics-close').onclick = () => diagnosticsDialog.close();
window.clearChatDiagnostics = function () {
  diagnosticsDialog.close();
  byId('diagnostics-body').replaceChildren();
  lastDiagnoseResult = null;
  diagnosticsRepairBtn.hidden = true;
};

function diagParagraph(body, text, className) {
  const p = document.createElement('p');
  if (className) p.className = className;
  p.textContent = text;
  body.append(p);
  return p;
}

function diagSection(body, title) {
  const h = document.createElement('h3');
  h.textContent = title;
  body.append(h);
}

function statusLabel(status) {
  return ({ error: '待处理', ok: '通过', fixed: '已修复', warn: '警告', info: '提示', skipped: '跳过' })[status] || status;
}

/** 根据诊断结果生成可执行修复计划（含引导项）。 */
function planRepairs(result) {
  const plans = [];
  const codes = new Set((result?.findings || []).filter((f) => f.status === 'error').map((f) => f.code));
  const seen = new Set();
  for (const action of result?.repairActions || []) {
    if (!action.runnable || action.executed) continue;
    if (seen.has(action.code)) continue;
    seen.add(action.code);
    plans.push({ ...action, kind: 'server' });
  }
  if (codes.has('DREAMINA_AUTH_SCOPE') && !seen.has('DREAMINA_AUTH_SCOPE')) {
    seen.add('DREAMINA_AUTH_SCOPE');
    plans.push({
      code: 'DREAMINA_AUTH_SCOPE',
      label: '重新授权即梦',
      detail: '打开即梦面板并启动官方重新授权（需确认）',
      kind: 'dreamina',
      needsConfirm: true,
    });
  }
  if ((codes.has('HARNESS_CLEANUP') || codes.has('KERNEL_UNAVAILABLE')) && !seen.has('HARNESS_CLEANUP')) {
    seen.add('HARNESS_CLEANUP');
    plans.push({
      code: 'HARNESS_CLEANUP',
      label: '重启工作区进程',
      detail: '刷新内核连接；不宣称清除历史残留证据',
      kind: 'worker',
    });
  }
  if ((codes.has('SERVICE_FAILED') || codes.has('HARNESS_CLEANUP')) && !seen.has('MEDIA_RESUME') && !seen.has('DREAMINA_AUTH_SCOPE') && !seen.has('OPEN_SERVICE_PANEL')) {
    seen.add('OPEN_SERVICE_PANEL');
    plans.push({
      code: 'OPEN_SERVICE_PANEL',
      label: '打开应用操作面板',
      detail: '核对失败回执；授权不足时请先完成重新授权',
      kind: 'panel',
    });
  }
  if (codes.has('PLATFORM_SESSION') && !seen.has('PLATFORM_SESSION')) {
    seen.add('PLATFORM_SESSION');
    plans.push({
      code: 'PLATFORM_SESSION',
      label: '打开平台登录设置',
      detail: '检查平台地址并重新登录',
      kind: 'settings',
    });
  }
  if (codes.has('KERNEL_UNAVAILABLE') && !seen.has('KERNEL_SETTINGS')) {
    seen.add('KERNEL_SETTINGS');
    plans.push({
      code: 'KERNEL_SETTINGS',
      label: '打开内核设置',
      detail: '在设置中启用 deepseek-harness',
      kind: 'settings-kernel',
    });
  }
  if (codes.has('BRIDGE_UNAVAILABLE')) {
    plans.push({
      code: 'BRIDGE_UNAVAILABLE',
      label: '提示重启应用',
      detail: '桌面桥接不可用，需完全退出后重启',
      kind: 'bridge',
    });
  }
  // 平台拒绝了本机服务目录：先让桌面端按平台能力裁剪，再重试本轮回复。
  if (codes.has('SERVICE_CATALOG_REJECTED') && !seen.has('SERVICE_CATALOG_REJECTED')) {
    seen.add('SERVICE_CATALOG_REJECTED');
    plans.push({
      code: 'SERVICE_CATALOG_REJECTED',
      label: '按平台能力重裁服务目录',
      detail: '刷新平台能力并裁剪不兼容的服务类型；本机可执行服务不受影响',
      kind: 'catalog',
    });
  }
  // 回复未完成：给出重试入口。只在没有更具体的修复项时兜底，避免掩盖真因。
  if (codes.has('REPLY_INCOMPLETE') && (!result.hasServiceSteps||result.safeToRetry) && !codes.has('MODEL_QUOTA_EXHAUSTED') && !codes.has('MODEL_CONCURRENCY_FULL') && !seen.has('REPLY_INCOMPLETE') && !seen.has('SERVICE_CATALOG_REJECTED')) {
    seen.add('REPLY_INCOMPLETE');
    plans.push({
      code: 'REPLY_INCOMPLETE',
      label: result.hasServiceSteps?'继续原请求（此前仅有只读查询）':'重试本轮回复',
      detail: '按原请求继续；仅无执行回执或已确认全部为只读操作时可用，已有生成或写入仍禁止整轮重放',
      kind: 'retry',
    });
  }
  if (codes.has('EMPTY_REPLY') && !seen.has('EMPTY_REPLY')) {
    seen.add('EMPTY_REPLY');
    plans.push({
      code: 'EMPTY_REPLY',
      label: '恢复空白回复摘要',
      detail: '从已保存的应用回执恢复执行摘要；不代表原任务已完成',
      kind: 'server',
    });
  }
  return plans;
}

function syncRepairButton(result) {
  const plans = planRepairs(result);
  diagnosticsRepairBtn.hidden = !plans.length;
  diagnosticsRepairBtn.disabled = false;
  diagnosticsRepairBtn.textContent = plans.length ? `执行修复（${plans.length}）` : '执行修复';
  diagnosticsRepairBtn.title = plans.map((p) => p.label).join('；') || '无可执行修复';
}

function renderDiagnoseReport(body, result) {
  body.replaceChildren();
  if(result.summary){
    const summary=result.summary;
    diagParagraph(body,`检查完成 · ${{none:'未执行修复',verified:'本次修复已验证',failed:'修复仍有未通过项'}[summary.repairState]||'待核实'} · 当前待处理 ${summary.unresolved} 项`);
  }
  if(result.authority==='system-diagnostic')diagParagraph(body,'系统维护权限 · 自动恢复已有任务，修复后验证并记录经验','muted');
  if(result.issue?.action==='quota'){
    const button=document.createElement('button');button.className='primary';button.textContent='申请新额度';
    button.onclick=()=>void window.showTaskIssue?.(result.issue,{messageId:result.messageId});body.append(button);
  }
  if(result.task&&(result.task.images?.length||result.task.operations?.length)){
    diagSection(body,'任务成果与恢复');
    diagParagraph(body,result.task.detail);
    for(const image of result.task.images||[]){
      if(image.localError)diagParagraph(body,`图片 ${image.resourceId}：${image.localError}`,'muted');
      if(!image.local)continue;
      const p=diagParagraph(body,image.local.path),button=document.createElement('button');
      button.textContent='查看已恢复图片';
      button.onclick=async()=>{
        const r=await window.cpclaw.extensionAction({action:'result-image',path:image.local.path});
        if(!r.ok){button.textContent='预览读取失败，请重新诊断';return;}
        const img=document.createElement('img');img.alt='已生成图片的本机预览';img.src=r.dataUrl;img.style.maxWidth='100%';p.replaceChildren(img);
      };
      body.append(button);
      const open=document.createElement('button');open.textContent='打开原图';
      open.onclick=()=>void window.cpclaw.extensionAction({action:'open-result-image',path:image.local.path});body.append(open);
    }
  }
  diagSection(body, '检查结果');
  for (const finding of result.findings || []) {
    diagParagraph(body, `${statusLabel(finding.status)} · ${finding.detail}`);
  }

  if (result.kernel) {
    diagSection(body, '推理内核');
    const k = result.kernel;
    const source = k.source === 'bundle' ? '包内' : k.source === 'checkout' ? '本机检出' : '未启用';
    diagParagraph(body, `${k.ready ? '可用' : '不可用'} · ${k.name || '未配置'} · ${source}${k.version ? ` · v${k.version}` : ''}`, k.ready ? 'settings-ok' : 'settings-fail');
  }

  if (result.timeline?.length) {
    diagSection(body, '任务全链路');
    const list = document.createElement('ol');
    list.className = 'diagnose-timeline';
    for (const step of result.timeline) {
      const item = document.createElement('li');
      item.dataset.status = step.status;
      item.textContent = `${statusLabel(step.status)} · ${step.label} — ${step.detail}`;
      list.append(item);
    }
    body.append(list);
  } else if (result.activities?.length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '查看本轮任务链路';
    details.append(summary);
    const list = document.createElement('ol');
    for (const step of result.activities) {
      const item = document.createElement('li');
      item.textContent = `${step.label} · ${{ done: '已结束', error: '异常', interrupted: '中断', cancelled: '已停止', running: '记录待校正' }[step.state] ?? step.state}`;
      list.append(item);
    }
    details.append(list);
    body.append(details);
  }

  diagSection(body, '本地修复');
  for (const repair of result.repairs || []) {
    diagParagraph(body, `${repair.verified ? '修复已验证' : '修复验证失败'} · ${repair.detail}`);
  }
  if (!result.repairs?.length) diagParagraph(body, '本次没有自动执行的本地修复。');

  const plans = planRepairs(result);
  if (plans.length) {
    diagSection(body, '可执行修复');
    diagParagraph(body, `共 ${plans.length} 项。可点右上角「执行修复」一次性处理，或按下方单项执行。`, 'muted');
    for (const action of plans) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = `${action.label}：${action.detail}`;
      body.append(note);
      const row = document.createElement('div');
      row.className = 'button-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.needsConfirm ? '确认并执行' : '执行此项';
      button.onclick = () => void runRepairPlan([action], { single: true });
      row.append(button);
      body.append(row);
    }
  }

  if (result.logs?.length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `相关日志 · ${result.logs.length} 条`;
    details.append(summary);
    const pre = document.createElement('pre');
    pre.className = 'diagnose-logs';
    pre.textContent = result.logs.map((l) => `${l.timestamp} ${l.level} ${l.event} ${l.message}`).join('\n');
    details.append(pre);
    body.append(details);
  }

  for (const repeated of (result.repeated || []).filter((r) => r.count > 1)) {
    diagParagraph(body, `同类异常 ${{
      DREAMINA_AUTH_SCOPE: '即梦授权不足',
      HARNESS_CLEANUP: '运行进程退出异常',
      REPLY_INCOMPLETE: '回复未完成',
      EMPTY_REPLY: '空白回复',
      SERVICE_FAILED: '应用操作失败',
      SERVICE_CATALOG_REJECTED: '平台拒绝服务目录',
      PROJECT_UNAVAILABLE: '项目目录不可用',
      PLATFORM_SESSION: '平台连接或登录异常',
      KERNEL_UNAVAILABLE: '内核不可用',
      SKILL_INSTALL_MISSING: '技能制品缺失',
      SKILL_BINDING_STALE: '技能绑定失效',
      SKILL_OUTPUT_FAILED: '技能输出校验失败',
    }[repeated.code] ?? '任务异常'} 已在此对话的 ${repeated.count} 轮任务中出现，请结合回执进一步排查。`);
  }
  if(result.experience?.length){
    diagSection(body,'经验与防复发');
    for(const lesson of result.experience){
      diagParagraph(body,`${lesson.state==='verified'?'已有验证有效的修复':'已记录待验证的问题'} · ${lesson.code} · 涉及 ${lesson.occurrences} 轮任务`);
      diagParagraph(body,lesson.prevention,'muted');
    }
    if(result.reusedExperience)diagParagraph(body,`本次参考了 ${result.reusedExperience} 条已有经验。`,'muted');
  }
  if (result.prevention) diagParagraph(body, result.prevention, 'muted');
  syncRepairButton(result);
}

async function executeOneRepair(action, log) {
  if (action.kind === 'server' || action.kind === 'catalog' || (['SKILL_INSTALL_MISSING', 'SKILL_BINDING_STALE'].includes(action.code) && action.kind !== 'dreamina')) {
    const fixed = await chatCall('chat.diagnoseRepair', { chatId: currentChatId, code: action.code });
    if (!fixed.ok) throw Error(fixed.message || `${action.label}失败`);
    const line = (fixed.repairs || []).map((r) => `${r.verified ? '已验证' : '未通过'} · ${r.detail}`).join('；') || action.label;
    log(line);
    return fixed;
  }
  if (action.kind === 'retry' || action.code === 'REPLY_INCOMPLETE') {
    const send = typeof window.sendChat === 'function' ? window.sendChat : typeof sendChat === 'function' ? sendChat : null;
    if (!send) throw Error('重试入口不可用，请手动重发本轮请求');
    log('正在按原请求重试本轮回复…');
    // 诊断窗是 modal，重试会走同一渲染层流程；先关窗避免 showModal 阻塞交互。
    try { diagnosticsDialog.close(); } catch { /* ignore */ }
    await send(true);
    return { ok: true };
  }
  if (action.kind === 'dreamina' || action.code === 'DREAMINA_AUTH_SCOPE') {
    if (typeof window.showServiceWorkspace === 'function') {
      window.showServiceWorkspace({ id: 'dreamina', title: '即梦画布', type: 'CLI', builtin: true });
    }
    const result = await window.cpclaw.extensionAction({ action: 'repair-dreamina-auth' });
    log(result.message || (result.ok ? '即梦授权修复完成' : '即梦授权修复未完成'));
    if (!result.ok && result.state !== 'awaiting_login') throw Error(result.message || '即梦授权修复失败');
    return result;
  }
  if (action.kind === 'panel' || action.code === 'OPEN_SERVICE_PANEL') {
    if (typeof window.showServiceWorkspace === 'function') {
      window.showServiceWorkspace({ id: 'dreamina', title: '即梦画布', type: 'CLI', builtin: true });
    }
    log('已打开应用操作面板，请核对回执。');
    return { ok: true };
  }
  if (action.kind === 'worker' || action.code === 'HARNESS_CLEANUP') {
    const result = await window.cpclaw.runtimeRestartWorker();
    if (typeof window.refreshKernelStatus === 'function') await window.refreshKernelStatus();
    log(result.message || '已重启工作区进程');
    return result;
  }
  if (action.kind === 'settings' || action.code === 'PLATFORM_SESSION') {
    await openSettingsAfterDiagnose(chatAccount ? 'platform-url' : 'employee-id');
    log('已打开设置：请检查平台地址并登录。');
    return { ok: true };
  }
  if (action.kind === 'settings-kernel' || action.code === 'KERNEL_SETTINGS') {
    await openSettingsAfterDiagnose('settings-report-engine');
    log('已打开设置：请启用 deepseek-harness 并保存。');
    return { ok: true };
  }
  if (action.kind === 'bridge' || action.code === 'BRIDGE_UNAVAILABLE') {
    log('桌面桥接不可用，请完全退出后重启 CPclaw。');
    return { ok: false };
  }
  throw Error(`未知修复项：${action.code}`);
}

/** 先关诊断窗再开设置；避免 showModal + window.confirm 叠层导致后续代码不执行。 */
function openSettingsAfterDiagnose(focusId) {
  return new Promise((resolve) => {
    try { diagnosticsDialog.close(); } catch { /* ignore */ }
    requestAnimationFrame(() => {
      const open = typeof window.openPanel === 'function' ? window.openPanel : typeof openPanel === 'function' ? openPanel : null;
      if (open) open('settings');
      else setStatus('无法打开设置面板，请点左侧「设置与诊断」。');
      const focusEl = focusId ? byId(focusId) : null;
      if (focusEl) {
        try { focusEl.focus(); } catch { /* ignore */ }
      }
      resolve();
    });
  });
}

/** 在诊断对话框内确认，不用原生 confirm（与 modal dialog 冲突）。 */
function confirmRepairInDialog(message) {
  const body = byId('diagnostics-body');
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'diagnose-repair-log';
    box.setAttribute('role', 'alertdialog');
    const text = document.createElement('p');
    text.textContent = message;
    const row = document.createElement('div');
    row.className = 'button-row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = '确定';
    const finish = (value) => { box.remove(); resolve(value); };
    cancel.onclick = () => finish(false);
    ok.onclick = () => finish(true);
    row.append(cancel, ok);
    box.append(text, row);
    body.prepend(box);
    ok.focus();
  });
}

function isSettingsOnlyPlan(plans) {
  return plans.length > 0 && plans.every((p) => p.kind === 'settings' || p.kind === 'settings-kernel');
}

async function runRepairPlan(plans, { single = false } = {}) {
  if (!plans.length) {
    setStatus('当前没有可执行的修复项。');
    return;
  }

  // 仅打开设置：无需二次确认，直接关诊断窗并聚焦登录。
  if (isSettingsOnlyPlan(plans)) {
    diagnosticsRepairBtn.disabled = true;
    try {
      for (const action of plans) {
        await executeOneRepair(action, () => {});
      }
      setStatus('已打开「设置与诊断」，请检查平台地址并登录。');
    } catch (error) {
      setStatus(error.message || '打开设置失败');
    } finally {
      if (lastDiagnoseResult) syncRepairButton(lastDiagnoseResult);
      else { diagnosticsRepairBtn.disabled = false; diagnosticsRepairBtn.textContent = '执行修复'; }
    }
    return;
  }

  const needsAsk = plans.some(p=>p.needsConfirm)||lastDiagnoseResult?.authority!=='system-diagnostic'&&!single;
  if (needsAsk) {
    const labels = plans.map((p) => p.label).join('、');
    const ok = await confirmRepairInDialog(`将依次执行：${labels}。涉及重新授权时仍会单独请求批准。是否继续？`);
    if (!ok) return;
  }

  const body = byId('diagnostics-body');
  const logBox = document.createElement('div');
  logBox.className = 'diagnose-repair-log';
  logBox.setAttribute('aria-live', 'polite');
  const append = (text) => {
    const line = document.createElement('div');
    line.textContent = text;
    logBox.append(line);
  };
  diagSection(body, '修复进度');
  body.append(logBox);

  diagnosticsRepairBtn.disabled = true;
  diagnosticsRepairBtn.textContent = '修复中…';
  let closedForUi = false;
  try {
    for (const action of plans) {
      if (action.kind === 'settings' || action.kind === 'settings-kernel') closedForUi = true;
      append(`→ ${action.label}…`);
      try {
        await executeOneRepair(action, append);
      } catch (error) {
        append(`× ${error.message || '失败'}`);
        window.cpclaw?.log?.({
          level: 'warn',
          event: 'diagnose_repair_item_failed',
          message: String(error?.message || action.code).slice(0, 200),
          chatId: currentChatId,
        });
      }
    }
    if (!closedForUi && currentChatId) {
      append('→ 重新运行自诊断…');
      const again = await chatCall('chat.diagnose', { chatId: currentChatId });
      if (again.ok) {
        lastDiagnoseResult = again;
        lastDiagnoseChatId = currentChatId;
        renderDiagnoseReport(body, again);
        const history = await chatCall('chat.history', { chatId: currentChatId });
        if (history.ok) { chatMessages = history.messages; renderChat(); }
        setStatus(again.summary?.unresolved?`复检完成，仍有 ${again.summary.unresolved} 项待处理。`:'复检完成，请查看任务成果与修复结果。');
        return;
      }
      append(again.message || '重新诊断失败');
    }
    setStatus(closedForUi ? '已打开设置，请按提示完成后再点自诊断。' : '修复流程已结束。');
  } catch (error) {
    append(error.message || '修复失败');
    setStatus(error.message || '修复失败');
  } finally {
    if (lastDiagnoseResult) syncRepairButton(lastDiagnoseResult);
    else {
      diagnosticsRepairBtn.disabled = false;
      diagnosticsRepairBtn.textContent = '执行修复';
    }
  }
}

diagnosticsRepairBtn.onclick = () => {
  if (!lastDiagnoseResult || lastDiagnoseChatId !== currentChatId) {
    setStatus('请先运行自诊断。');
    return;
  }
  void runRepairPlan(planRepairs(lastDiagnoseResult));
};

byId('chat-diagnose').onclick = async () => {
  const button = byId('chat-diagnose'), body = byId('diagnostics-body');
  if (button.dataset.busy || runningChatId || !currentChatId || !chatAccount) return;
  if (!window.cpclaw?.workspace) {
    diagnosticsDialog.showModal();
    body.replaceChildren();
    lastDiagnoseResult = {
      findings: [{ code: 'BRIDGE_UNAVAILABLE', status: 'error', detail: '桌面桥接不可用（window.cpclaw.workspace 缺失）。请完全退出并重启应用。' }],
      repairs: [],
      repairActions: [],
    };
    lastDiagnoseChatId = currentChatId || '';
    diagSection(body, '检查结果');
    diagParagraph(body, '待处理 · 桌面桥接不可用（window.cpclaw.workspace 缺失）。请完全退出并重启应用；勿在普通浏览器打开本地页面。');
    syncRepairButton(lastDiagnoseResult);
    window.cpclaw?.log?.({ level: 'error', event: 'bridge_unavailable', message: '自诊断检测到桥接缺失' });
    setStatus('桌面桥接不可用，请重启应用。');
    return;
  }
  const actor = chatAccount, chatId = currentChatId, generation = selectedChatGeneration;
  button.dataset.busy = 'true'; button.disabled = true; button.textContent = '诊断中…'; button.setAttribute('aria-busy', 'true');
  body.textContent = '正在检查账号、内核、任务链路、Skill 制品与相关日志…';
  diagnosticsRepairBtn.hidden = true;
  diagnosticsDialog.showModal();
  const current = () => actor === chatAccount && chatId === currentChatId && generation === selectedChatGeneration;
  try {
    const result = await chatCall('chat.diagnose', { chatId });
    if (!current()) return;
    if (!result.ok) throw Error(result.message);
    lastDiagnoseResult = result;
    lastDiagnoseChatId = chatId;
    renderDiagnoseReport(body, result);
    const history = await chatCall('chat.history', { chatId });
    if (current() && history.ok) { chatMessages = history.messages; renderChat(); }
    const recoveredImage=result.task?.images?.some(image=>image.delivered&&image.local);
    setStatus((result.summary?.unresolved?`自诊断检查完成，仍有 ${result.summary.unresolved} 项待处理，请查看具体原因。`:'自诊断检查完成，请查看检查与修复结果。')+(recoveredImage?'已恢复图片可在报告中查看。':''));
  } catch (error) {
    if (current()) { body.textContent = error.message || '诊断失败，请重试。'; setStatus(body.textContent); }
    window.cpclaw?.log?.({ level: 'error', event: 'diagnose_ui_failed', message: String(error?.message || '诊断失败').slice(0, 200) });
  } finally {
    delete button.dataset.busy; button.removeAttribute('aria-busy'); button.textContent = '自诊断'; renderComposer();
  }
};

const diagnosticsDialog = byId('diagnostics-dialog');
byId('diagnostics-close').onclick = () => diagnosticsDialog.close();
window.clearChatDiagnostics = function () { diagnosticsDialog.close(); byId('diagnostics-body').replaceChildren(); };

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

function renderDiagnoseReport(body, result) {
  body.replaceChildren();
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

  const runnable = (result.repairActions || []).filter((a) => a.runnable && !a.executed);
  if (runnable.length) {
    diagSection(body, '可执行修复');
    for (const action of runnable) {
      const row = document.createElement('div');
      row.className = 'button-row';
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = `${action.label}：${action.detail}`;
      body.append(note);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.needsConfirm ? '确认并执行' : '执行修复';
      button.onclick = async () => {
        if (action.needsConfirm && !window.confirm(`确认执行：${action.label}？`)) return;
        button.disabled = true;
        try {
          const fixed = await chatCall('chat.diagnoseRepair', { chatId: currentChatId, code: action.code });
          if (!fixed.ok) throw Error(fixed.message || '修复失败');
          diagParagraph(body, (fixed.repairs || []).map((r) => `${r.verified ? '已验证' : '未通过'} · ${r.detail}`).join('；') || '修复完成');
        } catch (error) {
          diagParagraph(body, error.message || '修复失败');
        } finally {
          button.disabled = false;
        }
      };
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
      PROJECT_UNAVAILABLE: '项目目录不可用',
      PLATFORM_SESSION: '平台连接或登录异常',
      KERNEL_UNAVAILABLE: '内核不可用',
      SKILL_INSTALL_MISSING: '技能制品缺失',
      SKILL_BINDING_STALE: '技能绑定失效',
      SKILL_OUTPUT_FAILED: '技能输出校验失败',
    }[repeated.code] ?? '任务异常'} 已在此对话的 ${repeated.count} 轮任务中出现，请结合回执进一步排查。`);
  }
  if (result.prevention) diagParagraph(body, result.prevention, 'muted');
}

byId('chat-diagnose').onclick = async () => {
  const button = byId('chat-diagnose'), body = byId('diagnostics-body');
  if (button.dataset.busy || runningChatId || !currentChatId || !chatAccount) return;
  if (!window.cpclaw?.workspace) {
    diagnosticsDialog.showModal();
    body.replaceChildren();
    diagSection(body, '检查结果');
    diagParagraph(body, '待处理 · 桌面桥接不可用（window.cpclaw.workspace 缺失）。请完全退出并重启应用；勿在普通浏览器打开本地页面。');
    window.cpclaw?.log?.({ level: 'error', event: 'bridge_unavailable', message: '自诊断检测到桥接缺失' });
    setStatus('桌面桥接不可用，请重启应用。');
    return;
  }
  const actor = chatAccount, chatId = currentChatId, generation = selectedChatGeneration;
  button.dataset.busy = 'true'; button.disabled = true; button.textContent = '诊断中…'; button.setAttribute('aria-busy', 'true');
  body.textContent = '正在检查账号、内核、任务链路、Skill 制品与相关日志…';
  diagnosticsDialog.showModal();
  const current = () => actor === chatAccount && chatId === currentChatId && generation === selectedChatGeneration;
  try {
    const result = await chatCall('chat.diagnose', { chatId });
    if (!current()) return;
    if (!result.ok) throw Error(result.message);
    renderDiagnoseReport(body, result);
    const history = await chatCall('chat.history', { chatId });
    if (current() && history.ok) { chatMessages = history.messages; renderChat(); }
    setStatus('自诊断完成，请查看检查结果。');
  } catch (error) {
    if (current()) { body.textContent = error.message || '诊断失败，请重试。'; setStatus(body.textContent); }
    window.cpclaw?.log?.({ level: 'error', event: 'diagnose_ui_failed', message: String(error?.message || '诊断失败').slice(0, 200) });
  } finally {
    delete button.dataset.busy; button.removeAttribute('aria-busy'); button.textContent = '自诊断'; renderComposer();
  }
};

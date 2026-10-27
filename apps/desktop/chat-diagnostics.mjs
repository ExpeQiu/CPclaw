const failedReceipts = step => [step.result,step.result?.account,step.result?.current].filter(r=>r?.ok===false);

/** Diagnostic conclusions use persisted host evidence, never model guesses. */
export function serviceRecoveryText(steps) {
  if (!steps.length) return '';
  const failed = steps.filter(s => failedReceipts(s).length).length;
  return `本轮回复未完成，已恢复 ${steps.length} 条应用执行记录（${failed} 条明确返回失败）。\n\n` +
    steps.map(s => `- 步骤 ${s.step} · ${s.service?.title || '应用服务'}：${failedReceipts(s).length ? '操作未完成' : '已收到回执，任务终态仍需核实'}`).join('\n') +
    '\n\n请在应用操作面板核对回执；继续对话时先查询已有任务状态，避免重复提交。';
}

export function analyzeChat(message, steps = []) {
  const findings = [];
  if (!message) return [{code:'NO_REPLY',status:'info',detail:'当前对话尚无助手回复，请先发起任务。'}];
  const error = message.error || '';
  if (/Harness 子进程未回收/.test(error)) findings.push({code:'HARNESS_CLEANUP',status:'error',detail:'上次执行在 Harness 退出检查阶段失败。已加入有上限的退出等待；历史记录不能证明进程当前仍残留。若再次发生，需进一步检查运行环境。'});
  if (['error','cancelled','interrupted'].includes(message.state)) findings.push({code:'REPLY_INCOMPLETE',status:'error',detail:`上次回复未完成：${error || message.state}。`});
  if (!message.content.trim()) findings.push({code:'EMPTY_REPLY',status:'error',detail:'回复正文为空。可从已保存的应用回执恢复执行摘要；摘要不代表原任务完成。'});
  const failed = steps.filter(s => failedReceipts(s).length);
  if(steps.some(s=>failedReceipts(s).some(r=>r.error?.reason==='oauth_scope_insufficient'))) findings.push({code:'DREAMINA_AUTH_SCOPE',status:'error',detail:'即梦服务端回执确认 OAuth 授权范围不足；本地显示已登录不能证明服务可用。需要重新授权，然后验证服务端账号与原画布读取，再恢复原任务，不能重复生成。'});
  if (failed.length) findings.push({code:'SERVICE_FAILED',status:'error',detail:`${failed.length} 条应用回执明确返回失败。请在操作面板查看参数、权限或服务返回原因，并先核实已有任务状态。`});
  if (message.retrievalStatus === 'unavailable') findings.push({code:'PROJECT_UNAVAILABLE',status:'error',detail:'上次项目资料目录不可用，请检查目录是否存在及访问权限。'});
  else if (['no-match','limited'].includes(message.retrievalStatus)) findings.push({code:'SEARCH_NO_MATCH',status:'info',detail:'项目检索未找到相关片段，属于检索结果，不是任务链路故障。'});
  if (!findings.length) findings.push({code:'NO_KNOWN_FAILURE',status:'info',detail:'当前已保存记录未发现已知异常；这不代表外部任务已经完成。'});
  return findings;
}

/** 内核探测结果转 finding。 */
export function analyzeKernel(kernel) {
  if (!kernel || typeof kernel !== 'object') {
    return { finding: { code: 'KERNEL_UNKNOWN', status: 'warn', detail: '无法读取推理内核状态。' }, segment: { id: 'kernel', label: '推理内核', status: 'warn', detail: '状态未知' } };
  }
  if (kernel.ready) {
    const source = kernel.source === 'bundle' ? '包内' : kernel.source === 'checkout' ? '本机检出' : kernel.source;
    const version = kernel.version ? ` v${kernel.version}` : '';
    return {
      finding: { code: 'KERNEL_OK', status: 'ok', detail: `内核可用：${kernel.name || 'deepseek-harness'}（${source}${version}）。` },
      segment: { id: 'kernel', label: '推理内核', status: 'ok', detail: `${kernel.name} · ${source}${version}` },
    };
  }
  return {
    finding: { code: 'KERNEL_UNAVAILABLE', status: 'error', detail: '推理内核不可用。请在「设置与诊断」启用 deepseek-harness，或检查包内/检出路径。' },
    segment: { id: 'kernel', label: '推理内核', status: 'error', detail: kernel.name || '未配置' },
  };
}

/**
 * 检查绑定 skill 的本机制品。
 * @param binding chat 绑定
 * @param checks `{ storageSkill, version, digest, ok, message }[]`
 * @param skillResult 最近一轮 skill_run_snapshots.result
 */
export function analyzeSkillHealth(binding, checks = [], skillResult = null) {
  const findings = [];
  const repairActions = [];
  if (!binding) {
    return {
      findings: [{ code: 'SKILL_NONE', status: 'info', detail: '当前对话未绑定 Skill。' }],
      repairActions,
      segment: { id: 'skill', label: 'Skill 与脚本', status: 'skipped', detail: '未绑定' },
    };
  }
  const broken = checks.filter((c) => !c.ok && c.code !== 'ACCOUNT_MISMATCH');
  if (broken.length) {
    findings.push({
      code: 'SKILL_INSTALL_MISSING',
      status: 'error',
      detail: `本机技能制品缺失或校验失败：${broken.map((c) => c.message || c.storageSkill).join('；')}。可重装固定版本。`,
    });
    if (!binding.trial) {
      repairActions.push({
        code: 'SKILL_INSTALL_MISSING',
        label: '重装绑定技能',
        detail: `重新安装 ${binding.title || binding.id}`,
        runnable: true,
        releaseId: binding.id,
      });
    }
  } else {
    findings.push({ code: 'SKILL_INSTALL_OK', status: 'ok', detail: `本机技能制品校验通过：${binding.title || binding.id} @ ${binding.version || ''}` });
  }
  if (skillResult && skillResult.status === 'failed') {
    findings.push({
      code: 'SKILL_OUTPUT_FAILED',
      status: 'error',
      detail: `Skill 结构/回执检查未通过：${(skillResult.missing || []).join('；') || '执行未完成'}。请继续对话核实原任务，勿整轮重跑。`,
    });
    repairActions.push({
      code: 'SKILL_OUTPUT_FAILED',
      label: '仅报告',
      detail: '不自动重跑外部任务',
      runnable: false,
    });
  }
  if (binding.account && checks.some((c) => c.code === 'ACCOUNT_MISMATCH')) {
    findings.push({ code: 'SKILL_BINDING_STALE', status: 'error', detail: '技能绑定所属账号与当前不一致，请解除绑定后重选。' });
    repairActions.push({
      code: 'SKILL_BINDING_STALE',
      label: '解除技能绑定',
      detail: '清除本对话的技能绑定，不删除本机安装包',
      runnable: true,
      needsConfirm: true,
    });
  }
  const status = findings.some((f) => f.status === 'error') ? 'error' : findings.some((f) => f.status === 'ok') ? 'ok' : 'info';
  return {
    findings,
    repairActions,
    segment: { id: 'skill', label: 'Skill 与脚本', status, detail: binding.title || binding.id },
  };
}

/** 拼装最后一轮全链路时间线。 */
export function buildTimeline({
  accountOk,
  platformFinding,
  kernelSegment,
  message,
  records = [],
  skillSegment,
  hasArtifact,
  artifactError = '',
}) {
  const timeline = [];
  timeline.push({
    id: 'account',
    label: '账号与桥接',
    status: accountOk ? 'ok' : 'error',
    detail: accountOk ? '当前账号有效' : '未登录或会话无效',
  });
  if (platformFinding) {
    timeline.push({
      id: 'platform',
      label: '平台会话',
      status: platformFinding.status === 'ok' ? 'ok' : 'error',
      detail: platformFinding.detail,
    });
  }
  if (kernelSegment) timeline.push(kernelSegment);
  if (!message) {
    timeline.push({ id: 'reply', label: '助手回复', status: 'skipped', detail: '尚无助手回复' });
    return timeline;
  }
  const retrieval = message.retrievalStatus;
  if (retrieval === 'unavailable') timeline.push({ id: 'retrieval', label: '项目检索', status: 'error', detail: '资料目录不可用' });
  else if (['no-match', 'limited'].includes(retrieval)) timeline.push({ id: 'retrieval', label: '项目检索', status: 'warn', detail: '未找到或仅有限片段' });
  else if (retrieval) timeline.push({ id: 'retrieval', label: '项目检索', status: 'ok', detail: `状态 ${retrieval}` });
  else timeline.push({ id: 'retrieval', label: '项目检索', status: 'skipped', detail: '本轮未检索项目' });

  const modelStatus = message.state === 'done' ? 'ok' : ['error', 'cancelled', 'interrupted'].includes(message.state) ? 'error' : 'warn';
  timeline.push({
    id: 'model',
    label: '模型流式回复',
    status: modelStatus,
    detail: message.state + (message.error ? ` · ${message.error}` : ''),
  });

  if (records.length) {
    const failed = records.filter((s) => failedReceipts(s).length).length;
    timeline.push({
      id: 'tools',
      label: '应用 / 工具回执',
      status: failed ? 'error' : 'ok',
      detail: `${records.length} 条回执${failed ? `，${failed} 条失败` : ''}`,
    });
  } else {
    timeline.push({ id: 'tools', label: '应用 / 工具回执', status: 'skipped', detail: '无应用执行回执' });
  }

  if (skillSegment) timeline.push(skillSegment);

  if (artifactError) timeline.push({ id: 'artifact', label: '文档落盘', status: 'error', detail: artifactError });
  else if (hasArtifact) timeline.push({ id: 'artifact', label: '文档落盘', status: 'ok', detail: '已有对话文档' });
  else timeline.push({ id: 'artifact', label: '文档落盘', status: 'skipped', detail: '本轮无文档产物' });

  const activities = message.activities || [];
  if (activities.length) {
    const bad = activities.filter((a) => ['error', 'interrupted', 'running'].includes(a.state)).length;
    timeline.push({
      id: 'activities',
      label: '活动步骤',
      status: bad ? 'warn' : 'ok',
      detail: `${activities.length} 步${bad ? `，${bad} 步异常或待校正` : ''}`,
    });
  }
  return timeline;
}

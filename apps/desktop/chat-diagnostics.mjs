import {mediaTaskState} from './media-task-state.mjs';
const failedReceipts = step => [step.result,step.result?.account,step.result?.current].filter(r=>r?.ok===false);

/** Diagnostic conclusions use persisted host evidence, never model guesses. */
export function serviceRecoveryText(steps) {
  if (!steps.length) return '';
  const failed = steps.filter(s => failedReceipts(s).length).length;
  // 步骤明细只在右侧「自动工作流」展示，聊天区只保留可核验的摘要指针。
  return `本轮回复未完成，已恢复 ${steps.length} 条应用执行记录（${failed} 条明确返回失败）。\n\n` +
    '过程与回执见右侧「自动工作流」。继续对话时先查询已有任务状态，避免重复提交。';
}

/** 历史消息若仍含逐步清单，展示时折叠，避免与右侧栏重复。 */
export function compactServiceChatText(content = '') {
  const text = String(content || '');
  if (!text.trim()) return '';
  const match = text.match(/本轮回复未完成，已恢复 (\d+) 条应用执行记录（(\d+) 条明确返回失败）/);
  if (match && /^- 步骤 \d+ ·/m.test(text)) {
    return `本轮回复未完成，已恢复 ${match[1]} 条应用执行记录（${match[2]} 条明确返回失败）。\n\n过程与回执见右侧「自动工作流」。继续对话时先查询已有任务状态，避免重复提交。`;
  }
  return text.replace(/\n*- 步骤 \d+ ·[^\n]*/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function analyzeChat(message, steps = [], task = mediaTaskState(steps)) {
  const findings = [];
  if (!message) return [{code:'NO_REPLY',status:'info',detail:'当前对话尚无助手回复，请先发起任务。'}];
  const error = message.error || '';
  if (/Harness 子进程未回收/.test(error)) findings.push({code:'HARNESS_CLEANUP',status:'error',detail:'上次执行在 Harness 退出检查阶段失败。已加入有上限的退出等待；历史记录不能证明进程当前仍残留。若再次发生，需进一步检查运行环境。'});
  if (/应用服务目录无效|不接受本机服务目录/.test(error)) findings.push({code:'SERVICE_CATALOG_REJECTED',status:'error',detail:`平台拒绝了本机服务目录：${error}。平台版本与桌面端能力不一致时，目录里的网页/应用类型会被整体拒绝，导致整轮对话无回复。需更新平台服务，或让桌面端按平台能力裁剪目录。`});
  if (['error','cancelled','interrupted'].includes(message.state)) findings.push({code:'REPLY_INCOMPLETE',status:'error',detail:`上次回复未完成：${error || message.state}。`});
  if (!message.content.trim()) findings.push({code:'EMPTY_REPLY',status:'error',detail:'回复正文为空。可从已保存的应用回执恢复执行摘要；摘要不代表原任务完成。'});
  const failed = steps.filter(s => failedReceipts(s).length);
  const lastScope=steps.findLastIndex(s=>failedReceipts(s).some(r=>r.error?.reason==='oauth_scope_insufficient'));
  const authRestored=steps.slice(lastScope+1).some(s=>s.request?.action==='discover'&&s.result?.ok&&s.result?.account?.ok&&s.result?.current?.ok);
  if(lastScope>=0&&!authRestored) findings.push({code:'DREAMINA_AUTH_SCOPE',status:task.status==='delivered'?'warn':'error',detail:'即梦服务端历史回执确认 OAuth 授权范围不足；本地显示已登录不能证明服务可用。需要重新授权，然后验证服务端账号与原画布读取，再恢复原任务，不能重复生成。'});
  if (failed.length) findings.push({code:'SERVICE_FAILED',status:'error',detail:`${failed.length} 条应用回执明确返回失败。请在操作面板查看参数、权限或服务返回原因，并先核实已有任务状态。`});
  if (message.retrievalStatus === 'unavailable') findings.push({code:'PROJECT_UNAVAILABLE',status:'error',detail:'上次项目资料目录不可用，请检查目录是否存在及访问权限。'});
  else if (['no-match','limited'].includes(message.retrievalStatus)) findings.push({code:'SEARCH_NO_MATCH',status:'info',detail:'项目检索未找到相关片段，属于检索结果，不是任务链路故障。'});
  const issueStatus=task.status==='delivered'?'warn':'error';
  const failures=failed.flatMap(failedReceipts);
  if(failures.some(r=>r.error?.validation?.reasonCode==='CLI_NODE_ID_INVALID'))findings.push({code:'CLI_NODE_ID_INVALID',status:issueStatus,detail:'历史步骤的节点 ID 不符合 CLI 规范。宿主已改为生成10位 Crockford Base32 ID；已有节点与提交保持原身份，不重新生成。'});
  if(failures.some(r=>/终端请求需要有效的 command/.test(r.message||'')))findings.push({code:'LOCAL_TOOL_ARGUMENTS',status:issueStatus,detail:'终端参数结构错误：应使用顶层 action、command、cwd、timeoutMs，不能把 command 放入 args。'});
  if(failures.some(r=>/未声明该参数/.test(r.message||'')||/^cli\.(invalid_command|unexpected_argument)$/.test(r.error?.code||'')))findings.push({code:'CLI_ARGUMENT_INVALID',status:issueStatus,detail:'CLI 参数校验失败。请使用 discover 返回的参数定义；布尔开关不追加 true，不重复提交相同错误参数。'});
  if(/网关返回 502/.test(error))findings.push({code:'HARNESS_GATEWAY',status:issueStatus,detail:'推理网关返回502；先恢复已有成果或查询原提交状态。仅凭本机日志无法确定远端服务根因。'});
  if(/步骤达到上限/.test(error))findings.push({code:'MODEL_STEP_LIMIT',status:issueStatus,detail:'推理步骤已用尽。先恢复已有成果或查询原提交，不整轮重新生成。'});
  if(task.status==='delivered'){
    for(const f of findings){
      if(f.code==='REPLY_INCOMPLETE'){f.status='warn';f.detail='原始回复曾中断；图片成果已恢复，历史执行状态保留。';}
      if(f.code==='SERVICE_FAILED'){f.status='warn';f.detail='历史步骤有失败回执；后续图片生成与本机交付已确认。';}
      if(f.code==='HARNESS_CLEANUP'){f.status='warn';f.detail='历史执行曾出现 Harness 退出异常；已有图片已恢复，历史记录不能证明当前仍有进程残留。';}
    }
    findings.push({code:'MEDIA_DELIVERED',status:'ok',detail:task.detail});
  }else if(task.status==='generated')findings.push({code:'MEDIA_DELIVERY',status:'error',detail:'图片已生成成功，但预览或交付未完成。可恢复本机文件或补下载原资源，无需重新生成。'});
  else if(task.status==='pending')findings.push({code:'MEDIA_PENDING',status:'warn',detail:task.detail});
  else if(task.status==='failed')findings.push({code:'MEDIA_GENERATION_FAILED',status:'error',detail:task.detail+' 如需重新生成，应重新取得生成及积分授权。'});
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
  task,
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
  if(task&&(task.images.length||task.operations.length))timeline.push({id:'media',label:'图片生成与交付',status:task.status==='delivered'?'ok':task.status==='generated'||task.status==='failed'?'error':'warn',detail:task.detail});

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

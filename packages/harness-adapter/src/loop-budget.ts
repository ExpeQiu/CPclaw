/** Reserve model calls for a useful answer before the host's hard stop. */
export function serviceModelBudget(value = process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT) {
  const limit = value === undefined ? 24 : Number(value);
  if ((value !== undefined && !/^\d+$/.test(value)) || !Number.isSafeInteger(limit) || limit < 5) {
    throw new Error("CPCLAW_SERVICE_MODEL_CALL_LIMIT 必须为至少 5 的安全整数");
  }
  return { limit, wrapUpAt: limit - 4, finalOnlyAt: limit - 2 };
}

export function prepareServiceCompletion(body: unknown, modelCalls: number, budget = serviceModelBudget()): unknown {
  if (modelCalls < budget.wrapUpAt || !body || typeof body !== 'object') return body;
  const request = body as Record<string, unknown>;
  if (!Array.isArray(request.messages)) return body;
  const finalOnly = modelCalls >= budget.finalOnlyAt;
  const prepared = { ...request, messages: [...request.messages, {
    role: 'system',
    content: finalOnly
      ? '本轮已进入收尾阶段，工具已关闭。请立即依据已有回执回答用户，说明已确认的结论、未完成项和必要的后续步骤。不得声称未验证的成功，不得重新提交生成或写入任务。'
      : `本轮模型调用仅剩 ${budget.limit - modelCalls} 次。请停止扩展检索范围，优先依据已有回执完成回答；仅在核实当前任务状态确有必要时调用工具。`,
  }] } as Record<string, unknown>;
  if (finalOnly) {
    delete prepared.tools;
    delete prepared.tool_choice;
    delete prepared.parallel_tool_calls;
    delete prepared.functions;
    delete prepared.function_call;
  }
  return prepared;
}

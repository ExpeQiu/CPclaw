/** 回复底部操作：何时提供「提炼 Skill」、结果是否足够充实。 */

export const MIN_DISTILL_ROUNDS = 2;
export const MIN_PLAIN_RESULT_CHARS = 800;

export function chatUserRounds(messages = []) {
  return messages.filter((message) => message?.role === "user").length;
}

export function hasSubstantialResult(message, { stepCount = 0 } = {}) {
  const text = String(message?.content ?? "").trim();
  const steps = Number(stepCount) || 0;
  const hasService = Boolean(message?.hasServiceSteps) || steps > 0;
  if (message?.skillResult?.status === "passed") return true;
  // 有真实应用回执即视为充实；纯对话需足够长的正文。
  if (hasService) return steps >= 1 || text.length > 0;
  return text.length >= MIN_PLAIN_RESULT_CHARS;
}

/** 多轮对话且结果较充实时，才提供提炼 Skill。 */
export function canOfferSkillDistill(messages, message, options = {}) {
  if (!message || message.role !== "assistant" || message.state !== "done") return false;
  if (chatUserRounds(messages) < MIN_DISTILL_ROUNDS) return false;
  return hasSubstantialResult(message, options);
}

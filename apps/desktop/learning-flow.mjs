/** 桌面学习授权。默认关闭；只判断能否提交抽象候选，不读取屏幕或工作目录。 */

export function defaultLearningGrant() {
  return {
    enabled: false,
    autoSubmit: false,
    paused: false,
    kinds: ["experience"],
    excludes: [],
    includeHistory: false,
    expiresAt: null,
    budget: 0,
    spent: 0,
  };
}

/**
 * 判断当前任务能否自动提交学习候选。
 * @param grant 本地授权
 * @param taskId 任务标识
 * @param now 当前时间毫秒
 * @returns 允许时 ok，否则给出原因
 */
export function canCaptureLearning(grant, taskId, now) {
  if (!grant?.enabled || !grant.autoSubmit) return { ok: false, reason: "学习授权默认关闭" };
  if (grant.paused) return { ok: false, reason: "学习已暂停" };
  if (typeof grant.expiresAt === "number" && now > grant.expiresAt) return { ok: false, reason: "学习授权已过期" };
  if (Array.isArray(grant.excludes) && grant.excludes.includes(taskId)) return { ok: false, reason: "该任务已排除" };
  if (!Number.isInteger(grant.budget) || grant.budget < 1 || grant.spent >= grant.budget) return { ok: false, reason: "学习预算已用完" };
  const kind = Array.isArray(grant.kinds) ? grant.kinds.find((item) => item === "experience" || item === "memory" || item === "skill") : undefined;
  if (!kind) return { ok: false, reason: "未选择候选类型" };
  return { ok: true, kind };
}

/**
 * 从验收结果提炼可上传的短候选，不带入文件正文。
 * @param input 任务标识、标题和结果摘要
 * @param kind 候选类型
 * @returns 平台提交字段
 */
export function abstractLearningCandidate(input, kind) {
  const title = String(input.title || "已验收工作").replace(/\s+/g, " ").trim().slice(0, 80);
  const outcome = String(input.outcome || "已接受审阅结果").replace(/\s+/g, " ").trim().slice(0, 400);
  return {
    kind,
    title: title || "已验收工作",
    body: `来源任务 ${input.taskId}。摘要：${outcome}。不含原文与目录。`,
    sourceTaskId: String(input.taskId),
  };
}

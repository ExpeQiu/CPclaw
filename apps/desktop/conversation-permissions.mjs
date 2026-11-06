const modes = new Set(['ask', 'auto', 'full']);
const keyOf = c => JSON.stringify([c.actorId, c.chatId]);
/** Permissions are chosen by the user through trusted IPC and live for this app session. */
export function createConversationPermissions() {
  const entries = new Map();
  return {
    get(context) { return context.actorId && context.chatId ? {...(entries.get(keyOf(context)) ?? {mode:'auto',revision:0})} : {mode:'auto',revision:0}; },
    set(context, mode) {
      if (!context.actorId || !context.chatId) throw Error('请先选择已登录账号的对话');
      if (!modes.has(mode)) throw Error('无效的对话权限模式');
      const prior=this.get(context);
      const next={mode,revision:prior.revision+1};entries.set(keyOf(context),next);return {...next};
    },
    clearActor(actorId) { for(const key of entries.keys())if(JSON.parse(key)[0]===actorId)entries.delete(key); },
  };
}
const sandboxRisks = new Set(['read', 'preferred', 'workspace', 'external-read']);
const boundaryRisks = new Set(['write', 'external-write', 'network', 'unknown']);
/** Codex 三档：请求批准与帮我批准同为工作区可写；完全访问不再逐次询问。积分与 forceApproval 不在此放行。 */
export function canAutoApprove(permission, risk, cost = 0) {
  if (cost !== 0) return permission?.mode === 'full';
  if (permission?.mode === 'full') return true;
  if (risk === 'unsafe') return false;
  if (sandboxRisks.has(risk)) return permission?.mode === 'ask' || permission?.mode === 'auto';
  if (boundaryRisks.has(risk)) return permission?.mode === 'auto';
  return false;
}

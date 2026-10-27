const modes = new Set(['ask', 'auto', 'full']);
const keyOf = c => JSON.stringify([c.actorId, c.chatId]);
/** Permissions are chosen by the user through trusted IPC and live for this app session. */
export function createConversationPermissions() {
  const entries = new Map();
  return {
    get(context) { return context.actorId && context.chatId ? {...(entries.get(keyOf(context)) ?? {mode:'ask',revision:0})} : {mode:'ask',revision:0}; },
    set(context, mode) {
      if (!context.actorId || !context.chatId) throw Error('请先选择已登录账号的对话');
      if (!modes.has(mode)) throw Error('无效的对话权限模式');
      const prior=this.get(context);
      const next={mode,revision:prior.revision+1};entries.set(keyOf(context),next);return {...next};
    },
    clearActor(actorId) { for(const key of entries.keys())if(JSON.parse(key)[0]===actorId)entries.delete(key); },
  };
}
export function canAutoApprove(permission, risk, cost = 0) {
  return cost===0 && (permission.mode==='full' || permission.mode==='auto' && risk==='read');
}

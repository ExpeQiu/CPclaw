// 授权保存在宿主内存中；前端不能提交“已批准”标记来绕过系统弹窗。
export function createCommandAuthorization({ getContext, getPlan, requestApproval, execute }) {
  let grant = null, revision = 0, busy = false, controller;
  const contextKey = () => JSON.stringify(getContext());
  function revoke() { grant = null; revision++; controller?.abort(); }
  function status() {
    const context = getContext();
    return { remembered: Boolean(context.chatId && grant?.context === contextKey() && grant.revision === revision) };
  }
  async function run() {
    if (busy) return { ok: false, state: 'busy', message: '已有本机执行请求正在等待授权或执行。' };
    busy = true;
    const startRevision = revision, context = getContext(), key = contextKey();
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const plan = getPlan();
      if (!plan) return { ok: true, state: 'missing', message: '未发现即梦 CLI，请先完成获准的安装。' };
      const assertCurrent = () => {
        if (signal.aborted || revision !== startRevision || key !== contextKey()) throw Error('context_changed');
        if (plan.fingerprint !== getPlan()?.fingerprint) throw Error('command_changed');
      };
      const remembered = status().remembered && grant?.fingerprint === plan.fingerprint;
      if (!remembered) {
        grant = null;
        const choice = await requestApproval(plan, { canRemember: Boolean(context.actorId && context.chatId), signal });
        assertCurrent();
        if (!['once', 'conversation'].includes(choice)) return { ok: false, state: 'denied', message: '未授权，本机命令未执行。' };
        if (choice === 'conversation') {
          if (!context.actorId || !context.chatId) return { ok: false, state: 'denied', message: '请先选择对话；当前仅支持本次授权。' };
          grant = { context: key, fingerprint: plan.fingerprint, revision };
        }
      }
      assertCurrent();
      const result = await execute({ signal, beforeExecute: assertCurrent });
      assertCurrent();
      return { ...result, authorization: status() };
    } catch (error) {
      grant = null;
      if (signal.aborted || key !== contextKey() || startRevision !== revision) return { ok: false, state: 'cancelled', message: '授权已失效，已停止后续命令。' };
      if (error.message === 'command_changed') return { ok: false, state: 'denied', message: '命令或 CLI 程序已变化，请重新授权。' };
      return { ok: false, state: 'error', message: '无法执行本机检查，请重试。' };
    } finally { busy = false; controller = undefined; }
  }
  return { run, revoke, status };
}

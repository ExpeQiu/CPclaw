/** 流式请求按无数据时长超时，同时保留总运行上限；调用方必须 dispose。 */
export function createStreamDeadline(input: { signal: AbortSignal; idleMs: number; totalMs?: number; label: string }): {
  signal: AbortSignal; touch(): void; dispose(): void;
} {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const totalMs = input.totalMs ?? 300_000;
  let idle: ReturnType<typeof setTimeout>;
  const abort = (message: string): void => controller.abort(new DOMException(message, 'TimeoutError'));
  const touch = (): void => {
    clearTimeout(idle);
    if (!signal.aborted) idle = setTimeout(() => abort(`${input.label}连续 ${Math.round(input.idleMs / 1000)} 秒未返回数据，已保留收到的内容，请重试。`), input.idleMs);
  };
  const total = setTimeout(() => abort(`${input.label}已达到 ${Math.round(totalMs / 60000)} 分钟运行上限，已保留收到的内容，请缩短问题后重试。`), totalMs);
  touch();
  return { signal, touch, dispose() { clearTimeout(idle); clearTimeout(total); } };
}

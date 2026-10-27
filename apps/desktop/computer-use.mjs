import { createHash } from 'node:crypto';

export const browserPageService = { id: 'browser-page', title: '原生页面 · Computer Use', type: 'WEB', target: 'browser-page', builtin: true, kind: 'computer-use' };

export const SENSITIVE_RE = /login|sign[\s_-]?in|oauth|\bauth\b|pay(ment)?|checkout|billing|subscribe|密码|登录|登入|支付|收银台|充值|购买|订阅/i;
const SENSITIVE_QUERY = /token|sign|auth|code|credential/i;
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'slider', 'spinbutton']);

export function isSensitiveText(text = '') {
  return SENSITIVE_RE.test(String(text));
}

export function isSensitiveUrl(url) {
  try {
    const u = new URL(url);
    return isSensitiveText(`${u.hostname}${u.pathname}${u.search}${u.hash}`);
  } catch {
    return false;
  }
}

export function isPasswordField(node = {}) {
  const role = String(node.role || '').toLowerCase();
  const name = String(node.name || node.description || '');
  return role === 'textbox' && (/password|密码/i.test(name) || node.sensitive === true);
}

/** 服务可打开的原生页 origin 列表；无页面入口时返回空数组。 */
export function pageOriginsForService(service) {
  if (!service) return [];
  if (service.id === 'dreamina' && service.builtin === true) return ['https://jimeng.jianying.com'];
  if (service.id === browserPageService.id && service.builtin === true) return [];
  const origins = [];
  const push = value => {
    try {
      const u = new URL(value);
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return;
      if (!origins.includes(u.origin)) origins.push(u.origin);
    } catch { /* ignore */ }
  };
  if (Array.isArray(service.pageOrigins)) for (const o of service.pageOrigins) push(o);
  if (typeof service.pageUrl === 'string') push(service.pageUrl);
  if ((service.type === 'MCP' || service.type === 'WEB') && typeof service.target === 'string') push(service.target);
  return origins;
}

export function hasPageEntry(service) {
  return pageOriginsForService(service).length > 0 || (service?.id === browserPageService.id && service?.builtin === true);
}

export function partitionForOrigins(origins = []) {
  const key = (origins[0] || 'empty').toLowerCase();
  return `persist:cpclaw-native-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

export function validatePageUrl(input, origins = []) {
  if (typeof input !== 'string' || !input) return { ok: false, message: '页面地址无效' };
  let u;
  try { u = new URL(input); } catch { return { ok: false, message: '页面地址无效' }; }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.hash) return { ok: false, message: '页面地址无效' };
  if ([...u.searchParams.keys()].some(k => SENSITIVE_QUERY.test(k))) return { ok: false, message: '页面地址含敏感查询参数' };
  if (origins.length && !origins.includes(u.origin)) return { ok: false, message: '地址不在当前服务允许源内', origin: u.origin, sensitive: isSensitiveUrl(u.href) };
  return { ok: true, href: u.href, origin: u.origin, sensitive: isSensitiveUrl(u.href) };
}

function axValue(node, name) {
  const props = node?.properties || node?.props || [];
  if (Array.isArray(props)) {
    const hit = props.find(p => p?.name === name || p?.name?.value === name);
    if (!hit) return undefined;
    return hit.value?.value ?? hit.value;
  }
  return node?.[name];
}

/** 将 CDP Accessibility.getFullAXTree 压缩为带 ref 的可操作节点。 */
export function compressAxTree(nodes = [], { limit = 120 } = {}) {
  const byBackend = new Map();
  for (const n of nodes) {
    const id = n.nodeId ?? n.id;
    if (id != null) byBackend.set(id, n);
  }
  const out = [];
  const index = new Map();
  let ref = 0;
  for (const n of nodes) {
    if (out.length >= limit) break;
    const role = String(axValue(n, 'role') ?? n.role ?? '').toLowerCase();
    const name = String(axValue(n, 'name') ?? n.name ?? '').trim();
    const ignored = axValue(n, 'ignored') === true || n.ignored === true;
    if (ignored || !role || role === 'none' || role === 'generic' && !name) continue;
    const interactive = INTERACTIVE.has(role) || Boolean(name) && ['heading', 'image', 'text', 'listitem', 'cell', 'row'].includes(role);
    if (!interactive && !['document', 'webview', 'RootWebArea', 'rootwebarea'].includes(role)) continue;
    if (['document', 'webview', 'rootwebarea'].includes(role) && !name) continue;
    const id = `e${++ref}`;
    const entry = {
      ref: id,
      role,
      name: name.slice(0, 120),
      backendDOMNodeId: n.backendDOMNodeId ?? n.backendNodeId,
      nodeId: n.nodeId ?? n.id,
      sensitive: isSensitiveText(`${role} ${name}`) || isPasswordField({ role, name }),
    };
    if (isPasswordField({ role, name })) entry.password = true;
    out.push(entry);
    index.set(id, entry);
  }
  return { nodes: out, index };
}

export function classifyAction(request = {}, node) {
  const action = request.action;
  if (action === 'discover' || action === 'snapshot' || action === 'wait') return { risk: 'read', sensitive: false };
  if (action === 'open' || action === 'reload') {
    const url = request.url || '';
    const sensitive = isSensitiveUrl(url) || isSensitiveText(request.purpose || '');
    return { risk: 'unknown', sensitive };
  }
  if (node?.password || node?.sensitive || isSensitiveText(node?.name) || isSensitiveText(request.text || '') || isSensitiveText(request.purpose || '')) {
    return { risk: 'unknown', sensitive: true };
  }
  return { risk: 'unknown', sensitive: false };
}

/**
 * @param {{ page: object, authorize: Function, signal: AbortSignal, request: object, allowedOrigins?: string[] }} options
 */
export async function executeComputerUse({ page, authorize, signal, request, allowedOrigins = [] }) {
  signal.throwIfAborted();
  if (!request || typeof request !== 'object') throw Error('请求无效');
  if (request.action === 'discover') {
    return {
      ok: true,
      service: browserPageService.id,
      capabilities: [
        { action: 'open', fields: ['url?', 'purpose?'], description: '打开当前服务允许源内的页面；省略 url 时打开默认首页' },
        { action: 'reload', fields: [], description: '刷新当前原生页' },
        { action: 'snapshot', fields: [], description: '读取可访问树，返回带 ref 的可操作节点' },
        { action: 'click', fields: ['ref', 'purpose?'], description: '点击 snapshot 返回的 ref' },
        { action: 'type', fields: ['ref', 'text', 'purpose?'], description: '在文本框 ref 中输入；密码框需登录确认' },
        { action: 'scroll', fields: ['ref?', 'dy?', 'dx?'], description: '滚动页面或节点' },
        { action: 'press', fields: ['key', 'ref?'], description: '发送按键，如 Enter、Tab、Escape' },
        { action: 'wait', fields: ['ms?'], description: '等待页面稳定，默认 800ms，最大 10000ms' },
      ],
      note: '登录、支付或密码输入会强制请求用户确认；不要声称已登录或已付款。',
    };
  }

  const actions = new Set(['open', 'reload', 'snapshot', 'click', 'type', 'scroll', 'press', 'wait']);
  if (!actions.has(request.action)) throw Error('不支持的原生页操作');

  let node;
  if (['click', 'type', 'scroll', 'press'].includes(request.action) && request.ref) {
    node = page.resolveRef?.(request.ref);
    if (!node && request.action !== 'scroll' && request.action !== 'press') throw Error('未知 ref，请先 snapshot');
  }
  if (request.action === 'type' && (typeof request.text !== 'string' || request.text.length > 8000 || request.text.includes('\0'))) {
    throw Error('输入文本无效');
  }

  const verdict = classifyAction(request, node);
  let origins = allowedOrigins.length ? [...allowedOrigins] : [...(page.getOrigins?.() || [])];
  if (request.action === 'open') {
    if (!origins.length) throw Error('当前没有允许源。请先在右侧打开已绑定服务的原生页，或对具备 pageUrl 的服务执行操作。');
    const target = request.url || page.defaultUrl?.(origins) || `${origins[0]}/`;
    let checked = validatePageUrl(target, origins);
    if (!checked.ok && checked.sensitive && checked.origin) {
      await authorize({
        forceApproval: true,
        risk: 'unknown',
        title: '登录或支付确认',
        message: '原生页需要打开登录或支付相关地址，请确认后继续。',
        detail: `目标：${target}\n原因：${checked.message}\n确认后仅将此源加入当前任务的临时允许列表，不会代填密码或支付凭据。`,
      });
      page.allowOrigin?.(checked.origin);
      origins = [...new Set([...origins, checked.origin])];
      checked = validatePageUrl(target, origins);
    }
    if (!checked.ok) throw Object.assign(Error(checked.message), { code: 'DENIED' });
    const sensitive = checked.sensitive || verdict.sensitive;
    await authorize({
      forceApproval: sensitive,
      risk: sensitive ? 'unknown' : verdict.risk,
      title: sensitive ? '登录或支付确认' : '原生页操作授权',
      message: sensitive ? '即将打开登录或支付相关页面，请确认。' : (request.purpose || '打开原生页面'),
      detail: `操作：open\n地址：${checked.href}\n允许源：${origins.join(', ')}`,
    });
    signal.throwIfAborted();
    return sanitizeComputerResult(await page.open(checked.href));
  }

  const detailLines = [
    `操作：${request.action}`,
    request.ref ? `ref：${request.ref}` : '',
    node ? `控件：${node.role} ${node.name || ''}`.trim() : '',
    request.text != null ? `文本长度：${String(request.text).length}` : '',
    request.key ? `按键：${request.key}` : '',
    `当前页：${page.getUrl?.() || '（未打开）'}`,
  ].filter(Boolean);

  await authorize({
    forceApproval: verdict.sensitive,
    risk: verdict.risk,
    title: verdict.sensitive ? '登录或支付确认' : '原生页操作授权',
    message: verdict.sensitive
      ? '即将在原生页执行登录或支付相关操作，请确认。宿主不会代填密码或支付凭据。'
      : (request.purpose || `执行原生页 ${request.action}`),
    detail: detailLines.join('\n'),
  });
  signal.throwIfAborted();

  if (request.action === 'reload') return sanitizeComputerResult(await page.reload());
  if (request.action === 'snapshot') return sanitizeComputerResult(await page.snapshot());
  if (request.action === 'click') return sanitizeComputerResult(await page.click(request.ref));
  if (request.action === 'type') return sanitizeComputerResult(await page.type(request.ref, request.text));
  if (request.action === 'scroll') return sanitizeComputerResult(await page.scroll(request.ref, request.dx ?? 0, request.dy ?? 400));
  if (request.action === 'press') return sanitizeComputerResult(await page.press(request.key, request.ref));
  if (request.action === 'wait') {
    const ms = request.ms ?? 800;
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 10_000) throw Error('等待时间为 0–10000 毫秒');
    return sanitizeComputerResult(await page.wait(ms, signal));
  }
  throw Error('不支持的原生页操作');
}

export function sanitizeComputerResult(value) {
  if (Array.isArray(value)) return value.map(sanitizeComputerResult);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => !/token|secret|password|authorization|cookie|credential/i.test(k))
      .map(([k, v]) => [k, sanitizeComputerResult(v)]));
  }
  if (typeof value === 'string') return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return value;
}

/**
 * 基于 Electron webContents 的原生页控制器。
 * @param {{ getView: () => any, ensureView: (origins: string[], url?: string) => Promise<any>, send?: Function }} deps
 */
export function createNativePageController({ getView, ensureView, send = () => {} }) {
  let origins = [];
  let lastIndex = new Map();
  let debuggerAttached = false;

  async function withDebugger(wc, fn) {
    if (!wc || wc.isDestroyed()) throw Error('原生页尚未打开');
    if (!debuggerAttached) {
      try { wc.debugger.attach('1.3'); } catch (e) {
        if (!/already attached/i.test(String(e?.message || e))) throw e;
      }
      debuggerAttached = true;
      wc.debugger.on('detach', () => { debuggerAttached = false; });
    }
    return fn(method => params => wc.debugger.sendCommand(method, params || {}));
  }

  async function boxForRef(wc, ref) {
    const node = lastIndex.get(ref);
    if (!node) throw Error('未知 ref，请先 snapshot');
    return withDebugger(wc, async sendCommand => {
      if (node.backendDOMNodeId) {
        try {
          const { model } = await sendCommand('DOM.getBoxModel')({ backendNodeId: node.backendDOMNodeId });
          const q = model?.content || model?.border;
          if (q?.length >= 8) {
            const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
            return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, node };
          }
        } catch { /* fall through */ }
      }
      const { nodes } = await sendCommand('Accessibility.getFullAXTree')({});
      const match = (nodes || []).find(n => (n.nodeId ?? n.id) === node.nodeId || n.backendDOMNodeId === node.backendDOMNodeId);
      if (!match) throw Error('页面上找不到该控件，请重新 snapshot');
      throw Error('无法定位控件坐标，请重新 snapshot');
    });
  }

  function clickPoint(wc, x, y) {
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  }

  return {
    getOrigins: () => [...origins],
    allowOrigin(origin) {
      if (typeof origin === 'string' && origin && !origins.includes(origin)) origins = [...origins, origin];
    },
    setOrigins(next) { origins = [...new Set(next || [])]; },
    defaultUrl(list = origins) { return list[0] ? `${list[0]}/` : ''; },
    getUrl() {
      const view = getView();
      if (!view || view.webContents.isDestroyed()) return '';
      return view.webContents.getURL();
    },
    resolveRef(ref) { return lastIndex.get(ref); },
    async open(url) {
      const checked = validatePageUrl(url, origins.length ? origins : undefined);
      const href = checked.ok ? checked.href : url;
      if (checked.ok && !origins.includes(checked.origin)) origins = [...origins, checked.origin];
      if (!origins.length) {
        try { origins = [new URL(href).origin]; } catch { /* ignore */ }
      }
      const view = await ensureView(origins, href);
      send({ state: 'loading', message: '正在加载原生页面…' });
      await view.webContents.loadURL(href);
      return { ok: true, url: view.webContents.getURL(), origins: [...origins] };
    },
    async reload() {
      const view = getView();
      if (!view || view.webContents.isDestroyed()) throw Error('原生页尚未打开');
      await view.webContents.reload();
      return { ok: true, url: view.webContents.getURL() };
    },
    async snapshot() {
      const view = getView();
      if (!view || view.webContents.isDestroyed()) throw Error('原生页尚未打开');
      const wc = view.webContents;
      const tree = await withDebugger(wc, async sendCommand => {
        try { await sendCommand('Accessibility.enable')({}); } catch { /* optional */ }
        return sendCommand('Accessibility.getFullAXTree')({});
      });
      const compressed = compressAxTree(tree.nodes || []);
      lastIndex = compressed.index;
      return {
        ok: true,
        url: wc.getURL(),
        title: wc.getTitle(),
        nodes: compressed.nodes.map(({ ref, role, name, sensitive, password }) => ({ ref, role, name, ...(sensitive ? { sensitive: true } : {}), ...(password ? { password: true } : {}) })),
      };
    },
    async click(ref) {
      const view = getView();
      const { x, y } = await boxForRef(view.webContents, ref);
      clickPoint(view.webContents, x, y);
      return { ok: true, ref, url: view.webContents.getURL() };
    },
    async type(ref, text) {
      const view = getView();
      const { x, y } = await boxForRef(view.webContents, ref);
      clickPoint(view.webContents, x, y);
      for (const ch of text) {
        view.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      }
      return { ok: true, ref, length: text.length };
    },
    async scroll(ref, dx, dy) {
      const view = getView();
      let x = 200, y = 200;
      if (ref) {
        try { ({ x, y } = await boxForRef(view.webContents, ref)); } catch { /* page scroll */ }
      }
      view.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: dx, deltaY: dy });
      return { ok: true, dx, dy };
    },
    async press(key, ref) {
      if (typeof key !== 'string' || !key || key.length > 40) throw Error('按键无效');
      const view = getView();
      if (ref) {
        const box = await boxForRef(view.webContents, ref);
        clickPoint(view.webContents, box.x, box.y);
      }
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
      return { ok: true, key };
    },
    async wait(ms, signal) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = () => { clearTimeout(timer); reject(Object.assign(Error('已取消'), { code: 'CANCELLED' })); };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const view = getView();
      return { ok: true, ms, url: view && !view.webContents.isDestroyed() ? view.webContents.getURL() : '' };
    },
  };
}

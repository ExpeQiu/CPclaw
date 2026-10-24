// 本地保存布局偏好；文档与普通设置面板分别记忆宽度。
(() => {
  const root = document.documentElement;
  const sidebar = document.querySelector('.sidebar');
  const inspector = document.getElementById('inspector');
  const structure = document.querySelector('.document-structure');
  const workArea = document.querySelector('.work-area');
  const storageKey = 'cpclaw.pane-widths.v1';
  const keys = ['sidebar', 'settings', 'documents', 'structure'];
  let widths = {};
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    for (const key of keys) if (Number.isFinite(saved?.[key]) && saved[key] > 0) widths[key] = saved[key];
  } catch { /* 存储不可用时仍可调整当前窗口。 */ }
  const documentsOpen = () => !document.getElementById('panel-documents').hidden;
  const expanded = () => documentsOpen() && document.body.classList.contains('document-expanded');
  function bounds(key) {
    const available = workArea.getBoundingClientRect().width;
    if (key === 'sidebar') return [160, Math.max(160, Math.min(420, innerWidth - 44 - 480))];
    if (key === 'structure') return [140, Math.max(140, Math.min(420, inspector.getBoundingClientRect().width - 320))];
    const overlay = getComputedStyle(inspector).position === 'absolute';
    return [Math.min(key === 'documents' ? 440 : 260, available), Math.max(0, available - (overlay || expanded() ? 0 : 300))];
  }
  function clamp(key, value) {
    const [min, max] = bounds(key);
    return Math.round(Math.max(Math.min(min, max), Math.min(max, value)));
  }
  function persist() { try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch {} }
  function apply(key, value) {
    widths[key] = clamp(key, value);
    root.style.setProperty(`--pane-${key}-width`, `${widths[key]}px`);
    if (key === 'sidebar') root.style.setProperty('--sidebar-width', `${widths[key]}px`);
  }
  const configs = [
    { name: 'sidebar', label: '聊天列表宽度', element: sidebar, key: () => 'sidebar', sign: 1 },
    { name: 'inspector', label: '右侧面板宽度', element: inspector, key: () => documentsOpen() ? 'documents' : 'settings', sign: -1 },
    { name: 'structure', label: '文件与大纲宽度', element: structure, key: () => 'structure', sign: -1 },
  ];
  for (const config of configs) {
    const handle = document.createElement('div');
    handle.className = 'pane-divider';
    handle.id = `pane-divider-${config.name}`;
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', config.label);
    handle.title = `${config.label}：拖动调整，双击恢复默认（方向键微调）`;
    document.body.append(handle);
    config.handle = handle;
    const reset = () => {
      const key = config.key();
      delete widths[key];
      root.style.removeProperty(`--pane-${key}-width`);
      if (key === 'sidebar') root.style.removeProperty('--sidebar-width');
      persist(); schedule();
    };
    handle.addEventListener('dblclick', reset);
    handle.addEventListener('keydown', event => {
      if (event.key === 'Home') { event.preventDefault(); reset(); return; }
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      apply(config.key(), config.element.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 10 : -10) * config.sign);
      persist(); schedule();
    });
    let drag;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { x: event.clientX, width: config.element.getBoundingClientRect().width, key: config.key() };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      document.body.classList.add('pane-resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag) return;
      apply(drag.key, drag.width + (event.clientX - drag.x) * config.sign);
      schedule();
    });
    const finish = () => {
      if (!drag) return;
      drag = null;
      handle.classList.remove('is-dragging');
      document.body.classList.remove('pane-resizing');
      persist();
    };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, finish);
  }
  let frame;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; update(); });
  }
  function update() {
    for (const key of keys) {
      if (widths[key] && (key === 'sidebar' || key === 'structure' && documentsOpen() || key === (documentsOpen() ? 'documents' : 'settings') && !inspector.hidden && !expanded())) apply(key, widths[key]);
    }
    for (const config of configs) {
      const rect = config.element.getBoundingClientRect();
      const hidden = !rect.width || !rect.height || config.name === 'inspector' && expanded();
      config.handle.hidden = hidden;
      if (hidden) continue;
      const key = config.key(), [min, max] = bounds(key);
      config.handle.style.cssText = `left:${(config.sign === 1 ? rect.right : rect.left) - 4}px;top:${rect.top}px;height:${rect.height}px`;
      config.handle.setAttribute('aria-valuemin', Math.min(min, max));
      config.handle.setAttribute('aria-valuemax', max);
      config.handle.setAttribute('aria-valuenow', Math.round(rect.width));
    }
  }
  new ResizeObserver(schedule).observe(document.body);
  const observer = new ResizeObserver(schedule);
  for (const element of [sidebar, inspector, structure, workArea]) observer.observe(element);
  new MutationObserver(schedule).observe(inspector, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  schedule();
})();

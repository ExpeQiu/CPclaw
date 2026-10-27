/** 拓展服务三类：Computer Use / 驱动应用 / CLI 三方。 */
export const SERVICE_KINDS = Object.freeze({
  computerUse: 'computer-use',
  appDriver: 'app-driver',
  cli: 'cli',
});

export const KIND_LABELS = Object.freeze({
  'computer-use': { title: 'Computer Use', blurb: '直接控制网页或桌面页面；登录与支付需请示' },
  'app-driver': { title: '驱动应用', blurb: '选定本地应用/项目文件夹，由代码层驱动并在右侧可见交互' },
  cli: { title: 'CLI 三方应用', blurb: '绑定本机 CLI 后按自动化流程驱动，如即梦画布' },
});

export function serviceKind(service) {
  if (!service) return SERVICE_KINDS.cli;
  if (service.kind === SERVICE_KINDS.computerUse || service.kind === SERVICE_KINDS.appDriver || service.kind === SERVICE_KINDS.cli) return service.kind;
  if (service.id === 'browser-page' || service.type === 'WEB') return SERVICE_KINDS.computerUse;
  if (service.type === 'MCP') return SERVICE_KINDS.computerUse;
  if (service.id === 'local-terminal' || service.type === 'APP') return SERVICE_KINDS.appDriver;
  return SERVICE_KINDS.cli;
}

export function kindMeta(kind) {
  return KIND_LABELS[kind] || KIND_LABELS.cli;
}

export function annotateService(service) {
  const kind = serviceKind(service);
  return { ...service, kind, kindLabel: kindMeta(kind).title };
}

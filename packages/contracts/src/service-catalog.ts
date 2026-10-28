/** 应用服务目录契约；平台与桌面端共用同一真源，避免白名单漂移导致对话全量失败。 */

/** 平台接受的应用服务类型。平台按此校验 `/v1/chat/stream` 的 serviceTools。 */
export const SERVICE_TYPES = ['CLI', 'MCP', 'WEB', 'APP'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/** 桌面端当前实现能产出的服务类型；用于与平台白名单求交集。 */
export const DESKTOP_SERVICE_TYPES = ['CLI', 'MCP', 'WEB', 'APP'] as const;

/** 服务目录项；字段与平台校验一致，避免长度或类型越界。 */
export type CatalogService = { id: string; title: string; type: string };

export const SERVICE_ID_MAX = 64;
export const SERVICE_TITLE_MAX = 100;
export const SERVICE_CATALOG_MAX = 30;

/** 平台侧校验：目录形状与类型白名单。返回 null 表示通过。 */
export function invalidCatalogReason(catalog: unknown, allowed: readonly string[] = SERVICE_TYPES): string | null {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return '服务目录形状无效';
  const c = catalog as { services?: unknown; activeId?: unknown };
  if (!Array.isArray(c.services) || c.services.length > SERVICE_CATALOG_MAX) return '服务目录列表无效';
  for (const value of c.services) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '服务项无效';
    const s = value as { id?: unknown; title?: unknown; type?: unknown };
    if (typeof s.id !== 'string' || s.id.length > SERVICE_ID_MAX) return '服务标识无效';
    if (typeof s.title !== 'string' || s.title.length > SERVICE_TITLE_MAX) return '服务名称无效';
    if (!allowed.includes(String(s.type))) return `服务类型不被平台接受：${String(s.type)}`;
  }
  if (typeof c.activeId !== 'string') return '当前服务无效';
  if (c.activeId !== '' && !c.services.some((value) => (value as { id?: unknown }).id === c.activeId)) return '当前服务不在目录中';
  return null;
}

/** 按平台能力裁剪服务目录：剔除平台不接受的类型，并修正 activeId。 */
export function fitCatalogToPlatform(
  services: readonly CatalogService[],
  activeId: string,
  allowed: readonly string[] = SERVICE_TYPES,
): { services: CatalogService[]; activeId: string; dropped: CatalogService[] } {
  const keep = services.filter((s) => allowed.includes(String(s.type)));
  const dropped = services.filter((s) => !allowed.includes(String(s.type)));
  const nextActive = keep.some((s) => s.id === activeId) ? activeId : '';
  return { services: keep, activeId: nextActive, dropped };
}

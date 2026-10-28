import { DESKTOP_SERVICE_TYPES, fitCatalogToPlatform } from "@cpclaw/contracts";

/**
 * 平台服务目录能力探测。
 *
 * 背景：平台对 `/v1/chat/stream` 的 serviceTools 做类型白名单校验，平台版本较旧时
 * 只接受 CLI/MCP。桌面端固定提供 browser-page（WEB）与本机拓展（APP），
 * 目录里一旦出现平台不接受的类型，整轮对话都会被 400 拒绝，表现为「应用服务目录无效」。
 * 这里以平台自报能力为准裁剪目录，桌面端不再假设平台一定是最新的。
 */

/** 能力缓存：同一平台地址只探测一次，避免每轮对话多一次 /health 请求。 */
const capabilityCache = new Map();

/** 平台未声明能力时的兼容口径：只发 CLI/MCP，任何平台都能接受。 */
export const FALLBACK_SERVICE_TYPES = ['CLI', 'MCP'];

export function clearPlatformCapabilityCache() {
  capabilityCache.clear();
}

/**
 * 读取平台接受的服务类型。
 * @returns {Promise<{types: string[], declared: boolean}>} declared=false 表示平台未声明能力，已按最保守口径回落
 */
export async function fetchServiceTypes(base, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const origin = String(base || '').replace(/\/$/, '');
  if (!origin) return { types: [...FALLBACK_SERVICE_TYPES], declared: false };
  const cached = capabilityCache.get(origin);
  if (cached) return cached;
  let result = { types: [...FALLBACK_SERVICE_TYPES], declared: false };
  try {
    const response = await fetchImpl(`${origin}/health`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(body?.serviceTypes) && body.serviceTypes.length) {
      const types = body.serviceTypes.filter((t) => typeof t === 'string' && t.length <= 16);
      if (types.length) result = { types, declared: true };
    }
  } catch {
    // 平台不可达时按最保守口径处理；真正的连接错误由随后的请求暴露。
  }
  capabilityCache.set(origin, result);
  return result;
}

/**
 * 按平台能力裁剪服务目录。
 * @param services 桌面端可提供的服务
 * @param activeId 当前选中的服务
 * @param capability 平台能力
 */
export function fitServiceCatalog(services, activeId, capability) {
  const allowed = capability?.types?.length ? capability.types : [...FALLBACK_SERVICE_TYPES];
  const fit = fitCatalogToPlatform(services, activeId ?? '', allowed);
  return {
    services: fit.services,
    activeId: fit.activeId,
    dropped: fit.dropped,
    allowedTypes: allowed,
    degraded: fit.dropped.length > 0,
  };
}

export { DESKTOP_SERVICE_TYPES };

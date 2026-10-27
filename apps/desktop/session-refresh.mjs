import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionLock, createSessionRefresher, persistDesktopSession, readDesktopSession } from "@cpclaw/desktop-host/session-refresh";

/**
 * 桌面端进程内的登录续期单例。
 *
 * 背景：刷新令牌是单次使用语义，平台每次续期都轮换 refresh_hash，旧令牌立即作废。
 * 聊天、技能市场、知识库与报告工作区都在同一个工作进程里，若各自读取磁盘上的
 * 旧令牌并发续期，先到的请求会作废后到的令牌，而后到的请求得到 401，
 * 最新令牌随之丢失——会话彻底失效，表现为技能市场「登录凭证无效」。
 *
 * 这里用单飞收敛：同一时刻只有一个续期请求在途，其余调用方复用同一结果。
 * 跨进程（多开桌面端）残留的旧令牌竞争由续期失败后的重读重试兜底。
 */

/** 平台地址以本机连接配置为准，缺失时回落到环境变量。 */
export function platformBase(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, "desktop-connection.json"), "utf8")).platformUrl || process.env.CPCLAW_PLATFORM_URL || "";
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("平台连接配置无法读取");
    return process.env.CPCLAW_PLATFORM_URL || "";
  }
}

const instances = new Map();

/** 取（并在首次调用时创建）本数据目录的续期单例。 */
export function sessionRefresher(dataDir) {
  const existing = instances.get(dataDir);
  if (existing !== undefined) {
    return existing;
  }
  const refresher = createSessionRefresher({
    read: () => readDesktopSession(dataDir),
    renew: async (current) => {
      const base = platformBase(dataDir);
      if (!base) throw new Error("请先设置平台地址并登录");
      const response = await fetch(`${base.replace(/\/$/, "")}/v1/session/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({}));
      // 平台续期成功响应不含 ok 字段，只能依据 HTTP 状态与必要字段判断。
      if (!response.ok) throw new Error(result.message || `平台返回 ${response.status}`);
      if (typeof result.accessToken !== "string" || typeof result.refreshToken !== "string" || typeof result.employeeId !== "string") {
        throw new Error("平台续期响应缺少会话字段");
      }
      return result;
    },
    persist: (session) => persistDesktopSession(dataDir, session),
    // 多个桌面实例共享同一会话文件，跨进程也要串行化续期。
    lock: createSessionLock(dataDir),
  });
  instances.set(dataDir, refresher);
  return refresher;
}

/** 释放续期单例（进程退出或测试收尾时用）。 */
export function resetSessionRefresher(dataDir) {
  instances.delete(dataDir);
}

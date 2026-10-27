import { mkdirSync, openSync, closeSync, writeSync, fsyncSync, unlinkSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readCurrentAccountSession, writeAccountSession } from "./account-session.js";

/**
 * 刷新令牌是单次使用语义：平台每次续期都轮换 refresh_hash，旧令牌立即作废。
 * 桌面端有多个并发消费者（聊天、技能市场、知识库、报告工作区），
 * 若各自读取磁盘上的旧令牌并发续期，先到的请求会把后到的令牌作废，
 * 后到的请求拿到 401，且最新令牌随之丢失——会话彻底失效。
 *
 * 这里用单飞（single-flight）收敛：同一时刻只允许一个续期请求在途，
 * 其余调用方复用同一个 Promise 与同一份结果。
 */
export type SessionRefreshResult = {
  ok: true;
  employeeId: string;
  sessionId: string;
  accessToken: string;
} | {
  ok: false;
  code: string;
  message: string;
};

export type SessionRefreshOptions = {
  /** 从平台读取当前会话；必须抛出错误表示续期失败。 */
  renew: (current: { employeeId: string; sessionId: string; refreshToken: string }) => Promise<{
    employeeId: string;
    sessionId: string;
    refreshToken: string;
    accessToken: string;
  }>;
  /** 把轮换后的会话写回本机；返回 false 表示写回失败。 */
  persist: (session: { employeeId: string; sessionId: string; refreshToken: string }) => boolean;
  /** 读取本机当前会话；返回 null 表示尚未登录，抛出错误表示会话文件不可用。 */
  read: () => { employeeId: string; sessionId: string; refreshToken: string } | null;
  /**
   * 跨进程互斥。同一台机器上可能同时开着多个桌面实例，
   * 它们共享同一个会话文件，必须由外部锁把续期串行化。
   * 未提供时只做进程内单飞。
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
};

export function createSessionRefresher(options: SessionRefreshOptions) {
  let inflight: Promise<SessionRefreshResult> | null = null;

  async function run(): Promise<SessionRefreshResult> {
    let current: { employeeId: string; sessionId: string; refreshToken: string } | null;
    try {
      current = options.read();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取登录会话";
      return { ok: false, code: "AUTH_REQUIRED", message };
    }
    if (current === null) {
      return { ok: false, code: "AUTH_REQUIRED", message: "请先登录平台" };
    }
    let renewed: Awaited<ReturnType<SessionRefreshOptions["renew"]>>;
    try {
      renewed = await options.renew(current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录续期失败";
      return { ok: false, code: "AUTH_REQUIRED", message };
    }
    if (renewed.employeeId !== current.employeeId) {
      return { ok: false, code: "AUTH_REQUIRED", message: "平台会话员工不匹配" };
    }
    if (!options.persist({ employeeId: renewed.employeeId, sessionId: renewed.sessionId, refreshToken: renewed.refreshToken })) {
      return { ok: false, code: "AUTH_REQUIRED", message: "续期结果无法写回本机" };
    }
    return { ok: true, employeeId: renewed.employeeId, sessionId: renewed.sessionId, accessToken: renewed.accessToken };
  }

  return {
    /**
     * 续期并返回可用的访问令牌。
     * 同一时刻的并发调用共享同一次续期请求，避免互相作废刷新令牌。
     */
    async refresh(): Promise<SessionRefreshResult> {
      if (inflight !== null) {
        return inflight;
      }
      const pending = (options.lock === undefined ? run() : options.lock(run)).finally(() => {
        if (inflight === pending) {
          inflight = null;
        }
      });
      inflight = pending;
      return pending;
    },
    /** 是否有续期在途；用于诊断。 */
    get busy(): boolean {
      return inflight !== null;
    },
  };
}

/**
 * 以本机账号目录为真源的默认读取实现。
 * 未登录返回 null；会话文件损坏或不可读时抛出原始原因，便于定位。
 */
export function readDesktopSession(dataDir: string): { employeeId: string; sessionId: string; refreshToken: string } | null {
  const current = readCurrentAccountSession(dataDir);
  if (!current.ok) {
    throw new Error(current.message);
  }
  if (current.session === null) {
    return null;
  }
  return {
    employeeId: current.session.employeeId,
    sessionId: current.session.sessionId,
    refreshToken: current.session.refreshToken,
  };
}

/** 以本机账号目录为真源的默认写回实现。 */
export function persistDesktopSession(
  dataDir: string,
  session: { employeeId: string; sessionId: string; refreshToken: string },
): boolean {
  const saved = writeAccountSession(
    dataDir,
    { schemaVersion: 1, employeeId: session.employeeId, sessionId: session.sessionId, refreshToken: session.refreshToken },
    { makeCurrent: false },
  );
  return saved.ok;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 25;

/**
 * 跨进程续期锁：以「排他创建锁文件」实现，进程崩溃后按时间自动回收。
 *
 * 同一台机器上可能同时运行多个桌面实例，它们共享同一个会话文件。
 * 进程内单飞无法覆盖这一场景，必须用文件锁把续期串行化，
 * 否则先到的实例会作废后到实例持有的令牌。
 */
export function createSessionLock(dataDir: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const lockDir = join(dataDir, "locks");
  const lockPath = join(lockDir, "session-refresh.lock");

  function isStale(path: string): boolean {
    try {
      return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  function tryAcquire(): boolean {
    mkdirSync(lockDir, { recursive: true });
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        // 持锁进程已崩溃或卡死：回收陈旧锁后重试一次。
        if (isStale(lockPath)) {
          try {
            rmSync(lockPath, { force: true });
          } catch {
            /* 别的进程可能已回收 */
          }
          try {
            const fd = openSync(lockPath, "wx", 0o600);
            closeSync(fd);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      }
      throw error;
    }
  }

  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!tryAcquire()) {
      if (Date.now() >= deadline) {
        throw new Error("登录续期锁等待超时，请重试或重新登录");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        /* 锁已由陈旧回收移除 */
      }
    }
  };
}

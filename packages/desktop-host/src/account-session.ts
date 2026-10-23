import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const employeeIdPattern = /^[a-z][a-z0-9-]{0,31}$/;

export type AccountSessionFile = {
  schemaVersion: 1;
  employeeId: string;
  sessionId: string;
  refreshToken: string;
};

export type AccountSessionResult = { ok: true } | { ok: false; message: string };

function accountDir(root: string, employeeId: string): string {
  return join(root, "accounts", employeeId);
}

function refuseSymlink(path: string): { ok: false; message: string } | undefined {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return { ok: false, message: "账号目录不能是符号链接" };
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    const message = error instanceof Error ? error.message : "无法检查路径";
    return { ok: false, message };
  }
  return undefined;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function writeAccountSession(
  root: string,
  session: AccountSessionFile,
  options: { makeCurrent: boolean },
): AccountSessionResult {
  if (!employeeIdPattern.test(session.employeeId) || session.schemaVersion !== 1) {
    return { ok: false, message: "员工编号不符合限制" };
  }
  if (session.refreshToken.length < 8 || session.refreshToken.length > 512) {
    return { ok: false, message: "刷新令牌长度不符合限制" };
  }
  const dir = accountDir(root, session.employeeId);
  mkdirSync(join(root, "accounts"), { recursive: true });
  const linked = refuseSymlink(dir);
  if (linked !== undefined) {
    return linked;
  }
  mkdirSync(dir, { recursive: true });
  const fileLink = refuseSymlink(join(dir, "session.json"));
  if (fileLink !== undefined) {
    return fileLink;
  }
  writeJson(join(dir, "session.json"), session);
  if (options.makeCurrent) {
    return switchCurrentAccount(root, session.employeeId);
  }
  return { ok: true };
}

export function switchCurrentAccount(root: string, employeeId: string): AccountSessionResult {
  if (!employeeIdPattern.test(employeeId)) {
    return { ok: false, message: "员工编号不符合限制" };
  }
  mkdirSync(join(root, "accounts"), { recursive: true });
  const currentPath = join(root, "accounts", "current.json");
  const linked = refuseSymlink(currentPath);
  if (linked !== undefined) {
    return linked;
  }
  writeJson(currentPath, { schemaVersion: 1, employeeId });
  return { ok: true };
}

export function readCurrentAccountSession(
  root: string,
): { ok: true; session: AccountSessionFile | null } | { ok: false; message: string } {
  const currentPath = join(root, "accounts", "current.json");
  const linked = refuseSymlink(currentPath);
  if (linked !== undefined) {
    return linked;
  }
  let raw: string;
  try {
    raw = readFileSync(currentPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: true, session: null };
    }
    const message = error instanceof Error ? error.message : "无法读取当前账号";
    return { ok: false, message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "当前账号无法解析";
    return { ok: false, message };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, message: "当前账号无法解析" };
  }
  const employeeId = Reflect.get(parsed, "employeeId");
  if (typeof employeeId !== "string" || !employeeIdPattern.test(employeeId)) {
    return { ok: false, message: "当前账号无法解析" };
  }
  const sessionPath = join(accountDir(root, employeeId), "session.json");
  const sessionLink = refuseSymlink(sessionPath);
  if (sessionLink !== undefined) {
    return sessionLink;
  }
  let sessionRaw: string;
  try {
    sessionRaw = readFileSync(sessionPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: true, session: null };
    }
    const message = error instanceof Error ? error.message : "无法读取会话文件";
    return { ok: false, message };
  }
  let sessionParsed: unknown;
  try {
    sessionParsed = JSON.parse(sessionRaw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "会话文件无法解析";
    return { ok: false, message };
  }
  if (typeof sessionParsed !== "object" || sessionParsed === null) {
    return { ok: false, message: "会话文件无法解析" };
  }
  const storedId = Reflect.get(sessionParsed, "employeeId");
  const sessionId = Reflect.get(sessionParsed, "sessionId");
  const refreshToken = Reflect.get(sessionParsed, "refreshToken");
  const schemaVersion = Reflect.get(sessionParsed, "schemaVersion");
  if (typeof schemaVersion === "number" && schemaVersion !== 1) {
    return {
      ok: false,
      message: `会话 schema ${schemaVersion} 与本机支持的 1 不兼容，拒绝错误打开`,
    };
  }
  if (storedId !== employeeId || schemaVersion !== 1 || typeof sessionId !== "string" || typeof refreshToken !== "string") {
    return { ok: false, message: "会话文件与当前账号不一致" };
  }
  return {
    ok: true,
    session: { schemaVersion: 1, employeeId, sessionId, refreshToken },
  };
}

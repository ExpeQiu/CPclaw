import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
// 固定应用与参数；渲染进程不能提交任意命令或安装脚本。
export function createExtensionService({ run = execute, binary = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'dreamina-canvas.exe' : 'dreamina-canvas'), exists = existsSync, cwd = homedir(), resolveBinary = realpathSync } = {}) {
  let pending;
  async function inspect({ beforeExecute = () => {}, signal } = {}) {
    if (!exists(binary)) return { ok: true, state: 'missing', message: '未发现即梦 CLI，请先完成获准的安装。' };
    async function call(args) {
      const executable = resolveBinary(binary);
      beforeExecute();
      let stdout;
      try { ({ stdout } = await run(executable, ['--non-interactive', '--format', 'json', ...args], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, cwd, ...(signal ? { signal } : {}) })); }
      catch (error) {
        // CLI 非零退出会将 JSON 错误写入 stderr；进程被终止时不能把残留输出当作完成。
        if (error.killed || error.signal) throw error;
        for (const output of [error.stdout, error.stderr]) {
          try {
            const reply = JSON.parse(output);
            if (reply && typeof reply.ok === 'boolean') return reply;
          } catch { /* 只接受结构化协议，不向界面转发原始 stderr。 */ }
        }
        throw error;
      }
      return JSON.parse(stdout);
    }
    try {
      const version = await call(['version']);
      if (!version.ok) return { ok: false, state: 'error', message: 'CLI 版本检查失败。' };
      const detail = { version: version.data.version };
      const auth = await call(['auth', 'status']);
      if (!auth.ok) return { ok: false, ...detail, state: 'error', message: '无法检查登录状态，请检查 CLI 与认证存储。' };
      if (!auth.data.loggedIn) return { ok: true, ...detail, state: 'login', message: '尚未登录，请完成即梦 CLI 官方授权。' };
      const canvases = await call(['canvas', 'ls', '--limit', '1']);
      if (!canvases.ok) {
        const scope = canvases.error?.reason === 'oauth_scope_insufficient';
        return { ok: true, ...detail, state: scope ? 'scope' : 'unavailable', message: scope ? '授权权限不足，请更新 CLI 与 Skill 后重新授权。' : '已登录，但画布读取失败，请检查网络或账号权限。' };
      }
      return { ok: true, ...detail, state: 'ready', message: 'CLI 已登录，画布读取检查通过。' };
    } catch { return { ok: false, state: 'error', message: 'CLI 检查失败或超时，请检查安装与网络后重试。' }; }
  }
  function describeInspection() {
    if (!exists(binary)) return null;
    const executable = resolveBinary(binary);
    const commands = [['version'], ['auth', 'status'], ['canvas', 'ls', '--limit', '1']].map(args => [executable, '--non-interactive', '--format', 'json', ...args]);
    const description = { app: '即梦 CLI', purpose: '检查 CLI 版本、登录状态与画布读取权限', cwd, commands };
    const fingerprint = createHash('sha256').update(JSON.stringify(description)).update(readFileSync(executable)).digest('hex');
    return { ...description, fingerprint };
  }
  return { describeInspection, inspect(options) { if (!pending) pending = inspect(options).finally(() => { pending = undefined; }); return pending; } };
}

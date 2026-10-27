import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { SERVICE_KINDS, annotateService } from './service-kinds.mjs';

const FILE = 'local-extensions.json';

function pathOf(dataDir) {
  return join(dataDir, FILE);
}

function read(dataDir) {
  const file = pathOf(dataDir);
  if (!existsSync(file)) return { services: [] };
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return { services: Array.isArray(value.services) ? value.services : [] };
  } catch {
    return { services: [] };
  }
}

function write(dataDir, services) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(pathOf(dataDir), JSON.stringify({ schemaVersion: 1, services }, null, 2), { mode: 0o600 });
}

function validateHttps(url) {
  const u = new URL(url);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.hash) throw Error('页面地址无效');
  if ([...u.searchParams.keys()].some(k => /token|sign|auth|code|credential/i.test(k))) throw Error('地址不能包含敏感查询参数');
  return u;
}

export function listLocalExtensions(dataDir) {
  return read(dataDir).services.filter(s => s && s.enabled !== false).map(annotateService);
}

export function addComputerUseSite(dataDir, { pageUrl, title } = {}) {
  if (typeof pageUrl !== 'string' || !pageUrl.trim()) throw Error('请填写网页地址');
  const u = validateHttps(pageUrl.trim());
  const services = read(dataDir).services;
  const existing = services.find(s => s.kind === SERVICE_KINDS.computerUse && s.pageUrl === u.origin + '/');
  if (existing) return annotateService(existing);
  const entry = annotateService({
    id: 'web-' + createHash('sha256').update(u.origin).digest('hex').slice(0, 12),
    title: (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 100) : (u.hostname || '网页'),
    type: 'WEB',
    kind: SERVICE_KINDS.computerUse,
    pageUrl: u.origin + '/',
    pageOrigins: [u.origin],
    target: u.origin,
    enabled: true,
    local: true,
  });
  services.push(entry);
  write(dataDir, services);
  return entry;
}

export function addAppDriver(dataDir, { root, title } = {}) {
  if (typeof root !== 'string' || !root || !isAbsolute(root)) throw Error('请选择应用或项目的绝对路径文件夹');
  let path;
  try { path = realpathSync(root); } catch { throw Error('文件夹不存在'); }
  if (!statSync(path).isDirectory()) throw Error('请选择文件夹');
  const services = read(dataDir).services;
  const existing = services.find(s => s.kind === SERVICE_KINDS.appDriver && s.root === path);
  if (existing) return annotateService(existing);
  const entry = annotateService({
    id: 'app-' + createHash('sha256').update(path).digest('hex').slice(0, 12),
    title: (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 100) : basename(path),
    type: 'APP',
    kind: SERVICE_KINDS.appDriver,
    root: path,
    target: path,
    enabled: true,
    local: true,
  });
  services.push(entry);
  write(dataDir, services);
  return entry;
}

export function removeLocalExtension(dataDir, id) {
  if (typeof id !== 'string' || !id) throw Error('缺少服务标识');
  const services = read(dataDir).services;
  const next = services.filter(s => s.id !== id);
  if (next.length === services.length) throw Error('本机拓展不存在');
  write(dataDir, next);
  return { ok: true };
}

export function localExtensionById(dataDir, id) {
  return listLocalExtensions(dataDir).find(s => s.id === id) || null;
}

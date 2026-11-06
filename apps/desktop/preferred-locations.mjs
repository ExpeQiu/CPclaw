import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { desktopLog } from './desktop-log.mjs';

export const PREFERRED_LOCATION_LIMIT = 5;

function fileFor(dataDir, actor) {
  const name = createHash('sha256').update(String(actor)).digest('hex').slice(0, 16);
  return join(dataDir, 'preferred-locations', `${name}.json`);
}

function readList(dataDir, actor) {
  try {
    const body = JSON.parse(readFileSync(fileFor(dataDir, actor), 'utf8'));
    return Array.isArray(body.locations) ? body.locations.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(dataDir, actor, locations) {
  const path = fileFor(dataDir, actor);
  mkdirSync(join(dataDir, 'preferred-locations'), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, locations })}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** 本机已记住的优先访问文件夹。路径按保存时的真实目录返回。 */
export function listPreferredLocations(dataDir, actor) {
  if (!actor) return [];
  return readList(dataDir, actor).map(path => ({ path, name: basename(path) || path }));
}

function tooBroad(path) {
  const blocked = new Set(['/', '/Users', '/Volumes', '/private', '/System', '/Applications', realpathSync(homedir())]);
  return blocked.has(path);
}

/** 记住一个用户显式选择的文件夹。同一账号最多 5 个，各账号分开保存。 */
export function addPreferredLocation(dataDir, actor, picked) {
  if (!actor) return { ok: false, message: '请先登录，再添加优先访问位置。' };
  let path;
  try {
    path = realpathSync(picked);
    if (!statSync(path).isDirectory()) throw Error('not-directory');
  } catch {
    return { ok: false, message: '请选择一个本机存在的文件夹。' };
  }
  if (tooBroad(path)) return { ok: false, message: '请选择具体文件夹，不要选择磁盘、用户主目录或系统目录。' };
  const current = readList(dataDir, actor);
  if (current.includes(path)) return { ok: true, locations: listPreferredLocations(dataDir, actor), reused: true };
  if (current.length >= PREFERRED_LOCATION_LIMIT) return { ok: false, message: `最多记住 ${PREFERRED_LOCATION_LIMIT} 个优先访问位置。`, locations: listPreferredLocations(dataDir, actor) };
  const next = [...current, path];
  writeList(dataDir, actor, next);
  desktopLog(dataDir, 'cpclaw-desktop-host', 'info', 'preferred_location_added', '已记住优先访问位置', { count: next.length });
  return { ok: true, locations: listPreferredLocations(dataDir, actor) };
}

/** 取消一个已记住的位置。未记录的路径也返回当前列表。 */
export function removePreferredLocation(dataDir, actor, path) {
  if (!actor) return { ok: false, message: '请先登录。' };
  const next = readList(dataDir, actor).filter(item => item !== path);
  writeList(dataDir, actor, next);
  desktopLog(dataDir, 'cpclaw-desktop-host', 'info', 'preferred_location_removed', '已取消优先访问位置', { count: next.length });
  return { ok: true, locations: listPreferredLocations(dataDir, actor) };
}

export function preferredRoots(dataDir, actor) {
  return readList(dataDir, actor).filter(path => {
    try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
  });
}

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformFailure } from './app.js';

type Actor = { orgId: string; employeeId: string; role: string };
type Item = { id: string; owner: string; kind: string; title: string; description: string; body: string; version: string; source: string; origin: string; members: string[]; status: string; note: string; updated: number };
export type MarketResult = { ok: true; [key: string]: unknown } | PlatformFailure;
const fail = (message: string): PlatformFailure => ({ ok: false, code: 'CONFIG_INVALID', message });
export function createMarket(db: DatabaseSync, now: () => number) {
  db.exec(`CREATE TABLE IF NOT EXISTS market_items(id TEXT PRIMARY KEY, org TEXT NOT NULL, owner TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS market_installs(org TEXT NOT NULL, employee TEXT NOT NULL, id TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(org,employee,id));
    CREATE TABLE IF NOT EXISTS market_connectors(id TEXT PRIMARY KEY, org TEXT NOT NULL, employee TEXT NOT NULL, payload TEXT NOT NULL);`);
  return (actor: Actor, action: string, input: Record<string, unknown>): MarketResult => {
    const rows = db.prepare('SELECT payload FROM market_items WHERE org=?').all(actor.orgId);
    const all = rows.map(r => JSON.parse(String(r.payload)) as Item);
    const installedIds = new Set(db.prepare('SELECT id FROM market_installs WHERE org=? AND employee=?').all(actor.orgId, actor.employeeId).map(x => String(x.id)));
    const visible = all.filter(x => x.owner === actor.employeeId || x.status === 'published' || actor.role === 'admin' || (x.status === 'withdrawn' && installedIds.has(x.id)));
    const installs = db.prepare('SELECT id,enabled FROM market_installs WHERE org=? AND employee=?').all(actor.orgId, actor.employeeId);
    const connectors = () => db.prepare('SELECT payload FROM market_connectors WHERE org=? AND employee=?').all(actor.orgId, actor.employeeId).map(r => JSON.parse(String(r.payload)) as Record<string, unknown>);
    const save = (item: Item) => db.prepare('INSERT OR REPLACE INTO market_items VALUES(?,?,?,?)').run(item.id, actor.orgId, item.owner, JSON.stringify(item));
    const item = visible.find(x => x.id === input.id);
    if (action === 'list') return { ok: true, items: visible.map(x => ({ ...x, owned: x.owner === actor.employeeId })), installs, connectors: connectors(), role: actor.role };
    if (action === 'save') {
      if (input.id && (!item || item.owner !== actor.employeeId)) return { ok: false, code: 'FORBIDDEN', message: '不能修改其他人的技能' };
      if (item && ['pending', 'published'].includes(item.status)) return fail('待审核或已发布版本不可覆盖，请另存新版本');
      const { title, description, body, kind, version, source, origin } = input;
      if (typeof title !== 'string' || !title.trim() || title.length > 100 || typeof description !== 'string' || description.length > 1000 || typeof body !== 'string' || !body.trim() || body.length > 100000 || !['skill','expert'].includes(String(kind)) || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || !['manual','ai','upload','opensource','builtin'].includes(String(source))) return fail('请填写名称、说明、正文和有效版本（如 1.0.0）');
      if (source === 'upload') {
        try {
          const parsed = JSON.parse(body) as { files?: { path: string; body: string }[] };
          const files = parsed.files;
          if (!Array.isArray(files) || !files.length || files.length > 50 || !files.some(f => typeof f.path === 'string' && f.path.split('/').at(-1) === 'SKILL.md' && typeof f.body === 'string' && f.body.trim())) return fail('上传内容需要非空 SKILL.md');
          if (files.some(f => typeof f.path !== 'string' || f.path.startsWith('/') || f.path.includes('\\') || f.path.split('/').some(p => p === '..' || p.startsWith('.')) || !/\.(md|txt|json|ya?ml)$/i.test(f.path) || typeof f.body !== 'string' || f.body.includes('\0')) || new Set(files.map(f => f.path)).size !== files.length) return fail('上传清单含无效路径、重复文件或非文本内容');
        } catch { return fail('上传清单必须是有效 JSON 文件列表'); }
      }
      if (source === 'builtin' && actor.role !== 'admin') return fail('只有管理员可发布内置技能');
      if (kind === 'expert' && actor.role !== 'admin') return fail('专家组合由管理员维护');
      if (source === 'opensource' && (typeof origin !== 'string' || !/^https:\/\/[^\s]+$/.test(origin) || !description.trim())) return fail('开源引入需要 HTTPS 来源与引入说明');
      const members = Array.isArray(input.members) ? input.members : [];
      if (members.length > 50 || members.some(id => typeof id !== 'string' || !all.some(x => x.id === id && x.kind === 'skill' && x.status === 'published'))) return fail('组合仅能引用本组织已发布技能');
      if (kind === 'expert' && !members.length) return fail('请选择至少一个已发布技能');
      if (all.some(x => x.id !== item?.id && x.owner === actor.employeeId && x.kind === kind && x.title === title.trim() && x.version === version)) return fail('此名称与版本已存在，请升级版本号');
      const next: Item = { id: item?.id ?? randomUUID(), owner: actor.employeeId, kind: String(kind), title: title.trim(), description, body, version, source: String(source), origin: typeof origin === 'string' ? origin : '', members: members as string[], status: 'draft', note: '', updated: now() };
      save(next); return { ok: true, item: next };
    }
    if (action === 'connector-save') {
      const { title, type, target } = input;
      if (typeof title !== 'string' || !title.trim() || title.length > 100 || typeof target !== 'string' || target.length > 1000 || !['MCP','CLI'].includes(String(type))) return fail('连接器配置无效');
      if (type === 'MCP') {
        try { const u = new URL(target); if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return fail('地址不能包含凭证或查询参数'); } catch { return fail('请输入完整 HTTP(S) 服务地址'); }
      } else if (!target.startsWith('/') || /[\n\r\0]/.test(target)) return fail('CLI 需要程序的绝对路径');
      const existing = connectors().find(c => c.id === input.id);
      if (input.id && !existing) return fail('连接器不存在');
      const c = { id: existing?.id ?? randomUUID(), title, type, target, enabled: input.enabled !== false, status: '未检测', updated: now() };
      db.prepare('INSERT OR REPLACE INTO market_connectors VALUES(?,?,?,?)').run(String(c.id), actor.orgId, actor.employeeId, JSON.stringify(c));
      return { ok: true, connector: c };
    }
    if (action === 'connector-remove') { db.prepare('DELETE FROM market_connectors WHERE id=? AND org=? AND employee=?').run(String(input.id), actor.orgId, actor.employeeId); return { ok: true }; }
    if (action === 'uninstall') { db.prepare('DELETE FROM market_installs WHERE org=? AND employee=? AND id=?').run(actor.orgId, actor.employeeId, String(input.id)); return { ok: true }; }
    if (!item) return { ok: false, code: 'NOT_FOUND', message: '资源不存在或无权访问' };
    if (['submit','personal','delete'].includes(action)) {
      if (item.owner !== actor.employeeId || ['pending','published'].includes(item.status)) return fail('只有本人可操作未发布且未在审核中的版本');
      if (action === 'delete') { db.prepare('DELETE FROM market_items WHERE id=? AND org=?').run(item.id, actor.orgId); return { ok: true }; }
      if (action === 'personal' && item.kind === 'expert') return fail('专家组合需审核发布');
      item.status = action === 'submit' ? 'pending' : 'personal'; item.note = ''; item.updated = now(); save(item); return { ok: true };
    }
    if (action === 'review' || action === 'withdraw') {
      if (actor.role !== 'admin') return { ok: false, code: 'FORBIDDEN', message: '需要管理员权限' };
      if (action === 'review' && (item.status !== 'pending' || !['approve','reject'].includes(String(input.decision)))) return fail('审核状态或结论无效');
      if (action === 'withdraw' && item.status !== 'published') return fail('只能撤回已发布资源');
      if (input.decision === 'reject' && (typeof input.note !== 'string' || !input.note.trim())) return fail('请填写修订意见');
      item.status = action === 'withdraw' ? 'withdrawn' : input.decision === 'approve' ? 'published' : 'rejected'; item.note = String(input.note ?? '').slice(0,2000); item.updated = now(); save(item); return { ok: true };
    }
    if (action === 'install' || action === 'toggle') {
      if (item.status !== 'published' && !(item.owner === actor.employeeId && item.status === 'personal')) return fail('此版本尚不可安装');
      if (item.members.some(id => !all.some(x => x.id === id && x.status === 'published'))) return fail('组合含已撤回技能，请联系管理员');
      if (action === 'toggle' && !installs.some(x => x.id === item.id)) return fail('请先安装');
      db.prepare('INSERT OR REPLACE INTO market_installs VALUES(?,?,?,?)').run(actor.orgId, actor.employeeId, item.id, input.enabled === false ? 0 : 1);
      return { ok: true };
    }
    return fail('未知市场操作');
  };
}

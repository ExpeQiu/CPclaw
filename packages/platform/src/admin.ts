import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformFailure } from './app.js';
import { hashPassword } from './token.js';
import { MODEL_ID } from './fixture.js';
import { appendAuthorityRevocation } from './authority-ledger.js';

type Actor = { orgId: string; employeeId: string };
export type AdminResult = { ok: true; [key: string]: unknown } | PlatformFailure;

/** Commands are reachable only through PlatformApp's requireAdmin guard. */
export function createAdmin(db: DatabaseSync, dataDir: string, now: () => number, audit: (org: string, actor: string, action: string, target: string) => void) {
  const fail = (message: string, code: PlatformFailure['code'] = 'CONFIG_INVALID'): PlatformFailure => ({ ok: false, code, message });
  const diagnosticRows = (org: string) => db.prepare(`SELECT u.upload_id, u.employee_id, u.created_at, f.byte_size, f.body
    FROM upload_sessions u JOIN private_files f ON f.file_id=u.file_id AND f.org_id=u.org_id AND f.employee_id=u.employee_id
    WHERE u.org_id=? AND u.purpose='artifact' AND u.status='available'
      AND json_extract(CASE WHEN json_valid(f.body) THEN f.body ELSE '{}' END,'$.kind')='diagnostic-pack'
    ORDER BY u.created_at DESC LIMIT 100`).all(org);
  return (actor: Actor, action: string, input: Record<string, unknown>): AdminResult => {
    if (action === 'diagnostics') return { ok: true, reports: diagnosticRows(actor.orgId).map(r => ({ uploadId: r.upload_id, employeeId: r.employee_id, createdAt: r.created_at, byteSize: r.byte_size })) };
    if (action === 'diagnostic-read') {
      const row = diagnosticRows(actor.orgId).find(r => r.upload_id === input.uploadId);
      if (!row) return fail('没有这个诊断包或不在最近 100 条中', 'NOT_FOUND');
      audit(actor.orgId, actor.employeeId, 'diagnostic_read', String(row.upload_id));
      return { ok: true, report: JSON.parse(String(row.body)) };
    }
    if (action === 'backups') {
      // The SQLite file contains multiple organizations: only expose receipts, never a database download.
      const receipts = db.prepare("SELECT target, at_ms FROM audit_log WHERE org_id=? AND action='backup' ORDER BY id DESC LIMIT 50").all(actor.orgId);
      let files = new Set<string>();
      try { files = new Set(readdirSync(join(dataDir, 'backups'))); } catch { /* No backups yet. */ }
      return { ok: true, backups: receipts.map(r => ({ fileName: r.target, createdAt: r.at_ms, available: files.has(String(r.target)), bytes: files.has(String(r.target)) ? statSync(join(dataDir, 'backups', String(r.target))).size : 0 })) };
    }
    if (!['employee-create', 'employee-update'].includes(action)) return fail('未知管理操作');
    const { employeeId, name, role, password } = input;
    if (typeof employeeId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(employeeId) || typeof name !== 'string' || !name.trim() || name.length > 40 || !['admin', 'employee'].includes(String(role))) return fail('员工编号、姓名或角色无效');
    if (password !== undefined && (typeof password !== 'string' || password.length < 8 || password.length > 128 || password.includes('\0'))) return fail('口令长度必须在 8 到 128');
    const existing = db.prepare('SELECT org_id, role, status FROM employees WHERE employee_id=?').get(employeeId);
    if (action === 'employee-create') {
      if (existing) return fail('员工编号不可用', 'CONFLICT');
      if (typeof password !== 'string') return fail('新增员工需要初始口令');
    } else {
      if (!existing || existing.org_id !== actor.orgId) return fail('没有这个员工', 'NOT_FOUND');
      if (existing.status !== 'active') return fail('已停用员工不可修改，请使用新编号建立账号', 'CONFLICT');
      if (employeeId === actor.employeeId && (role !== 'admin' || password !== undefined)) return fail('不能修改当前账号的角色或重置当前口令，请由另一管理员操作', 'CONFLICT');
    }
    const revoke = action === 'employee-update' && (password !== undefined || role !== existing?.role);
    const sessions = revoke ? db.prepare("SELECT session_id FROM sessions WHERE employee_id=? AND status='active'").all(employeeId) : [];
    // Record revocations before mutation, so restoring an older DB cannot resurrect old sessions.
    for (const s of sessions) appendAuthorityRevocation(dataDir, { kind: 'session', id: String(s.session_id), at: now(), orgId: actor.orgId, actorId: actor.employeeId });
    const passwordHash = typeof password === 'string' ? hashPassword(password) : undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (action === 'employee-create') {
        db.prepare("INSERT INTO employees VALUES(?,?,?,?, 'active', ?)").run(employeeId, actor.orgId, name.trim(), String(role), passwordHash!);
        db.prepare('INSERT INTO quota VALUES(?,?,?,?,?,0,0,0,0)').run(employeeId, MODEL_ID, 1000, 3, 100);
      } else {
        db.prepare('UPDATE employees SET name=?,role=? WHERE employee_id=?').run(name.trim(), String(role), employeeId);
        if (passwordHash) db.prepare('UPDATE employees SET password_hash=? WHERE employee_id=?').run(passwordHash, employeeId);
        if (revoke) db.prepare("UPDATE sessions SET status='revoked' WHERE employee_id=? AND status='active'").run(employeeId);
      }
      audit(actor.orgId, actor.employeeId, action, employeeId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { ok: true };
  };
}

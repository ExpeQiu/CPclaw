import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { checkReport, type TaskMode } from "@cpclaw/contracts";
import { inspectWorkspaceCompat } from "./compat.js";
import { isPathInside, resolveWriteTarget } from "./file-tool.js";
import { hostLog } from "./host-log.js";

/** 单页修订条数的工程上限。业务配额还没确认，这不是验收通过线。 */
export const WIKI_REVISION_CAP = 32;

const idPattern = /^[A-Za-z0-9._:-]{1,64}$/;

const ACTIVE_STATUSES = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "verifying",
  "cancelling",
] as const;

const SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  project_id TEXT,
  mode TEXT NOT NULL,
  budget_limit_calls INTEGER NOT NULL,
  spent_calls INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE revisions (
  revision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE grants (
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  access TEXT NOT NULL,
  PRIMARY KEY (task_id, kind, path, access)
) STRICT;
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  control_reason TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX runs_actor_key ON runs(actor_id, idempotency_key);
CREATE TABLE events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message_id TEXT,
  body TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;
CREATE UNIQUE INDEX events_message ON events(run_id, message_id) WHERE message_id IS NOT NULL;
CREATE TABLE inputs (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  consumed INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'desktop',
  command_id TEXT,
  PRIMARY KEY (task_id, seq)
) STRICT;
CREATE TABLE changes (
  change_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT NOT NULL,
  base_digest TEXT NOT NULL,
  accepted_digest TEXT,
  material_names TEXT NOT NULL,
  status TEXT NOT NULL
) STRICT;
CREATE TABLE side_effects (
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (run_id, path)
) STRICT;
CREATE TABLE unknown_ops (
  operation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL
) STRICT;
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL
) STRICT;
CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  project_id TEXT,
  org_id TEXT,
  scope TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL
) STRICT;
CREATE TABLE wiki_sources (
  source_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  path TEXT NOT NULL,
  origin_digest TEXT NOT NULL,
  maintenance INTEGER NOT NULL
) STRICT;
CREATE TABLE wiki_pages (
  page_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  body TEXT NOT NULL,
  origin TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  PRIMARY KEY (page_id, revision)
) STRICT;
CREATE TABLE context_snapshots (
  task_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  budget_spent_calls INTEGER NOT NULL,
  unknown_operation_ids TEXT NOT NULL
) STRICT;
`;

export type WorkspaceCode =
  | "SLOT_BUSY"
  | "BUDGET_EXCEEDED"
  | "MODE_READONLY"
  | "REVISION_CONFLICT"
  | "OUTSIDE_GRANT"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "CHECK_FAILED"
  | "DIRECTORY_NOT_ALLOWED"
  | "WIKI_CONFLICT"
  | "MAINTENANCE_DENIED"
  | "CAP_REACHED"
  | "RECONCILE_REQUIRED"
  | "CANCELLED"
  | "EMPTY"
  | "SCHEMA_INVALID"
  | "SOURCE_CHANGED"
  | "PERMISSION_DENIED";

export type WorkspaceFailure = {
  ok: false;
  code: WorkspaceCode;
  message: string;
  missing?: string[];
};

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "verifying"
  | "reconcile_required"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelling"
  | "cancelled";

type GrantInput = { kind: "directory" | "file"; path: string; access: "read" | "write" };

type Row = Record<string, SQLOutputValue>;

function fail(code: WorkspaceCode, message: string, missing?: string[]): WorkspaceFailure {
  if (missing !== undefined) {
    return { ok: false, code, message, missing };
  }
  return { ok: false, code, message };
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isId(value: string): boolean {
  return idPattern.test(value);
}

function isMode(value: string): value is TaskMode {
  return value === "ask" || value === "plan" || value === "execute";
}

function isRunStatus(value: string): value is RunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting_input" ||
    value === "waiting_approval" ||
    value === "verifying" ||
    value === "reconcile_required" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelling" ||
    value === "cancelled"
  );
}

function cellString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`字段 ${key} 不是字符串`);
  }
  return value;
}

function cellNullable(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`字段 ${key} 不是字符串`);
  }
  return value;
}

function cellNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`字段 ${key} 不是整数`);
  }
  return value;
}

function fileDigest(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return digestText(readFileSync(path, "utf8"));
}

export class LocalWorkspace {
  readonly interruptedOnOpen: readonly string[];
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  private closed = false;

  private constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.db = new DatabaseSync(join(dataDir, "workspace.sqlite"));
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.ensureSchema();
    this.interruptedOnOpen = this.reconcile();
  }

  static open(dataDir: string): LocalWorkspace {
    if (!isAbsolute(dataDir)) {
      throw new Error("数据目录必须是绝对路径");
    }
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "workspace.sqlite");
    if (existsSync(dbPath)) {
      const compat = inspectWorkspaceCompat(dataDir);
      if (!compat.ok && compat.code === "SCHEMA_INCOMPATIBLE") {
        throw new Error(compat.message);
      }
    }
    return new LocalWorkspace(dataDir);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  createTask(input: {
    taskId: string;
    revisionId: string;
    actorId: string;
    goal: string;
    acceptance: string;
    mode: TaskMode;
    budgetLimitCalls: number;
    projectId?: string;
    grants: readonly GrantInput[];
  }): { ok: true; taskId: string; revisionId: string; grantCount: number } | WorkspaceFailure {
    if (!isId(input.taskId) || !isId(input.revisionId) || !isId(input.actorId)) {
      return fail("SCHEMA_INVALID", "任务标识不符合限制");
    }
    if (input.projectId !== undefined && !isId(input.projectId)) {
      return fail("SCHEMA_INVALID", "项目标识不符合限制");
    }
    if (input.goal.length === 0 || input.goal.length > 500 || input.acceptance.length === 0 || input.acceptance.length > 500) {
      return fail("SCHEMA_INVALID", "目标或验收条件长度不符合限制");
    }
    if (!Number.isInteger(input.budgetLimitCalls) || input.budgetLimitCalls < 0 || input.budgetLimitCalls > 10000) {
      return fail("SCHEMA_INVALID", "预算次数不符合限制");
    }
    for (const grant of input.grants) {
      if ((grant.kind !== "directory" && grant.kind !== "file") || (grant.access !== "read" && grant.access !== "write")) {
        return fail("SCHEMA_INVALID", "目录授权不符合限制");
      }
      if (!isAbsolute(grant.path)) {
        return fail("SCHEMA_INVALID", "授权路径必须是绝对路径");
      }
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT task_id FROM tasks WHERE task_id = ?").get(input.taskId);
      if (existing !== undefined) {
        return fail("IDEMPOTENCY_CONFLICT", "任务标识已经存在");
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO tasks (task_id, actor_id, project_id, mode, budget_limit_calls, spent_calls, revision_id, goal, acceptance, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          input.taskId,
          input.actorId,
          input.projectId ?? null,
          input.mode,
          input.budgetLimitCalls,
          input.revisionId,
          input.goal,
          input.acceptance,
          now,
        );
      this.db
        .prepare(
          "INSERT INTO revisions (revision_id, task_id, goal, acceptance, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(input.revisionId, input.taskId, input.goal, input.acceptance, input.mode, now);
      const insertGrant = this.db.prepare("INSERT INTO grants (task_id, kind, path, access) VALUES (?, ?, ?, ?)");
      for (const grant of input.grants) {
        insertGrant.run(input.taskId, grant.kind, grant.path, grant.access);
      }
      hostLog(this.dataDir, "info", "task_created", "已固定任务修订", {
        taskId: input.taskId,
        mode: input.mode,
        budgetLimitCalls: input.budgetLimitCalls,
      });
      return { ok: true as const, taskId: input.taskId, revisionId: input.revisionId, grantCount: input.grants.length };
    });
  }

  reviseTask(input: {
    taskId: string;
    revisionId: string;
    expectedRevisionId: string;
    goal: string;
    acceptance: string;
  }): { ok: true; revisionId: string } | WorkspaceFailure {
    if (!isId(input.taskId) || !isId(input.revisionId) || !isId(input.expectedRevisionId)) {
      return fail("SCHEMA_INVALID", "修订标识不符合限制");
    }
    return this.transaction(() => {
      const task = this.taskRow(input.taskId);
      if (task === undefined) {
        return fail("NOT_FOUND", "任务不存在");
      }
      if (cellString(task, "revision_id") !== input.expectedRevisionId) {
        return fail("REVISION_CONFLICT", "任务修订已经变化");
      }
      const now = new Date().toISOString();
      const mode = cellString(task, "mode");
      this.db
        .prepare("INSERT INTO revisions (revision_id, task_id, goal, acceptance, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.revisionId, input.taskId, input.goal, input.acceptance, mode, now);
      this.db
        .prepare("UPDATE tasks SET revision_id = ?, goal = ?, acceptance = ? WHERE task_id = ?")
        .run(input.revisionId, input.goal, input.acceptance, input.taskId);
      this.db.prepare("UPDATE changes SET status = 'invalidated' WHERE task_id = ? AND status = 'pending'").run(input.taskId);
      hostLog(this.dataDir, "info", "task_revised", "目标修订已使待审变更失效", { taskId: input.taskId });
      return { ok: true as const, revisionId: input.revisionId };
    });
  }

  readTask(taskId: string):
    | { ok: true; revisionId: string; goal: string; mode: TaskMode; grantCount: number; projectId: string | null }
    | WorkspaceFailure {
    const task = this.taskRow(taskId);
    if (task === undefined) {
      return fail("NOT_FOUND", "任务不存在");
    }
    const mode = cellString(task, "mode");
    if (!isMode(mode)) {
      throw new Error("任务模式无法识别");
    }
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE task_id = ?").get(taskId);
    return {
      ok: true,
      revisionId: cellString(task, "revision_id"),
      goal: cellString(task, "goal"),
      mode,
      grantCount: count === undefined ? 0 : cellNumber(count, "n"),
      projectId: cellNullable(task, "project_id"),
    };
  }

  enqueueInput(
    taskId: string,
    body: string,
    meta?: { source?: "desktop" | "feishu" | "wecom"; commandId?: string },
  ): { ok: true; seq: number; source: string } | WorkspaceFailure {
    if (body.length === 0 || body.length > 2000) {
      return fail("SCHEMA_INVALID", "补充内容长度不符合限制");
    }
    const source = meta?.source ?? "desktop";
    if (source !== "desktop" && source !== "feishu" && source !== "wecom") {
      return fail("SCHEMA_INVALID", "输入来源不符合限制");
    }
    if (meta?.commandId !== undefined && !isId(meta.commandId)) {
      return fail("SCHEMA_INVALID", "命令标识不符合限制");
    }
    return this.transaction(() => {
      if (this.taskRow(taskId) === undefined) {
        return fail("NOT_FOUND", "任务不存在");
      }
      if (meta?.commandId !== undefined) {
        const dup = this.db
          .prepare("SELECT seq FROM inputs WHERE task_id = ? AND command_id = ?")
          .get(taskId, meta.commandId);
        if (dup !== undefined) {
          return { ok: true as const, seq: cellNumber(dup, "seq"), source };
        }
      }
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM inputs WHERE task_id = ?").get(taskId);
      const seq = (row === undefined ? 0 : cellNumber(row, "n")) + 1;
      this.db
        .prepare("INSERT INTO inputs (task_id, seq, body, consumed, source, command_id) VALUES (?, ?, ?, 0, ?, ?)")
        .run(taskId, seq, body, source, meta?.commandId ?? null);
      return { ok: true as const, seq, source };
    });
  }

  takeInput(taskId: string): { ok: true; seq: number; body: string } | WorkspaceFailure {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT seq, body FROM inputs WHERE task_id = ? AND consumed = 0 ORDER BY seq ASC LIMIT 1")
        .get(taskId);
      if (row === undefined) {
        return fail("EMPTY", "没有待处理的补充");
      }
      const seq = cellNumber(row, "seq");
      this.db.prepare("UPDATE inputs SET consumed = 1 WHERE task_id = ? AND seq = ?").run(taskId, seq);
      return { ok: true as const, seq, body: cellString(row, "body") };
    });
  }

  startRun(input: {
    taskId: string;
    runId: string;
    idempotencyKey: string;
    expectedRevisionId: string;
  }): { ok: true; runId: string; attempt: number; status: RunStatus; replayed: boolean } | WorkspaceFailure {
    if (!isId(input.runId) || !isId(input.idempotencyKey) || !isId(input.expectedRevisionId)) {
      return fail("SCHEMA_INVALID", "执行标识不符合限制");
    }
    return this.transaction(() => this.insertRun(input));
  }

  continueRun(input: {
    taskId: string;
    runId: string;
    idempotencyKey: string;
    expectedRevisionId: string;
  }): { ok: true; runId: string; attempt: number; status: RunStatus; replayed: boolean } | WorkspaceFailure {
    return this.startRun(input);
  }

  readRun(runId: string):
    | {
        ok: true;
        status: RunStatus;
        attempt: number;
        controlReason: string | null;
        sideEffectPaths: string[];
        taskId: string;
      }
    | WorkspaceFailure {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    if (row === undefined) {
      return fail("NOT_FOUND", "执行不存在");
    }
    const status = cellString(row, "status");
    if (!isRunStatus(status)) {
      throw new Error("执行状态无法识别");
    }
    const paths = this.db.prepare("SELECT path FROM side_effects WHERE run_id = ? ORDER BY path").all(runId);
    return {
      ok: true,
      status,
      attempt: cellNumber(row, "attempt"),
      controlReason: cellNullable(row, "control_reason"),
      sideEffectPaths: paths.map((item) => cellString(item, "path")),
      taskId: cellString(row, "task_id"),
    };
  }

  appendToken(runId: string, body: string): { ok: true; seq: number } | WorkspaceFailure {
    return this.transaction(() => {
      if (this.runRow(runId) === undefined) {
        return fail("NOT_FOUND", "执行不存在");
      }
      const seq = this.nextSeq(runId);
      this.db.prepare("INSERT INTO events (run_id, seq, kind, message_id, body) VALUES (?, ?, 'token', NULL, ?)").run(runId, seq, body);
      return { ok: true as const, seq };
    });
  }

  appendFinal(runId: string, messageId: string, body: string): { ok: true; seq: number; replaced: boolean } | WorkspaceFailure {
    if (!isId(messageId)) {
      return fail("SCHEMA_INVALID", "消息标识不符合限制");
    }
    return this.transaction(() => {
      if (this.runRow(runId) === undefined) {
        return fail("NOT_FOUND", "执行不存在");
      }
      const existing = this.db.prepare("SELECT seq FROM events WHERE run_id = ? AND message_id = ?").get(runId, messageId);
      this.db.prepare("DELETE FROM events WHERE run_id = ? AND kind = 'token'").run(runId);
      if (existing !== undefined) {
        const seq = cellNumber(existing, "seq");
        this.db.prepare("UPDATE events SET body = ? WHERE run_id = ? AND seq = ?").run(body, runId, seq);
        return { ok: true as const, seq, replaced: true };
      }
      const seq = this.nextSeq(runId);
      this.db
        .prepare("INSERT INTO events (run_id, seq, kind, message_id, body) VALUES (?, ?, 'final', ?, ?)")
        .run(runId, seq, messageId, body);
      return { ok: true as const, seq, replaced: false };
    });
  }

  readEvents(runId: string, afterSeq: number): { seq: number; kind: string; messageId: string | null; body: string }[] {
    const rows = this.db
      .prepare("SELECT seq, kind, message_id, body FROM events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(runId, afterSeq);
    return rows.map((row) => ({
      seq: cellNumber(row, "seq"),
      kind: cellString(row, "kind"),
      messageId: cellNullable(row, "message_id"),
      body: cellString(row, "body"),
    }));
  }

  projectEvent(runId: string, seq: number, body: string): { ok: true; replayed: boolean } | WorkspaceFailure {
    if (!Number.isInteger(seq) || seq < 1) {
      return fail("SCHEMA_INVALID", "事件序号不符合限制");
    }
    return this.transaction(() => {
      if (this.runRow(runId) === undefined) {
        return fail("NOT_FOUND", "执行不存在");
      }
      const existing = this.db.prepare("SELECT body FROM events WHERE run_id = ? AND seq = ?").get(runId, seq);
      if (existing !== undefined) {
        if (cellString(existing, "body") !== body) {
          return fail("IDEMPOTENCY_CONFLICT", "同一事件序号对应了不同内容");
        }
        return { ok: true as const, replayed: true };
      }
      const maxRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE run_id = ?").get(runId);
      const max = maxRow === undefined ? 0 : cellNumber(maxRow, "n");
      if (seq !== max + 1) {
        return fail("SCHEMA_INVALID", "事件序号不连续");
      }
      this.db.prepare("INSERT INTO events (run_id, seq, kind, message_id, body) VALUES (?, ?, 'note', NULL, ?)").run(runId, seq, body);
      return { ok: true as const, replayed: false };
    });
  }

  recordUsage(
    taskId: string,
    usage: { kind: "known"; calls: number; runId: string } | { kind: "unknown"; operationId: string; runId: string },
  ): { ok: true; spentCalls: number; unknownUsageCount: number } | WorkspaceFailure {
    return this.transaction(() => {
      const task = this.taskRow(taskId);
      const run = this.runRow(usage.runId);
      if (task === undefined || run === undefined || cellString(run, "task_id") !== taskId) {
        return fail("NOT_FOUND", "任务或执行不存在");
      }
      if (cellString(run, "status") !== "running") {
        return fail("CANCELLED", "取消后不再发起新调用");
      }
      const spent = cellNumber(task, "spent_calls");
      const limit = cellNumber(task, "budget_limit_calls");
      if (usage.kind === "known") {
        if (!Number.isInteger(usage.calls) || usage.calls < 1 || usage.calls > 100) {
          return fail("SCHEMA_INVALID", "调用次数不符合限制");
        }
        if (spent + usage.calls > limit) {
          hostLog(this.dataDir, "warn", "budget_denied", "任务预算不足，已停止新调用", {
            taskId,
            spentCalls: spent,
            budgetLimitCalls: limit,
          });
          return fail("BUDGET_EXCEEDED", "任务预算已用完");
        }
        this.db.prepare("UPDATE tasks SET spent_calls = ? WHERE task_id = ?").run(spent + usage.calls, taskId);
        return { ok: true as const, spentCalls: spent + usage.calls, unknownUsageCount: this.budgetOf(taskId).unknownUsageCount };
      } else {
        if (!isId(usage.operationId)) {
          return fail("SCHEMA_INVALID", "操作标识不符合限制");
        }
        const existing = this.db.prepare("SELECT operation_id FROM unknown_ops WHERE operation_id = ?").get(usage.operationId);
        if (existing === undefined) {
          this.db.prepare("INSERT INTO unknown_ops (operation_id, task_id, run_id) VALUES (?, ?, ?)").run(usage.operationId, taskId, usage.runId);
          hostLog(this.dataDir, "warn", "usage_unknown", "用量未知，未记为零", { taskId, operationId: usage.operationId });
        }
        const budget = this.budgetOf(taskId);
        return { ok: true as const, spentCalls: budget.spentCalls, unknownUsageCount: budget.unknownUsageCount };
      }
    });
  }

  readBudget(taskId: string):
    | { ok: true; spentCalls: number; unknownUsageCount: number; budgetLimitCalls: number; unknownOperationIds: string[] }
    | WorkspaceFailure {
    const task = this.taskRow(taskId);
    if (task === undefined) {
      return fail("NOT_FOUND", "任务不存在");
    }
    const budget = this.budgetOf(taskId);
    return { ok: true, budgetLimitCalls: cellNumber(task, "budget_limit_calls"), ...budget };
  }

  noteSideEffect(runId: string, filePath: string): { ok: true } | WorkspaceFailure {
    if (!isAbsolute(filePath)) {
      return fail("SCHEMA_INVALID", "副作用路径必须是绝对路径");
    }
    return this.transaction(() => {
      if (this.runRow(runId) === undefined) {
        return fail("NOT_FOUND", "执行不存在");
      }
      this.db.prepare("INSERT OR IGNORE INTO side_effects (run_id, path) VALUES (?, ?)").run(runId, filePath);
      return { ok: true as const };
    });
  }

  cancelRun(
    runId: string,
    reason: "cancel" | "pause" | "budget",
  ): { ok: true; status: RunStatus; controlReason: string; sideEffectPaths: string[] } | WorkspaceFailure {
    return this.transaction(() => {
      const run = this.runRow(runId);
      if (run === undefined) {
        return fail("NOT_FOUND", "执行不存在");
      }
      const paths = this.db.prepare("SELECT path FROM side_effects WHERE run_id = ? ORDER BY path").all(runId).map((row) => cellString(row, "path"));
      const current = cellString(run, "status");
      if (current === "cancelled" || current === "reconcile_required") {
        if (!isRunStatus(current)) {
          throw new Error("执行状态无法识别");
        }
        return { ok: true as const, status: current, controlReason: cellNullable(run, "control_reason") ?? reason, sideEffectPaths: paths };
      }
      const unknown = this.db.prepare("SELECT COUNT(*) AS n FROM unknown_ops WHERE run_id = ?").get(runId);
      const status: RunStatus = unknown !== undefined && cellNumber(unknown, "n") > 0 ? "reconcile_required" : "cancelled";
      this.db.prepare("UPDATE runs SET status = ?, control_reason = ? WHERE run_id = ?").run(status, reason, runId);
      hostLog(this.dataDir, "info", "run_stopped", "执行已停止，已发生的副作用仍保留", {
        runId,
        status,
        reason,
        sideEffects: paths.length,
      });
      return { ok: true as const, status, controlReason: reason, sideEffectPaths: paths };
    });
  }

  checkWriteTarget(taskId: string, path: string): { ok: true } | WorkspaceFailure {
    const task = this.taskRow(taskId);
    if (task === undefined) return fail("NOT_FOUND", "任务不存在");
    const mode = cellString(task, "mode");
    if (mode === "ask" || mode === "plan") return fail("MODE_READONLY", "问答和规划模式不能写文件");
    const grant = this.writeGrant(taskId, path);
    if (grant === undefined) return fail("OUTSIDE_GRANT", "目标不在授权目录内");
    const resolved = this.resolveGrant(grant, path);
    return resolved.ok ? { ok: true } : resolved;
  }

  stageChange(input: {
    changeId: string;
    taskId: string;
    runId: string;
    path: string;
    body: string;
    materialNames: readonly string[];
  }): { ok: true; changeId: string } | WorkspaceFailure {
    if (!isId(input.changeId) || !isAbsolute(input.path)) {
      return fail("SCHEMA_INVALID", "变更标识或路径不符合限制");
    }
    return this.transaction(() => {
      const task = this.taskRow(input.taskId);
      const run = this.runRow(input.runId);
      if (task === undefined || run === undefined || cellString(run, "task_id") !== input.taskId) {
        return fail("NOT_FOUND", "任务或执行不存在");
      }
      const mode = cellString(task, "mode");
      if (mode === "ask" || mode === "plan") {
        hostLog(this.dataDir, "info", "write_refused", "问答或规划模式拒绝暂存写入", { taskId: input.taskId, mode });
        return fail("MODE_READONLY", "问答和规划模式不能写文件");
      }
      const grant = this.writeGrant(input.taskId, input.path);
      if (grant === undefined) {
        return fail("OUTSIDE_GRANT", "目标不在授权目录内");
      }
      const resolved = this.resolveGrant(grant, input.path);
      if (!resolved.ok) {
        return resolved;
      }
      const base = fileDigest(input.path) ?? "";
      this.db
        .prepare(
          `INSERT INTO changes (change_id, task_id, run_id, path, body, base_digest, accepted_digest, material_names, status)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pending')`,
        )
        .run(input.changeId, input.taskId, input.runId, input.path, input.body, base, JSON.stringify(input.materialNames));
      return { ok: true as const, changeId: input.changeId };
    });
  }

  decideChange(
    changeId: string,
    decision: "accept" | "reject",
  ): { ok: true; path: string; status: "accepted" | "rejected" } | WorkspaceFailure {
    const row = this.db.prepare("SELECT * FROM changes WHERE change_id = ?").get(changeId);
    if (row === undefined) {
      return fail("NOT_FOUND", "变更不存在");
    }
    const status = cellString(row, "status");
    if (status === "invalidated") {
      return fail("REVISION_CONFLICT", "目标已修订，待审变更不能提交");
    }
    const path = cellString(row, "path");
    if (decision === "reject") {
      if (status === "accepted") {
        return fail("REVISION_CONFLICT", "已经接受的变更不能再拒绝");
      }
      this.db.prepare("UPDATE changes SET status = 'rejected' WHERE change_id = ?").run(changeId);
      hostLog(this.dataDir, "info", "change_rejected", "已拒绝变更，未提交暂存内容", { changeId });
      return { ok: true, path, status: "rejected" };
    }
    if (status === "accepted") {
      return { ok: true, path, status: "accepted" };
    }
    if (status === "rejected") {
      return fail("REVISION_CONFLICT", "已拒绝的变更不能再接受");
    }
    const names = parseNames(cellString(row, "material_names"));
    const body = cellString(row, "body");
    const checked = checkReport(body, names);
    if (!checked.ok) {
      return fail("CHECK_FAILED", "报告结构未通过", checked.missing);
    }
    const current = fileDigest(path) ?? "";
    if (current !== cellString(row, "base_digest")) {
      return fail("REVISION_CONFLICT", "授权目录里的文件已经变化");
    }
    const task = this.taskRow(cellString(row, "task_id"));
    if (task === undefined) {
      return fail("NOT_FOUND", "任务不存在");
    }
    const grant = this.writeGrant(cellString(row, "task_id"), path);
    if (grant === undefined) {
      return fail("OUTSIDE_GRANT", "目标不在授权目录内");
    }
    const resolved = this.resolveGrant(grant, path);
    if (!resolved.ok) {
      return resolved;
    }
    writeFileSync(path, body, "utf8");
    const accepted = digestText(body);
    this.transaction(() => {
      this.db.prepare("UPDATE changes SET status = 'accepted', accepted_digest = ? WHERE change_id = ?").run(accepted, changeId);
      this.db.prepare("UPDATE runs SET status = 'succeeded' WHERE run_id = ?").run(cellString(row, "run_id"));
    });
    hostLog(this.dataDir, "info", "change_accepted", "审阅通过后已写入报告", { changeId });
    return { ok: true, path, status: "accepted" };
  }

  restoreChange(changeId: string): { ok: true; conflict: false } | WorkspaceFailure {
    const row = this.db.prepare("SELECT * FROM changes WHERE change_id = ?").get(changeId);
    if (row === undefined || cellString(row, "status") !== "accepted") {
      return fail("NOT_FOUND", "没有可恢复的已接受变更");
    }
    const accepted = cellNullable(row, "accepted_digest");
    const path = cellString(row, "path");
    const current = fileDigest(path) ?? "";
    if (accepted === null || current !== accepted) {
      hostLog(this.dataDir, "warn", "restore_conflict", "用户后续编辑与已接受版本冲突", { changeId });
      return fail("REVISION_CONFLICT", "文件在接受之后被修改，恢复已停止");
    }
    return { ok: true, conflict: false };
  }

  readAcceptedFile(changeId: string): { ok: true; path: string; text: string } | WorkspaceFailure {
    const row = this.db.prepare("SELECT * FROM changes WHERE change_id = ?").get(changeId);
    if (row === undefined || cellString(row, "status") !== "accepted") {
      return fail("NOT_FOUND", "没有已接受的文件");
    }
    const path = cellString(row, "path");
    return { ok: true, path, text: readFileSync(path, "utf8") };
  }

  createProject(input: { projectId: string; actorId: string; name: string }): { ok: true } | WorkspaceFailure {
    if (!isId(input.projectId) || !isId(input.actorId) || input.name.length === 0 || input.name.length > 80) {
      return fail("SCHEMA_INVALID", "项目标识不符合限制");
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(input.projectId);
      if (existing !== undefined) {
        return fail("IDEMPOTENCY_CONFLICT", "项目标识已经存在");
      }
      this.db.prepare("INSERT INTO projects (project_id, actor_id, name) VALUES (?, ?, ?)").run(input.projectId, input.actorId, input.name);
      return { ok: true as const };
    });
  }

  attachProject(taskId: string, projectId: string): { ok: true; grantCount: number } | WorkspaceFailure {
    return this.transaction(() => {
      const task = this.taskRow(taskId);
      const project = this.db.prepare("SELECT actor_id FROM projects WHERE project_id = ?").get(projectId);
      if (task === undefined || project === undefined) {
        return fail("NOT_FOUND", "任务或项目不存在");
      }
      if (cellString(project, "actor_id") !== cellString(task, "actor_id")) {
        return fail("PERMISSION_DENIED", "不能把任务挂到其他员工的项目");
      }
      this.db.prepare("UPDATE tasks SET project_id = ? WHERE task_id = ?").run(projectId, taskId);
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE task_id = ?").get(taskId);
      return { ok: true as const, grantCount: count === undefined ? 0 : cellNumber(count, "n") };
    });
  }

  remember(input: {
    memoryId: string;
    actorId: string;
    scope: "personal" | "project" | "org";
    body: string;
    projectId?: string;
    orgId?: string;
  }): { ok: true } | WorkspaceFailure {
    if (!isId(input.memoryId) || !isId(input.actorId) || input.body.length === 0 || input.body.length > 4000) {
      return fail("SCHEMA_INVALID", "记忆标识或正文不符合限制");
    }
    if (input.scope === "project" && (input.projectId === undefined || !isId(input.projectId))) {
      return fail("SCHEMA_INVALID", "项目记忆必须带项目标识");
    }
    if (input.scope === "org" && (input.orgId === undefined || !isId(input.orgId))) {
      return fail("SCHEMA_INVALID", "组织记忆必须带组织标识");
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT memory_id FROM memories WHERE memory_id = ?").get(input.memoryId);
      if (existing !== undefined) {
        return fail("IDEMPOTENCY_CONFLICT", "记忆标识已经存在");
      }
      this.db
        .prepare(
          "INSERT INTO memories (memory_id, actor_id, project_id, org_id, scope, body, revision, deleted) VALUES (?, ?, ?, ?, ?, ?, 1, 0)",
        )
        .run(input.memoryId, input.actorId, input.projectId ?? null, input.orgId ?? null, input.scope, input.body);
      return { ok: true as const };
    });
  }

  editMemory(memoryId: string, body: string): { ok: true; revision: number } | WorkspaceFailure {
    if (body.length === 0 || body.length > 4000) {
      return fail("SCHEMA_INVALID", "记忆正文不符合限制");
    }
    return this.transaction(() => {
      const row = this.db.prepare("SELECT revision, deleted FROM memories WHERE memory_id = ?").get(memoryId);
      if (row === undefined || cellNumber(row, "deleted") === 1) {
        return fail("NOT_FOUND", "记忆不存在");
      }
      const revision = cellNumber(row, "revision") + 1;
      this.db.prepare("UPDATE memories SET body = ?, revision = ? WHERE memory_id = ?").run(body, revision, memoryId);
      return { ok: true as const, revision };
    });
  }

  deleteMemory(memoryId: string): { ok: true } | WorkspaceFailure {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT deleted FROM memories WHERE memory_id = ?").get(memoryId);
      if (row === undefined) {
        return fail("NOT_FOUND", "记忆不存在");
      }
      this.db.prepare("UPDATE memories SET deleted = 1 WHERE memory_id = ?").run(memoryId);
      return { ok: true as const };
    });
  }

  listMemories(input: { actorId: string; projectId: string; orgId: string }):
    | { ok: true; memories: { memoryId: string; scope: string; body: string; revision: number }[] }
    | WorkspaceFailure {
    const rows = this.db
      .prepare(
        `SELECT memory_id, scope, body, revision FROM memories
         WHERE deleted = 0 AND (
           (scope = 'personal' AND actor_id = ?)
           OR (scope = 'project' AND actor_id = ? AND project_id = ?)
           OR (scope = 'org' AND org_id = ?)
         )
         ORDER BY memory_id`,
      )
      .all(input.actorId, input.actorId, input.projectId, input.orgId);
    return {
      ok: true,
      memories: rows.map((row) => ({
        memoryId: cellString(row, "memory_id"),
        scope: cellString(row, "scope"),
        body: cellString(row, "body"),
        revision: cellNumber(row, "revision"),
      })),
    };
  }

  compressTask(taskId: string):
    | { ok: true; owner: "host"; goal: string; acceptance: string; budgetSpentCalls: number; unknownOperationIds: string[] }
    | WorkspaceFailure {
    return this.transaction(() => {
      const task = this.taskRow(taskId);
      if (task === undefined) {
        return fail("NOT_FOUND", "任务不存在");
      }
      const budget = this.budgetOf(taskId);
      const snapshot = {
        owner: "host" as const,
        goal: cellString(task, "goal"),
        acceptance: cellString(task, "acceptance"),
        budgetSpentCalls: budget.spentCalls,
        unknownOperationIds: budget.unknownOperationIds,
      };
      this.db
        .prepare(
          `INSERT INTO context_snapshots (task_id, owner, goal, acceptance, budget_spent_calls, unknown_operation_ids)
           VALUES (?, 'host', ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             goal = excluded.goal,
             acceptance = excluded.acceptance,
             budget_spent_calls = excluded.budget_spent_calls,
             unknown_operation_ids = excluded.unknown_operation_ids`,
        )
        .run(taskId, snapshot.goal, snapshot.acceptance, snapshot.budgetSpentCalls, JSON.stringify(snapshot.unknownOperationIds));
      return { ok: true as const, ...snapshot };
    });
  }

  readCompression(taskId: string):
    | { ok: true; owner: "host"; goal: string; acceptance: string; budgetSpentCalls: number; unknownOperationIds: string[] }
    | WorkspaceFailure {
    const row = this.db.prepare("SELECT * FROM context_snapshots WHERE task_id = ?").get(taskId);
    if (row === undefined) {
      return fail("NOT_FOUND", "还没有压缩快照");
    }
    return {
      ok: true,
      owner: "host",
      goal: cellString(row, "goal"),
      acceptance: cellString(row, "acceptance"),
      budgetSpentCalls: cellNumber(row, "budget_spent_calls"),
      unknownOperationIds: parseNames(cellString(row, "unknown_operation_ids")),
    };
  }

  selectWikiSource(input: {
    sourceId: string;
    pageId: string;
    actorId: string;
    filePath: string;
    maintenance: boolean;
  }): { ok: true; revision: number } | WorkspaceFailure {
    if (!isId(input.sourceId) || !isId(input.pageId) || !isId(input.actorId) || !isAbsolute(input.filePath)) {
      return fail("SCHEMA_INVALID", "来源标识或路径不符合限制");
    }
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(input.filePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return fail("NOT_FOUND", "来源文件不存在");
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      return fail("DIRECTORY_NOT_ALLOWED", "来源不能是符号链接");
    }
    if (stat.isDirectory()) {
      return fail("DIRECTORY_NOT_ALLOWED", "来源必须是明确选出的文件，不能选目录");
    }
    if (!stat.isFile()) {
      return fail("DIRECTORY_NOT_ALLOWED", "来源必须是明确选出的文件");
    }
    const text = readFileSync(input.filePath, "utf8");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT source_id FROM wiki_sources WHERE source_id = ?").get(input.sourceId);
      if (existing !== undefined) {
        return fail("IDEMPOTENCY_CONFLICT", "来源标识已经存在");
      }
      this.db
        .prepare(
          "INSERT INTO wiki_sources (source_id, page_id, actor_id, path, origin_digest, maintenance) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(input.sourceId, input.pageId, input.actorId, input.filePath, digestText(text), input.maintenance ? 1 : 0);
      this.db
        .prepare("INSERT INTO wiki_pages (page_id, revision, actor_id, body, origin, base_revision) VALUES (?, 1, ?, ?, 'import', 0)")
        .run(input.pageId, input.actorId, text);
      return { ok: true as const, revision: 1 };
    });
  }

  reviseWiki(input: {
    pageId: string;
    actorId: string;
    body: string;
    origin: "human" | "auto";
    baseRevision: number;
  }): { ok: true; revision: number } | WorkspaceFailure {
    if (input.body.length === 0 || input.body.length > 100000) {
      return fail("SCHEMA_INVALID", "笔记正文不符合限制");
    }
    return this.transaction(() => {
      const source = this.db.prepare("SELECT * FROM wiki_sources WHERE page_id = ? AND actor_id = ?").get(input.pageId, input.actorId);
      if (source === undefined) {
        return fail("NOT_FOUND", "笔记不存在");
      }
      const latest = this.latestWikiRevision(input.pageId);
      if (latest >= WIKI_REVISION_CAP) {
        return fail("CAP_REACHED", "笔记修订已达工程上限");
      }
      if (input.origin === "auto" && cellNumber(source, "maintenance") !== 1) {
        return fail("MAINTENANCE_DENIED", "没有维护授权，不能自动改笔记");
      }
      const originPath = cellString(source, "path");
      const originNow = fileDigest(originPath);
      if (originNow !== cellString(source, "origin_digest")) {
        return fail("SOURCE_CHANGED", "原件已变化，笔记没有回写原件");
      }
      if (input.baseRevision !== latest) {
        hostLog(this.dataDir, "warn", "wiki_conflict", "自动维护与人工修订冲突", { pageId: input.pageId });
        return fail("WIKI_CONFLICT", "笔记已有更新的修订");
      }
      const revision = latest + 1;
      this.db
        .prepare("INSERT INTO wiki_pages (page_id, revision, actor_id, body, origin, base_revision) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.pageId, revision, input.actorId, input.body, input.origin, input.baseRevision);
      return { ok: true as const, revision };
    });
  }

  listWikiRevisions(pageId: string): { revision: number; origin: string; body: string }[] {
    const rows = this.db
      .prepare("SELECT revision, origin, body FROM wiki_pages WHERE page_id = ? ORDER BY revision")
      .all(pageId);
    return rows.map((row) => ({
      revision: cellNumber(row, "revision"),
      origin: cellString(row, "origin"),
      body: cellString(row, "body"),
    }));
  }

  citeWiki(pageId: string): { ok: true; pageId: string; revision: number; excerpt: string } | WorkspaceFailure {
    const row = this.db
      .prepare("SELECT revision, body FROM wiki_pages WHERE page_id = ? ORDER BY revision DESC LIMIT 1")
      .get(pageId);
    if (row === undefined) {
      return fail("NOT_FOUND", "笔记不存在");
    }
    return { ok: true, pageId, revision: cellNumber(row, "revision"), excerpt: cellString(row, "body").slice(0, 80) };
  }

  listWiki(actorId: string): { pageId: string; path: string; revision: number }[] {
    const rows = this.db
      .prepare(
        `SELECT s.page_id, s.path, MAX(p.revision) AS revision
         FROM wiki_sources s
         JOIN wiki_pages p ON p.page_id = s.page_id
         WHERE s.actor_id = ?
         GROUP BY s.page_id, s.path
         ORDER BY s.page_id`,
      )
      .all(actorId);
    return rows.map((row) => ({
      pageId: cellString(row, "page_id"),
      path: cellString(row, "path"),
      revision: cellNumber(row, "revision"),
    }));
  }

  readWorkbench(actorId: string): {
    ok: true;
    tasks: {
      taskId: string;
      goal: string;
      mode: string;
      revisionId: string;
      spentCalls: number;
      unknownUsageCount: number;
      budgetLimitCalls: number;
      runId: string | null;
      runStatus: string | null;
      inputs: { seq: number; body: string; consumed: boolean; source: string; commandId: string | null }[];
    }[];
    changes: { changeId: string; taskId: string; path: string; status: string }[];
    wiki: { pageId: string; path: string; revision: number; excerpt: string }[];
  } {
    const tasks = this.db.prepare("SELECT * FROM tasks WHERE actor_id = ? ORDER BY created_at").all(actorId);
    return {
      ok: true,
      tasks: tasks.map((task) => {
        const taskId = cellString(task, "task_id");
        const run = this.db.prepare("SELECT run_id, status FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1").get(taskId);
        const inputs = this.db
          .prepare("SELECT seq, body, consumed, source, command_id FROM inputs WHERE task_id = ? ORDER BY seq")
          .all(taskId);
        const budget = this.budgetOf(taskId);
        return {
          taskId,
          goal: cellString(task, "goal"),
          mode: cellString(task, "mode"),
          revisionId: cellString(task, "revision_id"),
          spentCalls: budget.spentCalls,
          unknownUsageCount: budget.unknownUsageCount,
          budgetLimitCalls: cellNumber(task, "budget_limit_calls"),
          runId: run === undefined ? null : cellString(run, "run_id"),
          runStatus: run === undefined ? null : cellString(run, "status"),
          inputs: inputs.map((item) => ({
            seq: cellNumber(item, "seq"),
            body: cellString(item, "body"),
            consumed: cellNumber(item, "consumed") === 1,
            source: cellString(item, "source"),
            commandId: cellNullable(item, "command_id"),
          })),
        };
      }),
      changes: this.db
        .prepare(
          `SELECT c.change_id, c.task_id, c.path, c.status
           FROM changes c JOIN tasks t ON t.task_id = c.task_id
           WHERE t.actor_id = ?
           ORDER BY c.change_id`,
        )
        .all(actorId)
        .map((row) => ({
          changeId: cellString(row, "change_id"),
          taskId: cellString(row, "task_id"),
          path: cellString(row, "path"),
          status: cellString(row, "status"),
        })),
      wiki: this.listWiki(actorId).map((page) => {
        const cited = this.citeWiki(page.pageId);
        return {
          pageId: page.pageId,
          path: page.path,
          revision: page.revision,
          excerpt: cited.ok ? cited.excerpt : "",
        };
      }),
    };
  }

  private ensureSchema(): void {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (table === undefined) {
      this.db.exec(SCHEMA);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', '2')").run();
      return;
    }
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (version === undefined) {
      throw new Error("工作区数据库版本无法识别");
    }
    let current = cellString(version, "value");
    if (current === "1") {
      this.db.exec("ALTER TABLE inputs ADD COLUMN source TEXT NOT NULL DEFAULT 'desktop'");
      this.db.exec("ALTER TABLE inputs ADD COLUMN command_id TEXT");
      this.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema'").run();
      current = "2";
      hostLog(this.dataDir, "info", "workspace_schema_migrated", "工作区库已升到输入来源 schema", { version: 2 });
    }
    const numeric = Number(current);
    if (!Number.isInteger(numeric) || numeric < 1) {
      throw new Error("工作区数据库版本无法识别");
    }
    if (numeric > 2) {
      hostLog(this.dataDir, "error", "workspace_schema_incompatible", "工作区 schema 高于本机支持，拒绝写入", {
        version: numeric,
        supported: 2,
      });
      throw new Error(`工作区 schema ${numeric} 高于本机支持的 2，已保留原文件并拒绝打开`);
    }
    if (current !== "2") {
      throw new Error("工作区数据库版本无法识别");
    }
  }

  private reconcile(): string[] {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT run_id FROM runs WHERE status IN (${placeholders})`).all(...ACTIVE_STATUSES);
    const ids = rows.map((row) => cellString(row, "run_id"));
    if (ids.length > 0) {
      this.transaction(() => {
        const update = this.db.prepare("UPDATE runs SET status = 'interrupted', control_reason = 'restart' WHERE run_id = ?");
        for (const id of ids) {
          update.run(id);
        }
      });
      hostLog(this.dataDir, "warn", "run_interrupted", "重启后未结束的执行已标为中断", { interrupted: ids.length });
    } else {
      hostLog(this.dataDir, "info", "workspace_open", "工作区已打开", { interrupted: 0 });
    }
    return ids;
  }

  private insertRun(input: {
    taskId: string;
    runId: string;
    idempotencyKey: string;
    expectedRevisionId: string;
  }): { ok: true; runId: string; attempt: number; status: RunStatus; replayed: boolean } | WorkspaceFailure {
    const task = this.taskRow(input.taskId);
    if (task === undefined) {
      return fail("NOT_FOUND", "任务不存在");
    }
    const actorId = cellString(task, "actor_id");
    const existing = this.db.prepare("SELECT * FROM runs WHERE actor_id = ? AND idempotency_key = ?").get(actorId, input.idempotencyKey);
    if (existing !== undefined) {
      if (cellString(existing, "task_id") !== input.taskId) {
        return fail("IDEMPOTENCY_CONFLICT", "同一幂等键对应了不同任务");
      }
      const status = cellString(existing, "status");
      if (!isRunStatus(status)) {
        throw new Error("执行状态无法识别");
      }
      return { ok: true, runId: cellString(existing, "run_id"), attempt: cellNumber(existing, "attempt"), status, replayed: true };
    }
    const reconcile = this.db.prepare("SELECT run_id FROM runs WHERE task_id = ? AND status = 'reconcile_required' LIMIT 1").get(input.taskId);
    if (reconcile !== undefined) {
      return fail("RECONCILE_REQUIRED", "有待核实的结果，不能另起执行");
    }
    const active = this.db
      .prepare(
        `SELECT run_id FROM runs WHERE actor_id = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")}) LIMIT 1`,
      )
      .get(actorId, ...ACTIVE_STATUSES);
    if (active !== undefined) {
      return fail("SLOT_BUSY", "同一员工已有进行中的执行");
    }
    if (cellString(task, "revision_id") !== input.expectedRevisionId) {
      return fail("REVISION_CONFLICT", "任务修订与预期不一致");
    }
    const attemptRow = this.db.prepare("SELECT COALESCE(MAX(attempt), 0) AS n FROM runs WHERE task_id = ?").get(input.taskId);
    const attempt = (attemptRow === undefined ? 0 : cellNumber(attemptRow, "n")) + 1;
    this.db
      .prepare(
        `INSERT INTO runs (run_id, task_id, actor_id, attempt, revision_id, status, control_reason, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?)`,
      )
      .run(input.runId, input.taskId, actorId, attempt, input.expectedRevisionId, input.idempotencyKey, new Date().toISOString());
    hostLog(this.dataDir, "info", "run_started", "执行已占用活动槽", { taskId: input.taskId, runId: input.runId, attempt });
    return { ok: true, runId: input.runId, attempt, status: "running", replayed: false };
  }

  private budgetOf(taskId: string): { spentCalls: number; unknownUsageCount: number; unknownOperationIds: string[] } {
    const task = this.taskRow(taskId);
    const rows = this.db.prepare("SELECT operation_id FROM unknown_ops WHERE task_id = ? ORDER BY operation_id").all(taskId);
    const unknownOperationIds = rows.map((row) => cellString(row, "operation_id"));
    return {
      spentCalls: task === undefined ? 0 : cellNumber(task, "spent_calls"),
      unknownUsageCount: unknownOperationIds.length,
      unknownOperationIds,
    };
  }

  private writeGrant(taskId: string, target: string): { kind: "directory" | "file"; path: string } | undefined {
    const rows = this.db.prepare("SELECT kind, path FROM grants WHERE task_id = ? AND access = 'write'").all(taskId);
    for (const row of rows) {
      const kind = cellString(row, "kind");
      const path = cellString(row, "path");
      if (kind === "directory" && (isPathInside(path, target) || isPathInside(realGrant(path), target))) {
        return { kind: "directory", path };
      }
      if (kind === "file" && path === target) {
        return { kind: "file", path };
      }
    }
    return undefined;
  }

  private resolveGrant(
    grant: { kind: "directory" | "file"; path: string },
    target: string,
  ): { ok: true; realTarget: string } | WorkspaceFailure {
    try {
      if (grant.kind === "directory") {
        if (!existsSync(grant.path)) {
          return fail("OUTSIDE_GRANT", "授权目录不存在");
        }
        const resolved = resolveWriteTarget(grant.path, target);
        if (!resolved.ok) {
          return fail("OUTSIDE_GRANT", resolved.message);
        }
        return resolved;
      }
      if (!existsSync(target) && !existsSync(grant.path)) {
        return fail("OUTSIDE_GRANT", "授权文件不存在");
      }
      return { ok: true, realTarget: target };
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法解析授权路径";
      return fail("OUTSIDE_GRANT", message);
    }
  }

  private latestWikiRevision(pageId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS n FROM wiki_pages WHERE page_id = ?").get(pageId);
    return row === undefined ? 0 : cellNumber(row, "n");
  }

  private nextSeq(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE run_id = ?").get(runId);
    return (row === undefined ? 0 : cellNumber(row, "n")) + 1;
  }

  private taskRow(taskId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
  }

  private runRow(runId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : "回滚失败";
        process.stderr.write(`${JSON.stringify({ level: "error", event: "rollback_failed", message })}\n`);
      }
      throw error;
    }
  }
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/$/, "")}/${name}`;
}

export function openLocalWorkspace(dataDir: string): LocalWorkspace {
  return LocalWorkspace.open(dataDir);
}

function realGrant(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    return path;
  }
}

function parseNames(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("名单无法识别");
  }
  return parsed;
}

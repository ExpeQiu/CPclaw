import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hostLog } from "./host-log.js";

/** 日志 Outbox 工程上限。业务配额还没确认，这不是验收通过线。 */
export const LOG_QUEUE_CAP = 64;
/** 单批上传条数工程上限。 */
export const LOG_BATCH_MAX = 16;

export type SyncFailure = { ok: false; code: string; message: string };

export type UploadJobView = {
  jobId: string;
  employeeId: string;
  purpose: string;
  contentSha256: string;
  byteSize: number;
  status: "queued" | "uploading" | "available" | "cancelled" | "failed";
  snapshot: string;
  uploadId?: string;
  fileId?: string;
};

export type LogOutboxEvent = {
  seq: number;
  event: string;
  message: string;
  fields?: Record<string, string | number | boolean>;
};

export type LogBatchPayload = {
  batchId: string;
  deviceEpoch: string;
  cursorFrom: number;
  events: LogOutboxEvent[];
};

const SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE upload_jobs (
  job_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  upload_id TEXT,
  file_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE log_outbox (
  employee_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  fields_json TEXT,
  status TEXT NOT NULL,
  PRIMARY KEY (employee_id, seq)
) STRICT;
CREATE TABLE sync_cursors (
  employee_id TEXT PRIMARY KEY,
  device_epoch TEXT NOT NULL,
  confirmed_seq INTEGER NOT NULL,
  next_seq INTEGER NOT NULL,
  gap_from INTEGER,
  gap_to INTEGER,
  dropped INTEGER NOT NULL
) STRICT;
CREATE TABLE pending_batches (
  batch_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  cursor_from INTEGER NOT NULL,
  cursor_to INTEGER NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
`;

function fail(code: string, message: string): SyncFailure {
  return { ok: false, code, message };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rowOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function textOf(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function numberOf(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(/\/Users\/[^\s]+/g, "[path]")
    .replace(/token[=:]\s*\S+/gi, "token=[redacted]")
    .slice(0, 200);
}

export type SyncStore = {
  createUploadJob(input: {
    employeeId: string;
    purpose: string;
    content: string;
  }): { ok: true; job: UploadJobView } | SyncFailure;
  bindUploadSession(jobId: string, uploadId: string): { ok: true; job: UploadJobView } | SyncFailure;
  markUploadAvailable(jobId: string, fileId: string): { ok: true; job: UploadJobView } | SyncFailure;
  cancelUploadJob(jobId: string): { ok: true; job: UploadJobView } | SyncFailure;
  getUploadJob(jobId: string): { ok: true; job: UploadJobView } | SyncFailure;
  enqueueLog(
    employeeId: string,
    event: string,
    message: string,
    fields?: Record<string, string | number | boolean>,
  ): { ok: true; seq: number; dropped: boolean; gap?: { from: number; to: number } } | SyncFailure;
  buildLogBatch(employeeId: string): { ok: true; batch: LogBatchPayload | null } | SyncFailure;
  ackLogBatch(employeeId: string, batchId: string, acceptedThrough: number): { ok: true } | SyncFailure;
  readCursor(employeeId: string): {
    deviceEpoch: string;
    confirmedSeq: number;
    nextSeq: number;
    dropped: number;
    gap?: { from: number; to: number };
  };
  close(): void;
};

export function openSyncStore(dataDir: string): SyncStore {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "sync.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = DELETE");
  const meta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (meta === undefined) {
    db.exec(SCHEMA);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', '1')").run();
  }

  function ensureCursor(employeeId: string): void {
    const existing = db.prepare("SELECT employee_id FROM sync_cursors WHERE employee_id = ?").get(employeeId);
    if (existing === undefined) {
      const epoch = `ep-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      db.prepare(
        "INSERT INTO sync_cursors (employee_id, device_epoch, confirmed_seq, next_seq, dropped) VALUES (?, ?, 0, 1, 0)",
      ).run(employeeId, epoch);
    }
  }

  function jobView(row: Record<string, unknown>): UploadJobView | undefined {
    const jobId = textOf(row, "job_id");
    const employeeId = textOf(row, "employee_id");
    const purpose = textOf(row, "purpose");
    const contentSha256 = textOf(row, "content_sha256");
    const byteSize = numberOf(row, "byte_size");
    const snapshot = textOf(row, "snapshot");
    const status = textOf(row, "status");
    if (
      jobId === undefined ||
      employeeId === undefined ||
      purpose === undefined ||
      contentSha256 === undefined ||
      byteSize === undefined ||
      snapshot === undefined ||
      status === undefined
    ) {
      return undefined;
    }
    const view: UploadJobView = {
      jobId,
      employeeId,
      purpose,
      contentSha256,
      byteSize,
      snapshot,
      status: status as UploadJobView["status"],
    };
    const uploadId = textOf(row, "upload_id");
    const fileId = textOf(row, "file_id");
    if (uploadId !== undefined) {
      view.uploadId = uploadId;
    }
    if (fileId !== undefined) {
      view.fileId = fileId;
    }
    return view;
  }

  const store: SyncStore = {
    createUploadJob(input) {
      const snapshot = input.content;
      const contentSha256 = sha256(snapshot);
      const byteSize = Buffer.byteLength(snapshot, "utf8");
      const jobId = `job-${randomUUID().replaceAll("-", "")}`;
      db.prepare(
        `INSERT INTO upload_jobs (
          job_id, employee_id, purpose, content_sha256, byte_size, snapshot, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).run(jobId, input.employeeId, input.purpose, contentSha256, byteSize, snapshot, new Date().toISOString());
      hostLog(dataDir, "info", "upload_job_created", "已固定上传快照", {
        jobId,
        employeeId: input.employeeId,
        byteSize,
      });
      return {
        ok: true,
        job: {
          jobId,
          employeeId: input.employeeId,
          purpose: input.purpose,
          contentSha256,
          byteSize,
          snapshot,
          status: "queued",
        },
      };
    },

    bindUploadSession(jobId, uploadId) {
      const row = rowOf(db.prepare("SELECT * FROM upload_jobs WHERE job_id = ?").get(jobId));
      if (row === undefined) {
        return fail("NOT_FOUND", "没有这个上传作业");
      }
      if (textOf(row, "status") === "cancelled") {
        return fail("CONFLICT", "作业已取消");
      }
      db.prepare("UPDATE upload_jobs SET upload_id = ?, status = 'uploading' WHERE job_id = ?").run(uploadId, jobId);
      const next = rowOf(db.prepare("SELECT * FROM upload_jobs WHERE job_id = ?").get(jobId));
      const view = next === undefined ? undefined : jobView(next);
      return view === undefined ? fail("CONFIG_INVALID", "作业无法读取") : { ok: true, job: view };
    },

    markUploadAvailable(jobId, fileId) {
      const row = rowOf(db.prepare("SELECT * FROM upload_jobs WHERE job_id = ?").get(jobId));
      if (row === undefined) {
        return fail("NOT_FOUND", "没有这个上传作业");
      }
      if (textOf(row, "status") === "cancelled") {
        return fail("CONFLICT", "作业已取消，不能标为可用");
      }
      db.prepare("UPDATE upload_jobs SET status = 'available', file_id = ? WHERE job_id = ?").run(fileId, jobId);
      const next = rowOf(db.prepare("SELECT * FROM upload_jobs WHERE job_id = ?").get(jobId));
      const view = next === undefined ? undefined : jobView(next);
      return view === undefined ? fail("CONFIG_INVALID", "作业无法读取") : { ok: true, job: view };
    },

    cancelUploadJob(jobId) {
      const row = rowOf(db.prepare("SELECT * FROM upload_jobs WHERE job_id = ?").get(jobId));
      if (row === undefined) {
        return fail("NOT_FOUND", "没有这个上传作业");
      }
      if (textOf(row, "status") === "available") {
        return fail("CONFLICT", "已可用的资源不能取消成未创建");
      }
      db.prepare("UPDATE upload_jobs SET status = 'cancelled' WHERE job_id = ?").run(jobId);
      const next = rowOf(db.prepare("SELECT * FROM upload_jobs WHERE job_id = ?").get(jobId));
      const view = next === undefined ? undefined : jobView(next);
      return view === undefined ? fail("CONFIG_INVALID", "作业无法读取") : { ok: true, job: view };
    },

    getUploadJob(jobId) {
      const row = rowOf(db.prepare("SELECT * FROM upload_jobs WHERE job_id = ?").get(jobId));
      if (row === undefined) {
        return fail("NOT_FOUND", "没有这个上传作业");
      }
      const view = jobView(row);
      return view === undefined ? fail("CONFIG_INVALID", "作业无法读取") : { ok: true, job: view };
    },

    enqueueLog(employeeId, event, message, fields) {
      ensureCursor(employeeId);
      const cursor = rowOf(db.prepare("SELECT * FROM sync_cursors WHERE employee_id = ?").get(employeeId));
      if (cursor === undefined) {
        return fail("CONFIG_INVALID", "同步游标无法读取");
      }
      const pending = numberOf(
        rowOf(
          db
            .prepare("SELECT COUNT(*) AS n FROM log_outbox WHERE employee_id = ? AND status = 'pending'")
            .get(employeeId),
        ) ?? {},
        "n",
      );
      const nextSeq = numberOf(cursor, "next_seq");
      if (nextSeq === undefined) {
        return fail("CONFIG_INVALID", "同步序号无法读取");
      }
      if ((pending ?? 0) >= LOG_QUEUE_CAP) {
        const gapFrom = nextSeq;
        const gapTo = nextSeq;
        db.prepare(
          "UPDATE sync_cursors SET next_seq = next_seq + 1, dropped = dropped + 1, gap_from = COALESCE(gap_from, ?), gap_to = ? WHERE employee_id = ?",
        ).run(gapFrom, gapTo, employeeId);
        hostLog(dataDir, "warn", "log_queue_full", "日志队列已满，记录缺口", {
          employeeId,
          gapFrom,
          gapTo,
        });
        return { ok: true, seq: gapFrom, dropped: true, gap: { from: gapFrom, to: gapTo } };
      }
      const clean = sanitizeMessage(message);
      db.prepare(
        "INSERT INTO log_outbox (employee_id, seq, event, message, fields_json, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      ).run(employeeId, nextSeq, event, clean, fields === undefined ? null : JSON.stringify(fields));
      db.prepare("UPDATE sync_cursors SET next_seq = ? WHERE employee_id = ?").run(nextSeq + 1, employeeId);
      return { ok: true, seq: nextSeq, dropped: false };
    },

    buildLogBatch(employeeId) {
      ensureCursor(employeeId);
      const cursor = rowOf(db.prepare("SELECT * FROM sync_cursors WHERE employee_id = ?").get(employeeId));
      if (cursor === undefined) {
        return fail("CONFIG_INVALID", "同步游标无法读取");
      }
      const deviceEpoch = textOf(cursor, "device_epoch");
      const confirmedSeq = numberOf(cursor, "confirmed_seq");
      if (deviceEpoch === undefined || confirmedSeq === undefined) {
        return fail("CONFIG_INVALID", "同步游标无法读取");
      }
      const rows = db
        .prepare(
          `SELECT seq, event, message, fields_json FROM log_outbox
           WHERE employee_id = ? AND status = 'pending' AND seq > ?
           ORDER BY seq LIMIT ?`,
        )
        .all(employeeId, confirmedSeq, LOG_BATCH_MAX);
      if (rows.length === 0) {
        return { ok: true, batch: null };
      }
      const events: LogOutboxEvent[] = [];
      for (const item of rows) {
        const row = rowOf(item);
        if (row === undefined) {
          continue;
        }
        const seq = numberOf(row, "seq");
        const event = textOf(row, "event");
        const message = textOf(row, "message");
        if (seq === undefined || event === undefined || message === undefined) {
          continue;
        }
        const entry: LogOutboxEvent = { seq, event, message };
        const fieldsJson = textOf(row, "fields_json");
        if (fieldsJson !== undefined) {
          try {
            const parsed: unknown = JSON.parse(fieldsJson);
            if (typeof parsed === "object" && parsed !== null) {
              entry.fields = parsed as Record<string, string | number | boolean>;
            }
          } catch {
            // 字段损坏时仍上传事件本体。
          }
        }
        events.push(entry);
      }
      const firstEvent = events[0];
      const lastEvent = events[events.length - 1];
      if (firstEvent === undefined || lastEvent === undefined) {
        return { ok: true, batch: null };
      }
      const cursorFrom = firstEvent.seq;
      const cursorTo = lastEvent.seq;
      const batchId = `batch-${employeeId}-${cursorFrom}-${cursorTo}`;
      const batch: LogBatchPayload = { batchId, deviceEpoch, cursorFrom, events };
      db.prepare(
        `INSERT INTO pending_batches (batch_id, employee_id, cursor_from, cursor_to, payload_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(batch_id) DO UPDATE SET payload_json = excluded.payload_json`,
      ).run(batchId, employeeId, cursorFrom, cursorTo, JSON.stringify(batch));
      return { ok: true, batch };
    },

    ackLogBatch(employeeId, batchId, acceptedThrough) {
      const pending = rowOf(db.prepare("SELECT * FROM pending_batches WHERE batch_id = ?").get(batchId));
      if (pending === undefined || textOf(pending, "employee_id") !== employeeId) {
        return fail("NOT_FOUND", "没有这个待确认批次");
      }
      const cursorTo = numberOf(pending, "cursor_to");
      if (cursorTo === undefined || acceptedThrough !== cursorTo) {
        return fail("CONFLICT", "回执位置与批次不一致，不推进游标");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE log_outbox SET status = 'acked' WHERE employee_id = ? AND seq >= ? AND seq <= ?",
        ).run(employeeId, numberOf(pending, "cursor_from") ?? 0, cursorTo);
        db.prepare("UPDATE sync_cursors SET confirmed_seq = ? WHERE employee_id = ?").run(acceptedThrough, employeeId);
        db.prepare("DELETE FROM pending_batches WHERE batch_id = ?").run(batchId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      hostLog(dataDir, "info", "log_batch_acked", "日志批次已确认", {
        employeeId,
        batchId,
        acceptedThrough,
      });
      return { ok: true };
    },

    readCursor(employeeId) {
      ensureCursor(employeeId);
      const cursor = rowOf(db.prepare("SELECT * FROM sync_cursors WHERE employee_id = ?").get(employeeId));
      if (cursor === undefined) {
        return { deviceEpoch: "missing", confirmedSeq: 0, nextSeq: 1, dropped: 0 };
      }
      const result: {
        deviceEpoch: string;
        confirmedSeq: number;
        nextSeq: number;
        dropped: number;
        gap?: { from: number; to: number };
      } = {
        deviceEpoch: textOf(cursor, "device_epoch") ?? "missing",
        confirmedSeq: numberOf(cursor, "confirmed_seq") ?? 0,
        nextSeq: numberOf(cursor, "next_seq") ?? 1,
        dropped: numberOf(cursor, "dropped") ?? 0,
      };
      const gapFrom = numberOf(cursor, "gap_from");
      const gapTo = numberOf(cursor, "gap_to");
      if (gapFrom !== undefined && gapTo !== undefined) {
        result.gap = { from: gapFrom, to: gapTo };
      }
      return result;
    },

    close() {
      db.close();
    },
  };

  return store;
}

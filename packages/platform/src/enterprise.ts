import { createMarket } from './market.js';
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PlatformConfig } from "./config.js";
import { platformLog } from "./log.js";

/** 单件上传工程上限。业务配额还没确认，这不是验收通过线。 */
export const MAX_UPLOAD_BYTES = 256 * 1024;
/** 日志单批条数工程上限。 */
export const LOG_BATCH_MAX_EVENTS = 16;

export type UploadPurpose = "artifact" | "skill" | "learning" | "knowledge";
export type UploadStatus =
  | "preparing"
  | "uploading"
  | "checking"
  | "available"
  | "failed"
  | "cancelling"
  | "cancelled";

export type PlatformCode =
  | "AUTH_REQUIRED"
  | "SESSION_REVOKED"
  | "FORBIDDEN"
  | "QUOTA_EXCEEDED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONFIG_INVALID";

export type PlatformFailure = { ok: false; code: PlatformCode; message: string };

type Principal = {
  ok: true;
  sessionId: string;
  employeeId: string;
  orgId: string;
  role: "admin" | "employee";
};

export type UploadView = {
  uploadId: string;
  purpose: UploadPurpose;
  status: UploadStatus;
  contentSha256: string;
  byteSize: number;
  fileId?: string;
  resourceId?: string;
};

export type LogBatchReceipt = {
  batchId: string;
  acceptedThrough: number;
  duplicate: boolean;
};

export type SkillReleaseView = {
  skillId: string;
  version: string;
  contentSha256: string;
  platforms: string[];
  status: "published" | "retired";
};

export type KnowledgeHit = {
  docId: string;
  version: number;
  title: string;
  locator: string;
  excerpt: string;
};

export type WikiPageView = {
  pageId: string;
  revision: number;
  title: string;
  status: "draft" | "pending" | "published" | "rejected";
  sourceDocIds: string[];
  body: string;
};

export type LearningCandidateView = {
  candidateId: string;
  kind: "experience" | "memory" | "skill";
  status: "pending" | "published" | "rejected" | "superseded";
  version: number;
  authorId: string;
};

export type OrgResourceView = {
  resourceId: string;
  kind: "experience" | "memory" | "skill";
  version: number;
  title: string;
  status: "active" | "retired";
};

export const ENTERPRISE_SCHEMA = `
CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  staging_path TEXT,
  file_id TEXT,
  resource_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_idem ON upload_sessions(employee_id, idempotency_key);
CREATE TABLE IF NOT EXISTS private_files (
  file_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS log_batches (
  batch_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  device_epoch TEXT NOT NULL,
  cursor_from INTEGER NOT NULL,
  cursor_to INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  skill_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_releases (
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  org_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  platforms TEXT NOT NULL,
  package_body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (skill_id, version)
);
CREATE TABLE IF NOT EXISTS skill_submissions (
  submission_id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  org_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  platforms TEXT NOT NULL,
  package_body TEXT NOT NULL,
  status TEXT NOT NULL,
  review_note TEXT,
  approved_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  doc_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  acl_group TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_acl (
  org_id TEXT NOT NULL,
  acl_group TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  PRIMARY KEY (org_id, acl_group, employee_id)
);
CREATE TABLE IF NOT EXISTS wiki_pages (
  page_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_doc_ids TEXT NOT NULL,
  status TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, revision)
);
CREATE TABLE IF NOT EXISTS wiki_published (
  page_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_policy (
  org_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_candidates (
  candidate_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  source_task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS org_resources (
  resource_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  candidate_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  helpful INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
`;

function failure(code: PlatformCode, message: string): PlatformFailure {
  return { ok: false, code, message };
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

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function purposeOk(value: string): value is UploadPurpose {
  return value === "artifact" || value === "skill" || value === "learning" || value === "knowledge";
}

function idOk(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      const message = rollbackError instanceof Error ? rollbackError.message : "回滚失败";
      throw new Error(`回滚失败: ${message}`);
    }
    throw error;
  }
}

export function ensureEnterpriseSchema(db: DatabaseSync): void {
  db.exec(ENTERPRISE_SCHEMA);
}

export function seedKnowledgeAcl(db: DatabaseSync): void {
  const existing = rowOf(db.prepare("SELECT employee_id FROM knowledge_acl LIMIT 1").get());
  if (existing !== undefined) {
    return;
  }
  db.prepare("INSERT INTO knowledge_acl (org_id, acl_group, employee_id) VALUES (?, ?, ?)").run(
    "org-demo",
    "readers",
    "employee-a",
  );
  db.prepare("INSERT INTO knowledge_acl (org_id, acl_group, employee_id) VALUES (?, ?, ?)").run(
    "org-demo",
    "readers",
    "employee-b",
  );
  db.prepare("INSERT INTO learning_policy (org_id, enabled, updated_at) VALUES (?, 0, ?)").run(
    "org-demo",
    Date.now(),
  );
  db.prepare("INSERT INTO learning_policy (org_id, enabled, updated_at) VALUES (?, 0, ?)").run(
    "org-other",
    Date.now(),
  );
}

type AuditFn = (orgId: string, actorId: string, action: string, target: string) => void;

export type EnterpriseApi = {
  createUpload(
    actor: Principal,
    input: {
      purpose: string;
      contentSha256: string;
      byteSize: number;
      idempotencyKey: string;
    },
  ): { ok: true; upload: UploadView } | PlatformFailure;
  putUploadContent(actor: Principal, uploadId: string, content: string): { ok: true; upload: UploadView } | PlatformFailure;
  completeUpload(actor: Principal, uploadId: string): { ok: true; upload: UploadView } | PlatformFailure;
  cancelUpload(actor: Principal, uploadId: string): { ok: true; upload: UploadView } | PlatformFailure;
  getUpload(actor: Principal, uploadId: string): { ok: true; upload: UploadView } | PlatformFailure;
  readPrivateFile(actor: Principal, fileId: string): { ok: true; fileId: string; body: string } | PlatformFailure;
  cleanupStaging(actor: Principal): { ok: true; removed: number } | PlatformFailure;
  receiveLogBatch(
    actor: Principal,
    input: {
      batchId: string;
      deviceEpoch: string;
      cursorFrom: number;
      events: Array<{ seq: number; event: string; message: string; fields?: Record<string, string | number | boolean> }>;
    },
  ): { ok: true; receipt: LogBatchReceipt } | PlatformFailure;
  getLogBatchReceipt(actor: Principal, batchId: string): { ok: true; receipt: LogBatchReceipt } | PlatformFailure;
  publishSkillRelease(
    actor: Principal,
    input: { skillId: string; version: string; title: string; platforms: string[]; packageBody: string },
  ): { ok: true; release: SkillReleaseView } | PlatformFailure;
  submitSkill(
    actor: Principal,
    input: { skillId: string; version: string; platforms: string[]; packageBody: string },
  ): { ok: true; submissionId: string; status: string } | PlatformFailure;
  reviseSkillSubmission(
    actor: Principal,
    input: { submissionId: string; packageBody: string; platforms: string[] },
  ): { ok: true; submissionId: string; status: string; approvedRevision: number } | PlatformFailure;
  reviewSkillSubmission(
    actor: Principal,
    input: { submissionId: string; decision: "approve" | "reject"; note?: string },
  ): { ok: true; status: string } | PlatformFailure;
  listAvailableSkills(actor: Principal): { ok: true; skills: SkillReleaseView[] } | PlatformFailure;
  downloadSkillRelease(
    actor: Principal,
    skillId: string,
    version: string,
  ): { ok: true; contentSha256: string; packageBody: string; platforms: string[] } | PlatformFailure;
  ingestKnowledge(
    actor: Principal,
    input: { docId: string; title: string; format: string; body: string; aclGroup: string },
  ): { ok: true; docId: string; version: number } | PlatformFailure;
  searchKnowledge(actor: Principal, query: string): { ok: true; hits: KnowledgeHit[] } | PlatformFailure;
  citeKnowledge(
    actor: Principal,
    docId: string,
    locator: string,
  ): { ok: true; docId: string; version: number; excerpt: string } | PlatformFailure;
  revokeKnowledge(actor: Principal, docId: string): { ok: true } | PlatformFailure;
  draftWiki(
    actor: Principal,
    input: { pageId: string; title: string; body: string; sourceDocIds: string[] },
  ): { ok: true; page: WikiPageView } | PlatformFailure;
  reviseWiki(
    actor: Principal,
    input: { pageId: string; title: string; body: string; sourceDocIds: string[]; baseRevision: number },
  ): { ok: true; page: WikiPageView } | PlatformFailure;
  submitWikiReview(actor: Principal, pageId: string): { ok: true; page: WikiPageView } | PlatformFailure;
  reviewWiki(
    actor: Principal,
    input: { pageId: string; revision: number; decision: "approve" | "reject" },
  ): { ok: true; page: WikiPageView } | PlatformFailure;
  getPublishedWiki(actor: Principal, pageId: string): { ok: true; page: WikiPageView } | PlatformFailure;
  setLearningEnabled(actor: Principal, enabled: boolean): { ok: true; enabled: boolean } | PlatformFailure;
  learningEnabled(actor: Principal): { ok: true; enabled: boolean } | PlatformFailure;
  submitLearningCandidate(
    actor: Principal,
    input: { kind: "experience" | "memory" | "skill"; title: string; body: string; sourceTaskId?: string },
  ): { ok: true; candidate: LearningCandidateView } | PlatformFailure;
  reviewLearningCandidate(
    actor: Principal,
    input: { candidateId: string; decision: "approve" | "reject" },
  ): { ok: true; candidate: LearningCandidateView; resourceId?: string } | PlatformFailure;
  reviseLearningCandidate(
    actor: Principal,
    input: { candidateId: string; title: string; body: string },
  ): { ok: true; candidate: LearningCandidateView } | PlatformFailure;
  listOrgResources(actor: Principal): { ok: true; resources: OrgResourceView[] } | PlatformFailure;
  recordFeedback(
    actor: Principal,
    input: { resourceId: string; helpful: boolean; note?: string },
  ): { ok: true } | PlatformFailure;
  retireOrgResource(actor: Principal, resourceId: string): { ok: true } | PlatformFailure;
};

export function createEnterpriseApi(db: DatabaseSync, config: PlatformConfig, audit: AuditFn): EnterpriseApi {
  const market = createMarket(db, config.now);
  const stagingRoot = join(config.dataDir, "staging");
  mkdirSync(stagingRoot, { recursive: true });

  function uploadView(row: Record<string, unknown>): UploadView | undefined {
    const uploadId = textOf(row, "upload_id");
    const purpose = textOf(row, "purpose");
    const status = textOf(row, "status");
    const contentSha256 = textOf(row, "content_sha256");
    const byteSize = numberOf(row, "byte_size");
    if (
      uploadId === undefined ||
      purpose === undefined ||
      !purposeOk(purpose) ||
      status === undefined ||
      contentSha256 === undefined ||
      byteSize === undefined
    ) {
      return undefined;
    }
    const view: UploadView = { uploadId, purpose, status: status as UploadStatus, contentSha256, byteSize };
    const fileId = textOf(row, "file_id");
    const resourceId = textOf(row, "resource_id");
    if (fileId !== undefined) {
      view.fileId = fileId;
    }
    if (resourceId !== undefined) {
      view.resourceId = resourceId;
    }
    return view;
  }

  function canReadKnowledge(actor: Principal, aclGroup: string): boolean {
    const row = rowOf(
      db
        .prepare("SELECT employee_id FROM knowledge_acl WHERE org_id = ? AND acl_group = ? AND employee_id = ?")
        .get(actor.orgId, aclGroup, actor.employeeId),
    );
    return row !== undefined;
  }

  function latestWiki(pageId: string): Record<string, unknown> | undefined {
    return rowOf(
      db.prepare("SELECT * FROM wiki_pages WHERE page_id = ? ORDER BY revision DESC LIMIT 1").get(pageId),
    );
  }

  function wikiView(row: Record<string, unknown>): WikiPageView | undefined {
    const pageId = textOf(row, "page_id");
    const revision = numberOf(row, "revision");
    const title = textOf(row, "title");
    const body = textOf(row, "body");
    const status = textOf(row, "status");
    const sourceRaw = textOf(row, "source_doc_ids");
    if (
      pageId === undefined ||
      revision === undefined ||
      title === undefined ||
      body === undefined ||
      status === undefined ||
      sourceRaw === undefined
    ) {
      return undefined;
    }
    let sourceDocIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(sourceRaw);
      if (Array.isArray(parsed)) {
        sourceDocIds = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      sourceDocIds = [];
    }
    return {
      pageId,
      revision,
      title,
      body,
      status: status as WikiPageView["status"],
      sourceDocIds,
    };
  }

  function sourcesAlive(orgId: string, sourceDocIds: string[]): boolean {
    for (const docId of sourceDocIds) {
      const row = rowOf(
        db.prepare("SELECT status FROM knowledge_docs WHERE doc_id = ? AND org_id = ?").get(docId, orgId),
      );
      if (row === undefined || textOf(row, "status") !== "active") {
        return false;
      }
    }
    return true;
  }

  const api: EnterpriseApi = {
    createUpload(actor, input) {
      if (!purposeOk(input.purpose) || !idOk(input.idempotencyKey) || !/^[a-f0-9]{64}$/.test(input.contentSha256)) {
        return failure("CONFIG_INVALID", "上传参数不符合限制");
      }
      if (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_UPLOAD_BYTES) {
        return failure("CONFIG_INVALID", `上传大小必须在 1 到 ${MAX_UPLOAD_BYTES} 字节`);
      }
      const existing = rowOf(
        db
          .prepare("SELECT * FROM upload_sessions WHERE employee_id = ? AND idempotency_key = ?")
          .get(actor.employeeId, input.idempotencyKey),
      );
      if (existing !== undefined) {
        const view = uploadView(existing);
        if (view === undefined) {
          return failure("CONFIG_INVALID", "上传记录无法读取");
        }
        if (
          textOf(existing, "content_sha256") !== input.contentSha256 ||
          numberOf(existing, "byte_size") !== input.byteSize ||
          textOf(existing, "purpose") !== input.purpose
        ) {
          return failure("CONFLICT", "幂等键已绑定不同内容");
        }
        return { ok: true, upload: view };
      }
      const uploadId = `upl-${randomUUID().replaceAll("-", "")}`;
      const stagingPath = join(stagingRoot, `${uploadId}.bin`);
      withTx(db, () => {
        db.prepare(
          `INSERT INTO upload_sessions (
            upload_id, org_id, employee_id, purpose, content_sha256, byte_size, idempotency_key,
            status, staging_path, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`,
        ).run(
          uploadId,
          actor.orgId,
          actor.employeeId,
          input.purpose,
          input.contentSha256,
          input.byteSize,
          input.idempotencyKey,
          stagingPath,
          config.now(),
        );
        audit(actor.orgId, actor.employeeId, "upload_create", uploadId);
      });
      platformLog(config.dataDir, "info", "upload_created", "已创建上传事务", {
        uploadId,
        purpose: input.purpose,
        byteSize: input.byteSize,
      });
      return {
        ok: true,
        upload: {
          uploadId,
          purpose: input.purpose,
          status: "preparing",
          contentSha256: input.contentSha256,
          byteSize: input.byteSize,
        },
      };
    },

    putUploadContent(actor, uploadId, content) {
      const row = rowOf(db.prepare("SELECT * FROM upload_sessions WHERE upload_id = ?").get(uploadId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "没有这个上传事务");
      }
      const status = textOf(row, "status");
      if (status === "available") {
        const view = uploadView(row);
        return view === undefined ? failure("CONFIG_INVALID", "上传记录无法读取") : { ok: true, upload: view };
      }
      if (status === "cancelled" || status === "cancelling") {
        return failure("CONFLICT", "上传已取消");
      }
      const expectedSha = textOf(row, "content_sha256");
      const expectedSize = numberOf(row, "byte_size");
      const stagingPath = textOf(row, "staging_path");
      if (expectedSha === undefined || expectedSize === undefined || stagingPath === undefined) {
        return failure("CONFIG_INVALID", "上传记录无法读取");
      }
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes !== expectedSize || sha256(content) !== expectedSha) {
        return failure("CONFLICT", "内容与创建时快照不一致");
      }
      writeFileSync(stagingPath, content, "utf8");
      db.prepare("UPDATE upload_sessions SET status = 'checking' WHERE upload_id = ?").run(uploadId);
      const next = rowOf(db.prepare("SELECT * FROM upload_sessions WHERE upload_id = ?").get(uploadId));
      const view = next === undefined ? undefined : uploadView(next);
      return view === undefined ? failure("CONFIG_INVALID", "上传记录无法读取") : { ok: true, upload: view };
    },

    completeUpload(actor, uploadId) {
      return withTx(db, () => {
        const row = rowOf(db.prepare("SELECT * FROM upload_sessions WHERE upload_id = ?").get(uploadId));
        if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
          return failure("NOT_FOUND", "没有这个上传事务");
        }
        const status = textOf(row, "status");
        if (status === "available") {
          const view = uploadView(row);
          return view === undefined ? failure("CONFIG_INVALID", "上传记录无法读取") : { ok: true, upload: view };
        }
        if (status === "cancelled" || status === "cancelling") {
          return failure("CONFLICT", "上传已取消，完成被拒绝");
        }
        if (status !== "checking" && status !== "uploading") {
          return failure("CONFLICT", "上传尚未写入内容");
        }
        const stagingPath = textOf(row, "staging_path");
        const expectedSha = textOf(row, "content_sha256");
        const expectedSize = numberOf(row, "byte_size");
        const purpose = textOf(row, "purpose");
        if (
          stagingPath === undefined ||
          expectedSha === undefined ||
          expectedSize === undefined ||
          purpose === undefined ||
          !existsSync(stagingPath)
        ) {
          return failure("CONFLICT", "暂存内容缺失");
        }
        const body = readFileSync(stagingPath, "utf8");
        if (Buffer.byteLength(body, "utf8") !== expectedSize || sha256(body) !== expectedSha) {
          return failure("CONFLICT", "完成校验失败");
        }
        const fileId = `file-${randomUUID().replaceAll("-", "")}`;
        db.prepare(
          `INSERT INTO private_files (file_id, org_id, employee_id, content_sha256, byte_size, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(fileId, actor.orgId, actor.employeeId, expectedSha, expectedSize, body, config.now());
        db.prepare(
          "UPDATE upload_sessions SET status = 'available', file_id = ?, resource_id = ? WHERE upload_id = ?",
        ).run(fileId, purpose === "artifact" ? fileId : fileId, uploadId);
        try {
          rmSync(stagingPath);
        } catch {
          // 暂存清理失败不影响正式资源；下次 cleanupStaging 再收。
        }
        audit(actor.orgId, actor.employeeId, "upload_complete", uploadId);
        const next = rowOf(db.prepare("SELECT * FROM upload_sessions WHERE upload_id = ?").get(uploadId));
        const view = next === undefined ? undefined : uploadView(next);
        return view === undefined ? failure("CONFIG_INVALID", "上传记录无法读取") : { ok: true, upload: view };
      });
    },

    cancelUpload(actor, uploadId) {
      return withTx(db, () => {
        const row = rowOf(db.prepare("SELECT * FROM upload_sessions WHERE upload_id = ?").get(uploadId));
        if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
          return failure("NOT_FOUND", "没有这个上传事务");
        }
        const status = textOf(row, "status");
        if (status === "available") {
          const view = uploadView(row);
          return view === undefined
            ? failure("CONFIG_INVALID", "上传记录无法读取")
            : failure("CONFLICT", "已完成的资源需另走删除，不能取消成未创建");
        }
        if (status === "cancelled") {
          const view = uploadView(row);
          return view === undefined ? failure("CONFIG_INVALID", "上传记录无法读取") : { ok: true, upload: view };
        }
        db.prepare("UPDATE upload_sessions SET status = 'cancelled' WHERE upload_id = ?").run(uploadId);
        const stagingPath = textOf(row, "staging_path");
        if (stagingPath !== undefined && existsSync(stagingPath)) {
          try {
            rmSync(stagingPath);
          } catch {
            // 忽略暂存删除失败。
          }
        }
        audit(actor.orgId, actor.employeeId, "upload_cancel", uploadId);
        const next = rowOf(db.prepare("SELECT * FROM upload_sessions WHERE upload_id = ?").get(uploadId));
        const view = next === undefined ? undefined : uploadView(next);
        return view === undefined ? failure("CONFIG_INVALID", "上传记录无法读取") : { ok: true, upload: view };
      });
    },

    getUpload(actor, uploadId) {
      const row = rowOf(db.prepare("SELECT * FROM upload_sessions WHERE upload_id = ?").get(uploadId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "没有这个上传事务");
      }
      const view = uploadView(row);
      return view === undefined ? failure("CONFIG_INVALID", "上传记录无法读取") : { ok: true, upload: view };
    },

    readPrivateFile(actor, fileId) {
      const row = rowOf(db.prepare("SELECT * FROM private_files WHERE file_id = ?").get(fileId));
      if (row === undefined) {
        return failure("NOT_FOUND", "没有这个私有文件");
      }
      if (textOf(row, "employee_id") !== actor.employeeId || textOf(row, "org_id") !== actor.orgId) {
        return failure("FORBIDDEN", "无权读取他人私有文件");
      }
      const body = textOf(row, "body");
      if (body === undefined) {
        return failure("CONFIG_INVALID", "文件正文无法读取");
      }
      return { ok: true, fileId, body };
    },

    cleanupStaging(actor) {
      if (actor.role !== "admin") {
        return failure("FORBIDDEN", "员工不能调用管理接口");
      }
      const rows = db.prepare("SELECT upload_id, staging_path, status FROM upload_sessions").all();
      let removed = 0;
      for (const item of rows) {
        const row = rowOf(item);
        if (row === undefined) {
          continue;
        }
        const status = textOf(row, "status");
        const stagingPath = textOf(row, "staging_path");
        if (
          stagingPath !== undefined &&
          existsSync(stagingPath) &&
          (status === "cancelled" || status === "available" || status === "failed")
        ) {
          try {
            rmSync(stagingPath);
            removed += 1;
          } catch {
            // 继续清理其余暂存。
          }
        }
      }
      audit(actor.orgId, actor.employeeId, "staging_cleanup", String(removed));
      return { ok: true, removed };
    },

    receiveLogBatch(actor, input) {
      if (!idOk(input.batchId) || !idOk(input.deviceEpoch)) {
        return failure("CONFIG_INVALID", "日志批次标识不符合限制");
      }
      if (!Number.isInteger(input.cursorFrom) || input.cursorFrom < 0) {
        return failure("CONFIG_INVALID", "日志游标无效");
      }
      if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > LOG_BATCH_MAX_EVENTS) {
        return failure("CONFIG_INVALID", `日志批次条数必须在 1 到 ${LOG_BATCH_MAX_EVENTS}`);
      }
      for (const event of input.events) {
        if (!idOk(event.event) || event.message.length === 0 || event.message.length > 200) {
          return failure("CONFIG_INVALID", "日志事件字段不符合白名单");
        }
        if (event.message.includes("token") || event.message.includes("password") || event.message.includes("/Users/")) {
          return failure("CONFIG_INVALID", "日志疑似含敏感内容，已拒绝");
        }
      }
      const existing = rowOf(db.prepare("SELECT * FROM log_batches WHERE batch_id = ?").get(input.batchId));
      if (existing !== undefined) {
        if (textOf(existing, "employee_id") !== actor.employeeId) {
          return failure("FORBIDDEN", "不能用当前账号确认他人日志批次");
        }
        const cursorTo = numberOf(existing, "cursor_to");
        if (cursorTo === undefined) {
          return failure("CONFIG_INVALID", "日志回执无法读取");
        }
        return {
          ok: true,
          receipt: { batchId: input.batchId, acceptedThrough: cursorTo, duplicate: true },
        };
      }
      const cursorTo = input.cursorFrom + input.events.length - 1;
      const contentSha256 = sha256(JSON.stringify(input.events));
      withTx(db, () => {
        db.prepare(
          `INSERT INTO log_batches (
            batch_id, org_id, employee_id, device_epoch, cursor_from, cursor_to, event_count, content_sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.batchId,
          actor.orgId,
          actor.employeeId,
          input.deviceEpoch,
          input.cursorFrom,
          cursorTo,
          input.events.length,
          contentSha256,
          config.now(),
        );
        audit(actor.orgId, actor.employeeId, "log_batch", input.batchId);
      });
      return {
        ok: true,
        receipt: { batchId: input.batchId, acceptedThrough: cursorTo, duplicate: false },
      };
    },

    getLogBatchReceipt(actor, batchId) {
      const row = rowOf(db.prepare("SELECT * FROM log_batches WHERE batch_id = ?").get(batchId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "没有这个日志批次");
      }
      const cursorTo = numberOf(row, "cursor_to");
      if (cursorTo === undefined) {
        return failure("CONFIG_INVALID", "日志回执无法读取");
      }
      return { ok: true, receipt: { batchId, acceptedThrough: cursorTo, duplicate: false } };
    },

    publishSkillRelease(actor, input) {
      audit(actor.orgId,actor.employeeId,'skill_publish',input.skillId);
      return market(actor,'legacy-publish',input) as ReturnType<EnterpriseApi['publishSkillRelease']>;
    },
    submitSkill(actor, input) {
      const result=market(actor,'legacy-submit',input);if(result.ok)audit(actor.orgId,actor.employeeId,'skill_submit',String(result.submissionId??input.skillId));
      return result as ReturnType<EnterpriseApi['submitSkill']>;
    },
    reviseSkillSubmission(actor, input) {
      const result=market(actor,'legacy-revise',input);if(result.ok)audit(actor.orgId,actor.employeeId,'skill_revise',input.submissionId);
      return result as ReturnType<EnterpriseApi['reviseSkillSubmission']>;
    },
    reviewSkillSubmission(actor, input) {
      const result=market(actor,'legacy-review',input);if(result.ok)audit(actor.orgId,actor.employeeId,'skill_review',input.submissionId);
      return result as ReturnType<EnterpriseApi['reviewSkillSubmission']>;
    },
    listAvailableSkills(actor) {
      return market(actor,'legacy-list',{}) as ReturnType<EnterpriseApi['listAvailableSkills']>;
    },
    downloadSkillRelease(actor, skillId, version) {
      return market(actor,'legacy-download',{skillId,version}) as ReturnType<EnterpriseApi['downloadSkillRelease']>;
    },

    ingestKnowledge(actor, input) {
      if (actor.role !== "admin") {
        return failure("FORBIDDEN", "员工不能调用管理接口");
      }
      if (!idOk(input.docId) || input.format !== "markdown") {
        return failure("CONFIG_INVALID", "当前 Mock 仅接受 markdown 原文");
      }
      const existing = rowOf(db.prepare("SELECT version FROM knowledge_docs WHERE doc_id = ?").get(input.docId));
      const version = existing === undefined ? 1 : (numberOf(existing, "version") ?? 0) + 1;
      withTx(db, () => {
        db.prepare("DELETE FROM knowledge_docs WHERE doc_id = ?").run(input.docId);
        db.prepare(
          `INSERT INTO knowledge_docs (
            doc_id, org_id, title, format, version, body, acl_group, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        ).run(
          input.docId,
          actor.orgId,
          input.title,
          input.format,
          version,
          input.body,
          input.aclGroup,
          config.now(),
        );
        audit(actor.orgId, actor.employeeId, "knowledge_ingest", input.docId);
      });
      return { ok: true, docId: input.docId, version };
    },

    searchKnowledge(actor, query) {
      const rows = db
        .prepare("SELECT * FROM knowledge_docs WHERE org_id = ? AND status = 'active'")
        .all(actor.orgId);
      const hits: KnowledgeHit[] = [];
      for (const item of rows) {
        const row = rowOf(item);
        if (row === undefined) {
          continue;
        }
        const aclGroup = textOf(row, "acl_group");
        if (aclGroup === undefined || !canReadKnowledge(actor, aclGroup)) {
          continue;
        }
        const body = textOf(row, "body") ?? "";
        const title = textOf(row, "title") ?? "";
        if (!body.includes(query) && !title.includes(query)) {
          continue;
        }
        const docId = textOf(row, "doc_id");
        const version = numberOf(row, "version");
        if (docId === undefined || version === undefined) {
          continue;
        }
        const idx = body.indexOf(query);
        const locator = idx >= 0 ? `offset:${idx}` : "title";
        const excerpt = idx >= 0 ? body.slice(idx, idx + Math.min(80, query.length + 40)) : title;
        hits.push({ docId, version, title, locator, excerpt });
      }
      return { ok: true, hits };
    },

    citeKnowledge(actor, docId, locator) {
      const row = rowOf(db.prepare("SELECT * FROM knowledge_docs WHERE doc_id = ?").get(docId));
      if (row === undefined || textOf(row, "status") !== "active") {
        return failure("NOT_FOUND", "原文不可用或已撤权");
      }
      if (textOf(row, "org_id") !== actor.orgId) {
        return failure("FORBIDDEN", "跨组织拒绝");
      }
      const aclGroup = textOf(row, "acl_group");
      if (aclGroup === undefined || !canReadKnowledge(actor, aclGroup)) {
        return failure("FORBIDDEN", "无权引用该原文");
      }
      const body = textOf(row, "body") ?? "";
      const version = numberOf(row, "version");
      if (version === undefined) {
        return failure("CONFIG_INVALID", "原文版本无法读取");
      }
      let excerpt = body.slice(0, 80);
      const match = /^offset:(\d+)$/.exec(locator);
      if (match !== null) {
        const start = Number(match[1]);
        excerpt = body.slice(start, start + 80);
      }
      return { ok: true, docId, version, excerpt };
    },

    revokeKnowledge(actor, docId) {
      if (actor.role !== "admin") {
        return failure("FORBIDDEN", "员工不能调用管理接口");
      }
      const row = rowOf(db.prepare("SELECT org_id FROM knowledge_docs WHERE doc_id = ?").get(docId));
      if (row === undefined || textOf(row, "org_id") !== actor.orgId) {
        return failure("NOT_FOUND", "没有这份原文");
      }
      db.prepare("UPDATE knowledge_docs SET status = 'revoked' WHERE doc_id = ?").run(docId);
      audit(actor.orgId, actor.employeeId, "knowledge_revoke", docId);
      return { ok: true };
    },

    draftWiki(actor, input) {
      if (!idOk(input.pageId) || input.sourceDocIds.length < 1) {
        return failure("CONFIG_INVALID", "Wiki 页需要至少一个来源原文");
      }
      if (!sourcesAlive(actor.orgId, input.sourceDocIds)) {
        return failure("CONFLICT", "来源原文不可用，阻断派生页");
      }
      for (const docId of input.sourceDocIds) {
        const cited = api.citeKnowledge(actor, docId, "title");
        if (!cited.ok) {
          return cited;
        }
      }
      const existing = latestWiki(input.pageId);
      if (existing !== undefined) {
        return failure("CONFLICT", "页面已存在，请走修订");
      }
      withTx(db, () => {
        db.prepare(
          `INSERT INTO wiki_pages (
            page_id, revision, org_id, title, body, source_doc_ids, status, author_id, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, 'draft', ?, ?)`,
        ).run(
          input.pageId,
          actor.orgId,
          input.title,
          input.body,
          JSON.stringify(input.sourceDocIds),
          actor.employeeId,
          config.now(),
        );
        audit(actor.orgId, actor.employeeId, "wiki_draft", input.pageId);
      });
      const row = latestWiki(input.pageId);
      const page = row === undefined ? undefined : wikiView(row);
      return page === undefined ? failure("CONFIG_INVALID", "Wiki 无法读取") : { ok: true, page };
    },

    reviseWiki(actor, input) {
      const latest = latestWiki(input.pageId);
      if (latest === undefined || textOf(latest, "org_id") !== actor.orgId) {
        return failure("NOT_FOUND", "没有这个 Wiki 页");
      }
      const currentRevision = numberOf(latest, "revision");
      if (currentRevision === undefined || currentRevision !== input.baseRevision) {
        return failure("CONFLICT", "改稿基线不匹配，需重审");
      }
      if (!sourcesAlive(actor.orgId, input.sourceDocIds)) {
        return failure("CONFLICT", "来源原文不可用，阻断派生页");
      }
      const revision = currentRevision + 1;
      withTx(db, () => {
        db.prepare(
          `INSERT INTO wiki_pages (
            page_id, revision, org_id, title, body, source_doc_ids, status, author_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        ).run(
          input.pageId,
          revision,
          actor.orgId,
          input.title,
          input.body,
          JSON.stringify(input.sourceDocIds),
          actor.employeeId,
          config.now(),
        );
        db.prepare("DELETE FROM wiki_published WHERE page_id = ?").run(input.pageId);
        audit(actor.orgId, actor.employeeId, "wiki_revise", `${input.pageId}@${revision}`);
      });
      const row = latestWiki(input.pageId);
      const page = row === undefined ? undefined : wikiView(row);
      return page === undefined ? failure("CONFIG_INVALID", "Wiki 无法读取") : { ok: true, page };
    },

    submitWikiReview(actor, pageId) {
      const latest = latestWiki(pageId);
      if (latest === undefined || textOf(latest, "org_id") !== actor.orgId) {
        return failure("NOT_FOUND", "没有这个 Wiki 页");
      }
      if (textOf(latest, "status") !== "draft" && textOf(latest, "status") !== "rejected") {
        return failure("CONFLICT", "当前修订不可提交审核");
      }
      const revision = numberOf(latest, "revision");
      if (revision === undefined) {
        return failure("CONFIG_INVALID", "Wiki 修订无法读取");
      }
      db.prepare("UPDATE wiki_pages SET status = 'pending' WHERE page_id = ? AND revision = ?").run(pageId, revision);
      const row = latestWiki(pageId);
      const page = row === undefined ? undefined : wikiView(row);
      return page === undefined ? failure("CONFIG_INVALID", "Wiki 无法读取") : { ok: true, page };
    },

    reviewWiki(actor, input) {
      if (actor.role !== "admin") {
        return failure("FORBIDDEN", "员工不能调用管理接口");
      }
      const row = rowOf(
        db
          .prepare("SELECT * FROM wiki_pages WHERE page_id = ? AND revision = ? AND org_id = ?")
          .get(input.pageId, input.revision, actor.orgId),
      );
      if (row === undefined) {
        return failure("NOT_FOUND", "没有这个 Wiki 修订");
      }
      if (textOf(row, "status") !== "pending") {
        return failure("CONFLICT", "修订不在待审状态");
      }
      const sourceRaw = textOf(row, "source_doc_ids") ?? "[]";
      let sourceDocIds: string[] = [];
      try {
        const parsed: unknown = JSON.parse(sourceRaw);
        if (Array.isArray(parsed)) {
          sourceDocIds = parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        sourceDocIds = [];
      }
      if (input.decision === "approve" && !sourcesAlive(actor.orgId, sourceDocIds)) {
        return failure("CONFLICT", "来源原文不可用，阻断发布");
      }
      withTx(db, () => {
        if (input.decision === "approve") {
          db.prepare("UPDATE wiki_pages SET status = 'published' WHERE page_id = ? AND revision = ?").run(
            input.pageId,
            input.revision,
          );
          db.prepare(
            "INSERT INTO wiki_published (page_id, org_id, revision) VALUES (?, ?, ?) ON CONFLICT(page_id) DO UPDATE SET revision = excluded.revision",
          ).run(input.pageId, actor.orgId, input.revision);
          audit(actor.orgId, actor.employeeId, "wiki_approve", `${input.pageId}@${input.revision}`);
        } else {
          db.prepare("UPDATE wiki_pages SET status = 'rejected' WHERE page_id = ? AND revision = ?").run(
            input.pageId,
            input.revision,
          );
          audit(actor.orgId, actor.employeeId, "wiki_reject", `${input.pageId}@${input.revision}`);
        }
      });
      const next = rowOf(
        db.prepare("SELECT * FROM wiki_pages WHERE page_id = ? AND revision = ?").get(input.pageId, input.revision),
      );
      const page = next === undefined ? undefined : wikiView(next);
      return page === undefined ? failure("CONFIG_INVALID", "Wiki 无法读取") : { ok: true, page };
    },

    getPublishedWiki(actor, pageId) {
      const pointer = rowOf(
        db.prepare("SELECT revision FROM wiki_published WHERE page_id = ? AND org_id = ?").get(pageId, actor.orgId),
      );
      if (pointer === undefined) {
        return failure("NOT_FOUND", "未审或未发布的 Wiki 不可见");
      }
      const revision = numberOf(pointer, "revision");
      if (revision === undefined) {
        return failure("CONFIG_INVALID", "发布指针无法读取");
      }
      const row = rowOf(
        db.prepare("SELECT * FROM wiki_pages WHERE page_id = ? AND revision = ?").get(pageId, revision),
      );
      const page = row === undefined ? undefined : wikiView(row);
      if (page === undefined) {
        return failure("NOT_FOUND", "未审或未发布的 Wiki 不可见");
      }
      if (!sourcesAlive(actor.orgId, page.sourceDocIds)) {
        return failure("CONFLICT", "来源原文失效，阻断派生页");
      }
      return { ok: true, page };
    },

    setLearningEnabled(actor, enabled) {
      if (actor.role !== "admin") {
        return failure("FORBIDDEN", "员工不能调用管理接口");
      }
      db.prepare(
        "INSERT INTO learning_policy (org_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
      ).run(actor.orgId, enabled ? 1 : 0, config.now());
      audit(actor.orgId, actor.employeeId, "learning_policy", enabled ? "on" : "off");
      return { ok: true, enabled };
    },

    learningEnabled(actor) {
      const row = rowOf(db.prepare("SELECT enabled FROM learning_policy WHERE org_id = ?").get(actor.orgId));
      const enabled = row === undefined ? 0 : numberOf(row, "enabled");
      return { ok: true, enabled: enabled === 1 };
    },

    submitLearningCandidate(actor, input) {
      const policy = api.learningEnabled(actor);
      if (!policy.ok) {
        return policy;
      }
      if (!policy.enabled) {
        return failure("FORBIDDEN", "学习授权默认关闭，拒绝上行");
      }
      if (input.kind !== "experience" && input.kind !== "memory" && input.kind !== "skill") {
        return failure("CONFIG_INVALID", "候选类型不支持");
      }
      const candidateId = `lc-${randomUUID().replaceAll("-", "")}`;
      withTx(db, () => {
        db.prepare(
          `INSERT INTO learning_candidates (
            candidate_id, org_id, author_id, kind, title, body, version, status, source_task_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
        ).run(
          candidateId,
          actor.orgId,
          actor.employeeId,
          input.kind,
          input.title,
          input.body,
          input.sourceTaskId ?? null,
          config.now(),
        );
        audit(actor.orgId, actor.employeeId, "learning_submit", candidateId);
      });
      return {
        ok: true,
        candidate: {
          candidateId,
          kind: input.kind,
          status: "pending",
          version: 1,
          authorId: actor.employeeId,
        },
      };
    },

    reviseLearningCandidate(actor, input) {
      const row = rowOf(db.prepare("SELECT * FROM learning_candidates WHERE candidate_id = ?").get(input.candidateId));
      if (row === undefined || textOf(row, "author_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "没有这个学习候选");
      }
      const version = (numberOf(row, "version") ?? 0) + 1;
      const kind = textOf(row, "kind");
      if (kind !== "experience" && kind !== "memory" && kind !== "skill") {
        return failure("CONFIG_INVALID", "候选类型无法读取");
      }
      withTx(db, () => {
        if (textOf(row, "status") === "published") {
          db.prepare("UPDATE learning_candidates SET status = 'superseded' WHERE candidate_id = ?").run(
            input.candidateId,
          );
          db.prepare(
            "UPDATE org_resources SET status = 'retired' WHERE candidate_id = ?",
          ).run(input.candidateId);
        }
        db.prepare(
          `UPDATE learning_candidates
           SET title = ?, body = ?, version = ?, status = 'pending'
           WHERE candidate_id = ?`,
        ).run(input.title, input.body, version, input.candidateId);
        audit(actor.orgId, actor.employeeId, "learning_revise", input.candidateId);
      });
      return {
        ok: true,
        candidate: {
          candidateId: input.candidateId,
          kind,
          status: "pending",
          version,
          authorId: actor.employeeId,
        },
      };
    },

    reviewLearningCandidate(actor, input) {
      if (actor.role !== "admin") {
        return failure("FORBIDDEN", "员工不能调用管理接口");
      }
      const row = rowOf(db.prepare("SELECT * FROM learning_candidates WHERE candidate_id = ?").get(input.candidateId));
      if (row === undefined || textOf(row, "org_id") !== actor.orgId) {
        return failure("NOT_FOUND", "没有这个学习候选");
      }
      if (textOf(row, "status") !== "pending") {
        return failure("CONFLICT", "候选不在待审状态");
      }
      const kind = textOf(row, "kind");
      const title = textOf(row, "title");
      const body = textOf(row, "body");
      const version = numberOf(row, "version");
      const authorId = textOf(row, "author_id");
      if (
        (kind !== "experience" && kind !== "memory" && kind !== "skill") ||
        title === undefined ||
        body === undefined ||
        version === undefined ||
        authorId === undefined
      ) {
        return failure("CONFIG_INVALID", "候选无法读取");
      }
      if (input.decision === "reject") {
        db.prepare("UPDATE learning_candidates SET status = 'rejected' WHERE candidate_id = ?").run(input.candidateId);
        return {
          ok: true,
          candidate: { candidateId: input.candidateId, kind, status: "rejected", version, authorId },
        };
      }
      const resourceId = `res-${randomUUID().replaceAll("-", "")}`;
      withTx(db, () => {
        db.prepare("UPDATE learning_candidates SET status = 'published' WHERE candidate_id = ?").run(input.candidateId);
        db.prepare(
          `INSERT INTO org_resources (
            resource_id, org_id, kind, title, body, version, status, candidate_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(resourceId, actor.orgId, kind, title, body, version, input.candidateId, config.now());
        audit(actor.orgId, actor.employeeId, "learning_approve", input.candidateId);
      });
      return {
        ok: true,
        candidate: { candidateId: input.candidateId, kind, status: "published", version, authorId },
        resourceId,
      };
    },

    listOrgResources(actor) {
      const rows = db
        .prepare(
          "SELECT resource_id, kind, title, version, status FROM org_resources WHERE org_id = ? AND status = 'active'",
        )
        .all(actor.orgId);
      const resources: OrgResourceView[] = [];
      for (const item of rows) {
        const row = rowOf(item);
        if (row === undefined) {
          continue;
        }
        const resourceId = textOf(row, "resource_id");
        const kind = textOf(row, "kind");
        const title = textOf(row, "title");
        const version = numberOf(row, "version");
        if (
          resourceId === undefined ||
          (kind !== "experience" && kind !== "memory" && kind !== "skill") ||
          title === undefined ||
          version === undefined
        ) {
          continue;
        }
        resources.push({ resourceId, kind, title, version, status: "active" });
      }
      return { ok: true, resources };
    },

    recordFeedback(actor, input) {
      const row = rowOf(
        db
          .prepare("SELECT resource_id FROM org_resources WHERE resource_id = ? AND org_id = ? AND status = 'active'")
          .get(input.resourceId, actor.orgId),
      );
      if (row === undefined) {
        return failure("NOT_FOUND", "没有这个组织资源");
      }
      db.prepare(
        "INSERT INTO resource_feedback (resource_id, employee_id, helpful, note, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(input.resourceId, actor.employeeId, input.helpful ? 1 : 0, input.note ?? null, config.now());
      return { ok: true };
    },

    retireOrgResource(actor, resourceId) {
      if (actor.role !== "admin") {
        return failure("FORBIDDEN", "员工不能调用管理接口");
      }
      const row = rowOf(
        db.prepare("SELECT resource_id FROM org_resources WHERE resource_id = ? AND org_id = ?").get(resourceId, actor.orgId),
      );
      if (row === undefined) {
        return failure("NOT_FOUND", "没有这个组织资源");
      }
      db.prepare("UPDATE org_resources SET status = 'retired' WHERE resource_id = ?").run(resourceId);
      audit(actor.orgId, actor.employeeId, "resource_retire", resourceId);
      return { ok: true };
    },
  };

  return api;
}

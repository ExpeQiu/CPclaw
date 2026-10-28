import { createKnowledge, type KnowledgeResult } from './knowledge.js';
import { createMarket, type MarketResult } from './market.js';
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendAuthorityRevocation, applyAuthorityLedger } from "./authority-ledger.js";
import type { PlatformConfig } from "./config.js";
import {
  createChannelApi,
  ensureChannelSchema,
  type BindingView,
  type ChannelAck,
  type ChannelApi,
  type CommandReceiptView,
  type ConversationBindingView,
  type DeviceEndpointView,
  type OutboundDeliveryView,
} from "./channel.js";
import {
  createEnterpriseApi,
  ensureEnterpriseSchema,
  seedKnowledgeAcl,
  type EnterpriseApi,
  type KnowledgeHit,
  type LearningCandidateView,
  type LogBatchReceipt,
  type OrgResourceView,
  type SkillReleaseView,
  type UploadView,
  type WikiPageView,
} from "./enterprise.js";
import { MODEL_ID, parseBootstrap, type EmployeeRole, type SeedEmployee } from "./fixture.js";
import { platformLog } from "./log.js";
import { hashPassword, hashRefresh, newRefreshToken, readAccess, signAccess, verifyPassword } from "./token.js";
import type { RelayEnvelope } from "@cpclaw/contracts";

export type PlatformCode =
  | "AUTH_REQUIRED"
  | "SESSION_REVOKED"
  | "FORBIDDEN"
  | "QUOTA_EXCEEDED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONFIG_INVALID";

export type PlatformFailure = { ok: false; code: PlatformCode; message: string };

export type UsageView =
  | { state: "known"; inputTokens: number; outputTokens: number }
  | { state: "unknown" };

export type LoginSuccess = {
  ok: true;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  sessionId: string;
  employeeId: string;
  orgId: string;
  role: EmployeeRole;
};

export type InvokeKind = "text" | "stream" | "tool" | "cancel" | "timeout";

type Principal = {
  ok: true;
  sessionId: string;
  employeeId: string;
  orgId: string;
  role: EmployeeRole;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orgs (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quota (
  employee_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  limit_tokens INTEGER NOT NULL,
  concurrent_limit INTEGER NOT NULL,
  reserve_tokens INTEGER NOT NULL,
  settled_known INTEGER NOT NULL,
  unsettled_unknown INTEGER NOT NULL,
  open_reserved INTEGER NOT NULL,
  concurrent_in_use INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  request_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_requests (
  employee_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  additional_tokens INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(employee_id,request_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL
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

function isRole(value: string | undefined): value is EmployeeRole {
  return value === "admin" || value === "employee";
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

function deviceLabelOk(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,40}$/.test(value);
}

function requestIdOk(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

export type PlatformApp = {
  knowledge(accessToken: string, action: string, input: Record<string, unknown>): KnowledgeResult;
  market(accessToken: string, action: string, input: Record<string, unknown>): MarketResult;
  login(input: { employeeId: string; password: string; deviceLabel: string }): LoginSuccess | PlatformFailure;
  refresh(refreshToken: string): Promise<LoginSuccess | PlatformFailure>;
  logout(accessToken: string): { ok: true } | PlatformFailure;
  listOwnSessions(accessToken: string): { ok: true; sessions: SessionView[] } | PlatformFailure;
  readOwnQuota(accessToken: string): { ok: true; quota: QuotaView } | PlatformFailure;
  requestOwnQuota(accessToken: string, input: {requestId: string; additionalTokens: number}): {ok:true;requestId:string;additionalTokens:number;status:'approved';approvalMode:'auto';replayed:boolean;quota:QuotaView} | PlatformFailure;
  beginReport(accessToken: string, requestId: string): (ReserveSuccess & { finish: (usage: UsageView) => SettleSuccess | PlatformFailure }) | PlatformFailure;
  reserve(accessToken: string, input: { requestId: string; model?: string }): ReserveSuccess | PlatformFailure;
  settle(accessToken: string, input: { requestId: string; usage: UsageView }): SettleSuccess | PlatformFailure;
  invoke(accessToken: string, input: { requestId: string; kind: string; model?: string }): InvokeSuccess | PlatformFailure;
  listEmployees(accessToken: string): { ok: true; employees: EmployeeView[] } | PlatformFailure;
  listAudit(accessToken: string): { ok: true; entries: AuditView[] } | PlatformFailure;
  revoke(accessToken: string, sessionId: string): { ok: true } | PlatformFailure;
  disable(accessToken: string, employeeId: string): { ok: true } | PlatformFailure;
  setQuota(accessToken: string, input: { employeeId: string; limitTokens: number; concurrentLimit: number }): { ok: true } | PlatformFailure;
  providerView(accessToken: string): { ok: true; model: typeof MODEL_ID; keyPresent: boolean } | PlatformFailure;
  backup(accessToken: string): { ok: true; fileName: string; bytes: number } | PlatformFailure;
  createUpload(
    accessToken: string,
    input: { purpose: string; contentSha256: string; byteSize: number; idempotencyKey: string },
  ): { ok: true; upload: UploadView } | PlatformFailure;
  putUploadContent(accessToken: string, uploadId: string, content: string): { ok: true; upload: UploadView } | PlatformFailure;
  completeUpload(accessToken: string, uploadId: string): { ok: true; upload: UploadView } | PlatformFailure;
  cancelUpload(accessToken: string, uploadId: string): { ok: true; upload: UploadView } | PlatformFailure;
  getUpload(accessToken: string, uploadId: string): { ok: true; upload: UploadView } | PlatformFailure;
  readPrivateFile(accessToken: string, fileId: string): { ok: true; fileId: string; body: string } | PlatformFailure;
  cleanupStaging(accessToken: string): { ok: true; removed: number } | PlatformFailure;
  receiveLogBatch(
    accessToken: string,
    input: {
      batchId: string;
      deviceEpoch: string;
      cursorFrom: number;
      events: Array<{ seq: number; event: string; message: string; fields?: Record<string, string | number | boolean> }>;
    },
  ): { ok: true; receipt: LogBatchReceipt } | PlatformFailure;
  getLogBatchReceipt(accessToken: string, batchId: string): { ok: true; receipt: LogBatchReceipt } | PlatformFailure;
  publishSkillRelease(
    accessToken: string,
    input: { skillId: string; version: string; title: string; platforms: string[]; packageBody: string },
  ): { ok: true; release: SkillReleaseView } | PlatformFailure;
  submitSkill(
    accessToken: string,
    input: { skillId: string; version: string; platforms: string[]; packageBody: string },
  ): { ok: true; submissionId: string; status: string } | PlatformFailure;
  reviseSkillSubmission(
    accessToken: string,
    input: { submissionId: string; packageBody: string; platforms: string[] },
  ): { ok: true; submissionId: string; status: string; approvedRevision: number } | PlatformFailure;
  reviewSkillSubmission(
    accessToken: string,
    input: { submissionId: string; decision: "approve" | "reject"; note?: string },
  ): { ok: true; status: string } | PlatformFailure;
  listAvailableSkills(accessToken: string): { ok: true; skills: SkillReleaseView[] } | PlatformFailure;
  downloadSkillRelease(
    accessToken: string,
    skillId: string,
    version: string,
  ): { ok: true; contentSha256: string; packageBody: string; platforms: string[] } | PlatformFailure;
  ingestKnowledge(
    accessToken: string,
    input: { docId: string; title: string; format: string; body: string; aclGroup: string },
  ): { ok: true; docId: string; version: number } | PlatformFailure;
  searchKnowledge(accessToken: string, query: string): { ok: true; hits: KnowledgeHit[] } | PlatformFailure;
  citeKnowledge(
    accessToken: string,
    docId: string,
    locator: string,
  ): { ok: true; docId: string; version: number; excerpt: string } | PlatformFailure;
  revokeKnowledge(accessToken: string, docId: string): { ok: true } | PlatformFailure;
  draftWiki(
    accessToken: string,
    input: { pageId: string; title: string; body: string; sourceDocIds: string[] },
  ): { ok: true; page: WikiPageView } | PlatformFailure;
  reviseWiki(
    accessToken: string,
    input: { pageId: string; title: string; body: string; sourceDocIds: string[]; baseRevision: number },
  ): { ok: true; page: WikiPageView } | PlatformFailure;
  submitWikiReview(accessToken: string, pageId: string): { ok: true; page: WikiPageView } | PlatformFailure;
  reviewWiki(
    accessToken: string,
    input: { pageId: string; revision: number; decision: "approve" | "reject" },
  ): { ok: true; page: WikiPageView } | PlatformFailure;
  getPublishedWiki(accessToken: string, pageId: string): { ok: true; page: WikiPageView } | PlatformFailure;
  setLearningEnabled(accessToken: string, enabled: boolean): { ok: true; enabled: boolean } | PlatformFailure;
  learningEnabled(accessToken: string): { ok: true; enabled: boolean } | PlatformFailure;
  submitLearningCandidate(
    accessToken: string,
    input: { kind: "experience" | "memory" | "skill"; title: string; body: string; sourceTaskId?: string },
  ): { ok: true; candidate: LearningCandidateView } | PlatformFailure;
  reviewLearningCandidate(
    accessToken: string,
    input: { candidateId: string; decision: "approve" | "reject" },
  ): { ok: true; candidate: LearningCandidateView; resourceId?: string } | PlatformFailure;
  reviseLearningCandidate(
    accessToken: string,
    input: { candidateId: string; title: string; body: string },
  ): { ok: true; candidate: LearningCandidateView } | PlatformFailure;
  listOrgResources(accessToken: string): { ok: true; resources: OrgResourceView[] } | PlatformFailure;
  recordFeedback(
    accessToken: string,
    input: { resourceId: string; helpful: boolean; note?: string },
  ): { ok: true } | PlatformFailure;
  retireOrgResource(accessToken: string, resourceId: string): { ok: true } | PlatformFailure;
  ensureChannelInstallation(
    accessToken: string,
    input: { channel: string; channelTenantId: string; appId: string },
  ): { ok: true; installationId: string } | PlatformFailure;
  startChannelPairing(
    accessToken: string,
    input: { channel: string; channelTenantId: string; appId: string },
  ): { ok: true; pairingToken: string; expiresAtMs: number } | PlatformFailure;
  completeChannelPairing(
    accessToken: string,
    input: { pairingToken: string; externalUserId: string },
  ): { ok: true; binding: BindingView } | PlatformFailure;
  revokeChannelBinding(accessToken: string, bindingId: string): { ok: true } | PlatformFailure;
  listChannelBindings(accessToken: string): { ok: true; bindings: BindingView[] } | PlatformFailure;
  registerRemoteDevice(
    accessToken: string,
    input: { deviceId: string },
  ): { ok: true; device: DeviceEndpointView } | PlatformFailure;
  setRemoteEnabled(
    accessToken: string,
    input: { deviceId: string; enabled: boolean },
  ): { ok: true; device: DeviceEndpointView } | PlatformFailure;
  connectRemoteDevice(
    accessToken: string,
    deviceId: string,
  ): { ok: true; device: DeviceEndpointView } | PlatformFailure;
  disconnectRemoteDevice(
    accessToken: string,
    deviceId: string,
  ): { ok: true; device: DeviceEndpointView } | PlatformFailure;
  bindImConversation(
    accessToken: string,
    input: {
      bindingId: string;
      conversationId: string;
      deviceId: string;
      taskId?: string;
      outputScope?: "summary" | "status_only";
      allowInput?: boolean;
      allowControl?: boolean;
    },
  ): { ok: true; conversation: ConversationBindingView } | PlatformFailure;
  linkImTask(
    accessToken: string,
    input: { conversationKey: string; taskId: string },
  ): { ok: true; conversation: ConversationBindingView } | PlatformFailure;
  revokeImConversation(accessToken: string, conversationKey: string): { ok: true } | PlatformFailure;
  receiveChannelEvent(input: {
    channel: string;
    channelTenantId: string;
    appId: string;
    conversationId: string;
    externalUserId: string;
    messageId: string;
    text: string;
    kind?: string;
  }): { ok: true; ack: ChannelAck } | PlatformFailure;
  pollRelayCommands(
    accessToken: string,
    deviceId: string,
  ): { ok: true; commands: RelayEnvelope[] } | PlatformFailure;
  acceptRelayCommand(
    accessToken: string,
    input: { deviceId: string; commandId: string; taskId: string },
  ): { ok: true; receipt: CommandReceiptView; replayed: boolean } | PlatformFailure;
  markRelayDeliveryUnknown(
    accessToken: string,
    commandId: string,
  ): { ok: true; receipt: CommandReceiptView } | PlatformFailure;
  enqueueImOutbound(
    accessToken: string,
    input: { commandId: string; body: string; failMode?: "none" | "once" | "always" },
  ): { ok: true; delivery: OutboundDeliveryView } | PlatformFailure;
  retryImOutbound(
    accessToken: string,
    deliveryId: string,
  ): { ok: true; delivery: OutboundDeliveryView } | PlatformFailure;
  getRelayCommand(
    accessToken: string,
    commandId: string,
  ): { ok: true; receipt: CommandReceiptView } | PlatformFailure;
  getImOutbound(
    accessToken: string,
    deliveryId: string,
  ): { ok: true; delivery: OutboundDeliveryView } | PlatformFailure;
  getImConversation(
    accessToken: string,
    conversationKey: string,
  ): { ok: true; conversation: ConversationBindingView } | PlatformFailure;
  close(): void;
};

export type SessionView = { sessionId: string; deviceLabel: string; status: string; employeeId: string };
export type QuotaView = {
  model: typeof MODEL_ID;
  limitTokens: number;
  settledKnown: number;
  unsettledUnknown: number;
  openReserved: number;
  concurrentInUse: number;
  concurrentLimit: number;
  availableTokens: number;
  minimumRequestTokens?: number;
};
export type ReserveSuccess = {
  ok: true;
  requestId: string;
  model: typeof MODEL_ID;
  reservedTokens: number;
  replayed?: boolean;
  status: "open" | "settled" | "unknown";
  usage?: UsageView;
};
export type SettleSuccess = { ok: true; requestId: string; status: "settled" | "unknown"; usage: UsageView };
export type InvokeSuccess = {
  ok: true;
  requestId: string;
  model: typeof MODEL_ID;
  kind: InvokeKind;
  text: string;
  toolName?: string;
  usage: UsageView;
  reservationStatus: "settled" | "unknown";
  deltas: string[];
};
export type EmployeeView = {
  employeeId: string;
  name: string;
  role: EmployeeRole;
  status: string;
  quota: QuotaView;
  sessions: Array<{ sessionId: string; deviceLabel: string; status: string }>;
};
export type AuditView = { at: string; actorId: string; action: string; target: string };

type ReservationStatus = "open" | "settled" | "unknown";

export function openPlatform(config: PlatformConfig): { ok: true; app: PlatformApp } | { ok: false; message: string } {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(join(config.dataDir, "platform.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = DELETE");
  const ready = ensureSchema(db, config);
  if (!ready.ok) {
    db.close();
    return ready;
  }
  applyAuthorityLedger(db, config.dataDir);
  chmodSync(join(config.dataDir, "platform.sqlite"), 0o600);
  return { ok: true, app: createApp(db, config) };
}

function ensureSchema(db: DatabaseSync, config: PlatformConfig): { ok: true } | { ok: false; message: string } {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get();
  if (existing === undefined) {
    db.exec(SCHEMA);
    db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(1);
  }
  const versionRow = rowOf(db.prepare("SELECT version FROM schema_meta").get());
  let version = versionRow === undefined ? undefined : numberOf(versionRow, "version");
  if (version === 1) {
    ensureEnterpriseSchema(db);
    seedKnowledgeAcl(db);
    db.prepare("UPDATE schema_meta SET version = 2").run();
    version = 2;
    platformLog(config.dataDir, "info", "platform_schema_migrated", "平台库已升到企业资源 schema", { version: 2 });
  }
  if (version === 2) {
    ensureChannelSchema(db);
    db.prepare("UPDATE schema_meta SET version = 3").run();
    version = 3;
    platformLog(config.dataDir, "info", "platform_schema_migrated", "平台库已升到渠道中继 schema", { version: 3 });
  }
  if (version === 3) {
    // 既有库不会重跑完整 SCHEMA；补建额度申请表。
    db.exec(`CREATE TABLE IF NOT EXISTS quota_requests (
  employee_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  additional_tokens INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(employee_id,request_id)
);`);
    db.prepare("UPDATE schema_meta SET version = 4").run();
    version = 4;
    platformLog(config.dataDir, "info", "platform_schema_migrated", "平台库已升到额度申请 schema", { version: 4 });
  }
  if (version !== undefined && version > 4) {
    platformLog(config.dataDir, "error", "platform_schema_incompatible", "平台 schema 高于本机支持，拒绝写入", {
      version,
      supported: 4,
    });
    return {
      ok: false,
      message: `平台 schema ${version} 高于本机支持的 4，已保留原文件并拒绝打开`,
    };
  }
  if (version !== 4) {
    return { ok: false, message: "平台数据库版本无法识别，拒绝继续写入" };
  }
  ensureEnterpriseSchema(db);
  ensureChannelSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS quota_requests (
  employee_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  additional_tokens INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(employee_id,request_id)
);`);
  const countRow = rowOf(db.prepare("SELECT COUNT(*) AS count FROM employees").get());
  const count = countRow === undefined ? undefined : numberOf(countRow, "count");
  if (count === undefined) {
    return { ok: false, message: "无法读取员工表" };
  }
  if (count > 0) {
    seedKnowledgeAcl(db);
    platformLog(config.dataDir, "info", "platform_db_ready", "平台库已有员工，跳过初始化", { employees: count });
    return { ok: true };
  }
  const employees = loadSeed(config);
  if (!employees.ok) {
    return employees;
  }
  withTx(db, () => {
    const orgSeen = new Set<string>();
    for (const employee of employees.employees) {
      if (!orgSeen.has(employee.orgId)) {
        db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(employee.orgId, employee.orgName);
        orgSeen.add(employee.orgId);
      }
      db.prepare(
        "INSERT INTO employees (employee_id, org_id, name, role, status, password_hash) VALUES (?, ?, ?, ?, 'active', ?)",
      ).run(employee.employeeId, employee.orgId, employee.name, employee.role, hashPassword(employee.password));
      db.prepare(
        `INSERT INTO quota (
          employee_id, model, limit_tokens, concurrent_limit, reserve_tokens,
          settled_known, unsettled_unknown, open_reserved, concurrent_in_use
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)`,
      ).run(employee.employeeId, MODEL_ID, employee.limitTokens, employee.concurrentLimit, employee.reserveTokens);
    }
    seedKnowledgeAcl(db);
  });
  platformLog(config.dataDir, "info", "platform_seeded", "空库已写入初始员工", {
    seed: config.seed.kind,
    employees: employees.employees.length,
  });
  return { ok: true };
}

function loadSeed(config: PlatformConfig): { ok: true; employees: readonly SeedEmployee[] } | { ok: false; message: string } {
  if (config.seed.kind === "fixture") {
    return { ok: true, employees: config.seed.employees };
  }
  let raw: string;
  try {
    raw = readFileSync(config.seed.path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    return { ok: false, message: `无法读取引导文件: ${message}` };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "解析失败";
    return { ok: false, message: `引导文件不是 JSON: ${message}` };
  }
  const parsed = parseBootstrap(payload);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, employees: parsed.employees };
}

function createApp(db: DatabaseSync, config: PlatformConfig): PlatformApp {
  const inflight = new Map<string, Promise<LoginSuccess | PlatformFailure>>();
  let closed = false;
  let enterprise: EnterpriseApi | undefined;
  let channel: ChannelApi | undefined;

  function audit(orgId: string, actorId: string, action: string, target: string): void {
    db.prepare("INSERT INTO audit_log (at_ms, org_id, actor_id, action, target) VALUES (?, ?, ?, ?, ?)").run(
      config.now(),
      orgId,
      actorId,
      action,
      target,
    );
  }

  function issue(sessionId: string, employeeId: string, orgId: string, role: EmployeeRole, refreshToken: string): LoginSuccess {
    const iat = Math.floor(config.now() / 1000);
    const exp = iat + config.accessTtlSec;
    return {
      ok: true,
      accessToken: signAccess(config.sessionSecret, { sid: sessionId, iat, exp }),
      refreshToken,
      accessExpiresAt: new Date(exp * 1000).toISOString(),
      sessionId,
      employeeId,
      orgId,
      role,
    };
  }

  function principal(accessToken: string): Principal | PlatformFailure {
    const read = readAccess(config.sessionSecret, accessToken, config.now());
    if (!read.ok) {
      return failure("AUTH_REQUIRED", read.reason === "expired" ? "登录已过期" : "登录凭证无效");
    }
    const session = rowOf(db.prepare("SELECT employee_id, status FROM sessions WHERE session_id = ?").get(read.claims.sid));
    if (session === undefined) {
      return failure("AUTH_REQUIRED", "登录凭证无效");
    }
    const status = textOf(session, "status");
    const employeeId = textOf(session, "employee_id");
    if (employeeId === undefined) {
      return failure("AUTH_REQUIRED", "登录凭证无效");
    }
    const employee = rowOf(
      db.prepare("SELECT org_id, role, status FROM employees WHERE employee_id = ?").get(employeeId),
    );
    if (employee === undefined) {
      return failure("AUTH_REQUIRED", "登录凭证无效");
    }
    const orgId = textOf(employee, "org_id");
    const role = textOf(employee, "role");
    const employeeStatus = textOf(employee, "status");
    if (orgId === undefined || !isRole(role)) {
      return failure("AUTH_REQUIRED", "登录凭证无效");
    }
    if (employeeStatus !== "active") {
      return failure("SESSION_REVOKED", "账号已停用");
    }
    if (status === "revoked") {
      return failure("SESSION_REVOKED", "设备会话已撤销");
    }
    if (status !== "active") {
      return failure("SESSION_REVOKED", "已经退出");
    }
    return { ok: true, sessionId: read.claims.sid, employeeId, orgId, role };
  }

  function requireAdmin(accessToken: string): Principal | PlatformFailure {
    const actor = principal(accessToken);
    if (!actor.ok) {
      return actor;
    }
    if (actor.role !== "admin") {
      return failure("FORBIDDEN", "员工不能调用管理接口");
    }
    return actor;
  }

  function quotaView(row: Record<string, unknown>): QuotaView | undefined {
    const limitTokens = numberOf(row, "limit_tokens");
    const settledKnown = numberOf(row, "settled_known");
    const unsettledUnknown = numberOf(row, "unsettled_unknown");
    const openReserved = numberOf(row, "open_reserved");
    const concurrentInUse = numberOf(row, "concurrent_in_use");
    const concurrentLimit = numberOf(row, "concurrent_limit");
    if (
      limitTokens === undefined ||
      settledKnown === undefined ||
      unsettledUnknown === undefined ||
      openReserved === undefined ||
      concurrentInUse === undefined ||
      concurrentLimit === undefined
    ) {
      return undefined;
    }
    const available = limitTokens - settledKnown - unsettledUnknown - openReserved;
    return {
      model: MODEL_ID,
      limitTokens,
      settledKnown,
      unsettledUnknown,
      openReserved,
      concurrentInUse,
      concurrentLimit,
      availableTokens: available > 0 ? available : 0,
      ...(numberOf(row,'reserve_tokens')!==undefined?{minimumRequestTokens:numberOf(row,'reserve_tokens')!}:{}),
    };
  }

  function readQuotaRow(employeeId: string): Record<string, unknown> | undefined {
    return rowOf(db.prepare("SELECT * FROM quota WHERE employee_id = ?").get(employeeId));
  }

  function usageFromReservation(row: Record<string, unknown>): UsageView {
    const status = textOf(row, "status");
    const inputTokens = numberOf(row, "input_tokens");
    const outputTokens = numberOf(row, "output_tokens");
    if (status === "settled" && inputTokens !== undefined && outputTokens !== undefined) {
      return { state: "known", inputTokens, outputTokens };
    }
    return { state: "unknown" };
  }

  function reserveStatus(value: string | undefined): ReservationStatus | undefined {
    if (value === "open" || value === "settled" || value === "unknown") {
      return value;
    }
    return undefined;
  }

  const knowledge = createKnowledge(db, config.now);
  const market = createMarket(db, config.now);
  const app: PlatformApp = {
    knowledge(accessToken, action, input) {
      const actor = principal(accessToken);
      if (!actor.ok) return actor;
      const result = knowledge(actor, action, input);
      if (result.ok && !['list','read'].includes(action)) audit(actor.orgId, actor.employeeId, `knowledge_${action}`, String(input.id ?? 'new'));
      return result;
    },
    market(accessToken, action, input) {
      const actor = principal(accessToken);
      if (!actor.ok) return actor;
      const result = market(actor, action, input);
      if (result.ok && !["list","catalog","detail","validate","resolve","download","notifications","legacy-list","legacy-download"].includes(action)) audit(actor.orgId, actor.employeeId, `market_${action}`, String(input.id ?? "new"));
      return result;
    },
    login(input) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.employeeId) || !deviceLabelOk(input.deviceLabel)) {
        return failure("AUTH_REQUIRED", "账号或口令不正确");
      }
      const employee = rowOf(
        db.prepare("SELECT org_id, role, status, password_hash FROM employees WHERE employee_id = ?").get(input.employeeId),
      );
      if (employee === undefined || !verifyPassword(input.password, textOf(employee, "password_hash") ?? "")) {
        platformLog(config.dataDir, "warn", "login_rejected", "登录未通过", { employeeId: input.employeeId });
        return failure("AUTH_REQUIRED", "账号或口令不正确");
      }
      const orgId = textOf(employee, "org_id");
      const role = textOf(employee, "role");
      if (orgId === undefined || !isRole(role)) {
        return failure("AUTH_REQUIRED", "账号或口令不正确");
      }
      if (textOf(employee, "status") !== "active") {
        platformLog(config.dataDir, "warn", "login_disabled", "停用账号尝试登录", { employeeId: input.employeeId });
        return failure("AUTH_REQUIRED", "账号已停用");
      }
      const sessionId = `ses-${randomUUID().replaceAll("-", "")}`;
      const refreshToken = newRefreshToken();
      const now = config.now();
      const exp = Math.floor(now / 1000) + config.accessTtlSec;
      withTx(db, () => {
        db.prepare(
          `INSERT INTO sessions (
            session_id, employee_id, device_label, refresh_hash, status, access_expires_at, refresh_expires_at, created_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        ).run(sessionId, input.employeeId, input.deviceLabel, hashRefresh(refreshToken), exp * 1000, now + config.refreshTtlSec * 1000, now);
        audit(orgId, input.employeeId, "login", sessionId);
      });
      platformLog(config.dataDir, "info", "login_ok", "登录成功", {
        employeeId: input.employeeId,
        orgId,
        role,
      });
      return issue(sessionId, input.employeeId, orgId, role, refreshToken);
    },

    refresh(refreshToken) {
      const hash = hashRefresh(refreshToken);
      const existing = inflight.get(hash);
      if (existing !== undefined) {
        return existing;
      }
      const pending = Promise.resolve().then(() => rotate(refreshToken)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "续期失败";
        platformLog(config.dataDir, "error", "refresh_failed", "续期没有完成", { reason: message.slice(0, 80) });
        return failure("CONFLICT", "续期冲突，请重新登录");
      });
      inflight.set(hash, pending);
      void pending.finally(() => {
        if (inflight.get(hash) === pending) {
          inflight.delete(hash);
        }
      });
      return pending;
    },

    logout(accessToken) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      withTx(db, () => {
        db.prepare("UPDATE sessions SET status = 'logged_out' WHERE session_id = ? AND status = 'active'").run(actor.sessionId);
        audit(actor.orgId, actor.employeeId, "logout", actor.sessionId);
      });
      platformLog(config.dataDir, "info", "logout", "会话已退出", { employeeId: actor.employeeId });
      return { ok: true };
    },

    listOwnSessions(accessToken) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      const rows = db.prepare(
        "SELECT session_id, device_label, status, employee_id FROM sessions WHERE employee_id = ? ORDER BY created_at",
      ).all(actor.employeeId);
      const sessions: SessionView[] = [];
      for (const item of rows) {
        const row = rowOf(item);
        if (row === undefined) {
          continue;
        }
        const sessionId = textOf(row, "session_id");
        const deviceLabel = textOf(row, "device_label");
        const status = textOf(row, "status");
        const employeeId = textOf(row, "employee_id");
        if (sessionId === undefined || deviceLabel === undefined || status === undefined || employeeId === undefined) {
          continue;
        }
        sessions.push({ sessionId, deviceLabel, status, employeeId });
      }
      return { ok: true, sessions };
    },

    readOwnQuota(accessToken) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      const row = readQuotaRow(actor.employeeId);
      const quota = row === undefined ? undefined : quotaView(row);
      if (quota === undefined) {
        return failure("NOT_FOUND", "没有该员工的额度账户");
      }
      return { ok: true, quota };
    },

    requestOwnQuota(accessToken,input) {
      const actor=principal(accessToken);
      if(!actor.ok)return actor;
      if(!requestIdOk(input.requestId)||!Number.isSafeInteger(input.additionalTokens)||input.additionalTokens<1||input.additionalTokens>1_000_000)return failure('CONFIG_INVALID','每次可申请新增1至1000000 tokens，请填写整数。');
      const decision=withTx(db,()=>{
        const existing=rowOf(db.prepare('SELECT additional_tokens FROM quota_requests WHERE employee_id=? AND request_id=?').get(actor.employeeId,input.requestId));
        if(existing&&numberOf(existing,'additional_tokens')!==input.additionalTokens)return failure('CONFLICT','该申请编号已用于其他金额，请核实原申请结果。');
        const row=readQuotaRow(actor.employeeId),quota=row&&quotaView(row);
        if(!quota)return failure('NOT_FOUND','没有该员工的额度账户');
        if(!existing){
          const next=quota.limitTokens+input.additionalTokens;
          if(!Number.isSafeInteger(next))return failure('CONFIG_INVALID','额度累计值超出允许范围');
          db.prepare('UPDATE quota SET limit_tokens=? WHERE employee_id=?').run(next,actor.employeeId);
          db.prepare('INSERT INTO quota_requests VALUES(?,?,?,?,?)').run(actor.employeeId,input.requestId,input.additionalTokens,'approved',config.now());
          audit(actor.orgId,actor.employeeId,'quota_request_approved',actor.employeeId+':'+input.requestId);
        }
        const updated=quotaView(readQuotaRow(actor.employeeId)!);
        if(!updated)throw Error('额度回读失败');
        return {ok:true,requestId:input.requestId,additionalTokens:input.additionalTokens,status:'approved',approvalMode:'auto',replayed:Boolean(existing),quota:updated} as const;
      });
      if(decision.ok&&!decision.replayed)platformLog(config.dataDir,'info','quota_request_approved','额度申请已自动批准',{employeeId:actor.employeeId,additionalTokens:input.additionalTokens},input.requestId);
      return decision;
    },

    beginReport(accessToken, requestId) {
      const actor = principal(accessToken);
      if (!actor.ok) return actor;
      if (!requestIdOk(requestId)) return failure("CONFIG_INVALID", "requestId 格式不符合限制");
      const held = withTx(db, () => hold(actor, requestId));
      if (!held.ok) return held;
      // 已授权的在途调用即使后来撤销会话，也必须结清并释放并发位。
      return { ...held, finish: (usage) => withTx(db, () => closeReservation(actor, requestId, usage)) };
    },

    reserve(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      if (!requestIdOk(input.requestId)) {
        return failure("CONFIG_INVALID", "requestId 格式不符合限制");
      }
      if (input.model !== undefined && input.model !== MODEL_ID) {
        return failure("FORBIDDEN", "未获准的模型");
      }
      return withTx(db, () => hold(actor, input.requestId));
    },

    settle(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      if (!requestIdOk(input.requestId)) {
        return failure("CONFIG_INVALID", "requestId 格式不符合限制");
      }
      return withTx(db, () => closeReservation(actor, input.requestId, input.usage));
    },

    invoke(accessToken, input) {
      const kind = parseKind(input.kind);
      if (kind === undefined) {
        return failure("CONFIG_INVALID", "kind 不在文本、流式、工具、取消、超时之中");
      }
      const reserved = app.reserve(accessToken, { requestId: input.requestId, ...(input.model === undefined ? {} : { model: input.model }) });
      if (!reserved.ok) {
        return reserved;
      }
      if (reserved.status !== "open") {
        const usage = reserved.usage ?? { state: "unknown" as const };
        return {
          ok: true,
          requestId: input.requestId,
          model: MODEL_ID,
          kind,
          text: "",
          usage,
          reservationStatus: reserved.status === "settled" ? "settled" : "unknown",
          deltas: [],
        };
      }
      const outcome = mockOutcome(kind);
      const settled = app.settle(accessToken, { requestId: input.requestId, usage: outcome.usage });
      if (!settled.ok) {
        return settled;
      }
      const success: InvokeSuccess = {
        ok: true,
        requestId: input.requestId,
        model: MODEL_ID,
        kind,
        text: outcome.text,
        usage: settled.usage,
        reservationStatus: settled.status,
        deltas: outcome.deltas,
      };
      if (outcome.toolName !== undefined) {
        success.toolName = outcome.toolName;
      }
      return success;
    },

    listEmployees(accessToken) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      const rows = db.prepare(
        `SELECT e.employee_id, e.name, e.role, e.status,
                q.limit_tokens, q.settled_known, q.unsettled_unknown, q.open_reserved, q.concurrent_in_use, q.concurrent_limit
         FROM employees e JOIN quota q ON q.employee_id = e.employee_id
         WHERE e.org_id = ? ORDER BY e.employee_id`,
      ).all(actor.orgId);
      const employees: EmployeeView[] = [];
      for (const item of rows) {
        const row = rowOf(item);
        if (row === undefined) {
          continue;
        }
        const employeeId = textOf(row, "employee_id");
        const name = textOf(row, "name");
        const role = textOf(row, "role");
        const status = textOf(row, "status");
        const quota = quotaView(row);
        if (employeeId === undefined || name === undefined || !isRole(role) || status === undefined || quota === undefined) {
          continue;
        }
        const sessions = db.prepare(
          "SELECT session_id, device_label, status FROM sessions WHERE employee_id = ? ORDER BY created_at",
        ).all(employeeId);
        const sessionViews: EmployeeView["sessions"] = [];
        for (const sessionItem of sessions) {
          const session = rowOf(sessionItem);
          if (session === undefined) {
            continue;
          }
          const sessionId = textOf(session, "session_id");
          const deviceLabel = textOf(session, "device_label");
          const sessionStatus = textOf(session, "status");
          if (sessionId === undefined || deviceLabel === undefined || sessionStatus === undefined) {
            continue;
          }
          sessionViews.push({ sessionId, deviceLabel, status: sessionStatus });
        }
        employees.push({ employeeId, name, role, status, quota, sessions: sessionViews });
      }
      return { ok: true, employees };
    },

    listAudit(accessToken) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      const rows = db.prepare(
        "SELECT at_ms, actor_id, action, target FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT 50",
      ).all(actor.orgId);
      const entries: AuditView[] = [];
      for (const item of rows) {
        const row = rowOf(item);
        if (row === undefined) {
          continue;
        }
        const atMs = numberOf(row, "at_ms");
        const actorId = textOf(row, "actor_id");
        const action = textOf(row, "action");
        const target = textOf(row, "target");
        if (atMs === undefined || actorId === undefined || action === undefined || target === undefined) {
          continue;
        }
        entries.push({ at: new Date(atMs).toISOString(), actorId, action, target });
      }
      return { ok: true, entries };
    },

    revoke(accessToken, sessionId) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      if (!/^[a-z0-9-]{8,64}$/.test(sessionId)) {
        return failure("NOT_FOUND", "没有这个设备会话");
      }
      const session = rowOf(db.prepare(
        `SELECT s.status, e.org_id FROM sessions s JOIN employees e ON e.employee_id = s.employee_id WHERE s.session_id = ?`,
      ).get(sessionId));
      if (session === undefined) {
        return failure("NOT_FOUND", "没有这个设备会话");
      }
      if (textOf(session, "org_id") !== actor.orgId) {
        platformLog(config.dataDir, "warn", "revoke_cross_org", "拒绝跨组织撤销", { employeeId: actor.employeeId });
        return failure("FORBIDDEN", "不能访问其他企业的对象");
      }
      withTx(db, () => {
        db.prepare("UPDATE sessions SET status = 'revoked' WHERE session_id = ? AND status = 'active'").run(sessionId);
        audit(actor.orgId, actor.employeeId, "revoke", sessionId);
      });
      appendAuthorityRevocation(config.dataDir, {
        kind: "session",
        id: sessionId,
        at: config.now(),
        orgId: actor.orgId,
        actorId: actor.employeeId,
      });
      platformLog(config.dataDir, "info", "session_revoked", "设备会话已撤销", { sessionId });
      return { ok: true };
    },

    disable(accessToken, employeeId) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      if (employeeId === actor.employeeId) {
        return failure("CONFLICT", "不能停用当前登录账号");
      }
      const employee = rowOf(db.prepare("SELECT org_id, status FROM employees WHERE employee_id = ?").get(employeeId));
      if (employee === undefined) {
        return failure("NOT_FOUND", "没有这个员工");
      }
      if (textOf(employee, "org_id") !== actor.orgId) {
        return failure("FORBIDDEN", "不能访问其他企业的对象");
      }
      withTx(db, () => {
        db.prepare("UPDATE employees SET status = 'disabled' WHERE employee_id = ?").run(employeeId);
        db.prepare("UPDATE sessions SET status = 'revoked' WHERE employee_id = ? AND status = 'active'").run(employeeId);
        audit(actor.orgId, actor.employeeId, "disable", employeeId);
      });
      appendAuthorityRevocation(config.dataDir, {
        kind: "employee",
        id: employeeId,
        at: config.now(),
        orgId: actor.orgId,
        actorId: actor.employeeId,
      });
      platformLog(config.dataDir, "info", "employee_disabled", "员工已停用", { target: employeeId });
      return { ok: true };
    },

    setQuota(accessToken, input) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      if (!Number.isInteger(input.limitTokens) || input.limitTokens < 1 || input.limitTokens > 1_000_000) {
        return failure("CONFIG_INVALID", "额度上限超出允许范围");
      }
      if (!Number.isInteger(input.concurrentLimit) || input.concurrentLimit < 1 || input.concurrentLimit > 8) {
        return failure("CONFIG_INVALID", "并发上限超出允许范围");
      }
      const employee = rowOf(db.prepare("SELECT org_id FROM employees WHERE employee_id = ?").get(input.employeeId));
      if (employee === undefined) {
        return failure("NOT_FOUND", "没有这个员工");
      }
      if (textOf(employee, "org_id") !== actor.orgId) {
        return failure("FORBIDDEN", "不能访问其他企业的对象");
      }
      withTx(db, () => {
        db.prepare("UPDATE quota SET limit_tokens = ?, concurrent_limit = ? WHERE employee_id = ?").run(
          input.limitTokens,
          input.concurrentLimit,
          input.employeeId,
        );
        audit(actor.orgId, actor.employeeId, "quota", input.employeeId);
      });
      platformLog(config.dataDir, "info", "quota_updated", "额度已更新", {
        target: input.employeeId,
        limitTokens: input.limitTokens,
        concurrentLimit: input.concurrentLimit,
      });
      return { ok: true };
    },

    providerView(accessToken) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return { ok: true, model: MODEL_ID, keyPresent: config.keyPresent };
    },

    backup(accessToken) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      const dir = join(config.dataDir, "backups");
      mkdirSync(dir, { recursive: true });
      const fileName = `platform-${config.now()}-${randomBytes(4).toString("hex")}.sqlite`;
      const destination = join(dir, fileName);
      db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
      chmodSync(destination, 0o600);
      const bytes = statSync(destination).size;
      audit(actor.orgId, actor.employeeId, "backup", fileName);
      platformLog(config.dataDir, "info", "backup_created", "已写出平台库备份", { bytes });
      return { ok: true, fileName, bytes };
    },

    createUpload(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().createUpload(actor, input);
    },
    putUploadContent(accessToken, uploadId, content) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().putUploadContent(actor, uploadId, content);
    },
    completeUpload(accessToken, uploadId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().completeUpload(actor, uploadId);
    },
    cancelUpload(accessToken, uploadId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().cancelUpload(actor, uploadId);
    },
    getUpload(accessToken, uploadId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().getUpload(actor, uploadId);
    },
    readPrivateFile(accessToken, fileId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().readPrivateFile(actor, fileId);
    },
    cleanupStaging(accessToken) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().cleanupStaging(actor);
    },
    receiveLogBatch(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().receiveLogBatch(actor, input);
    },
    getLogBatchReceipt(accessToken, batchId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().getLogBatchReceipt(actor, batchId);
    },
    publishSkillRelease(accessToken, input) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().publishSkillRelease(actor, input);
    },
    submitSkill(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().submitSkill(actor, input);
    },
    reviseSkillSubmission(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().reviseSkillSubmission(actor, input);
    },
    reviewSkillSubmission(accessToken, input) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().reviewSkillSubmission(actor, input);
    },
    listAvailableSkills(accessToken) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().listAvailableSkills(actor);
    },
    downloadSkillRelease(accessToken, skillId, version) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().downloadSkillRelease(actor, skillId, version);
    },
    ingestKnowledge(accessToken, input) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().ingestKnowledge(actor, input);
    },
    searchKnowledge(accessToken, query) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().searchKnowledge(actor, query);
    },
    citeKnowledge(accessToken, docId, locator) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().citeKnowledge(actor, docId, locator);
    },
    revokeKnowledge(accessToken, docId) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      const revoked = enterpriseApi().revokeKnowledge(actor, docId);
      if (revoked.ok) {
        appendAuthorityRevocation(config.dataDir, {
          kind: "knowledge",
          id: docId,
          at: config.now(),
          orgId: actor.orgId,
          actorId: actor.employeeId,
        });
      }
      return revoked;
    },
    draftWiki(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().draftWiki(actor, input);
    },
    reviseWiki(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().reviseWiki(actor, input);
    },
    submitWikiReview(accessToken, pageId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().submitWikiReview(actor, pageId);
    },
    reviewWiki(accessToken, input) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().reviewWiki(actor, input);
    },
    getPublishedWiki(accessToken, pageId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().getPublishedWiki(actor, pageId);
    },
    setLearningEnabled(accessToken, enabled) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().setLearningEnabled(actor, enabled);
    },
    learningEnabled(accessToken) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().learningEnabled(actor);
    },
    submitLearningCandidate(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().submitLearningCandidate(actor, input);
    },
    reviewLearningCandidate(accessToken, input) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().reviewLearningCandidate(actor, input);
    },
    reviseLearningCandidate(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().reviseLearningCandidate(actor, input);
    },
    listOrgResources(accessToken) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().listOrgResources(actor);
    },
    recordFeedback(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().recordFeedback(actor, input);
    },
    retireOrgResource(accessToken, resourceId) {
      const actor = requireAdmin(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return enterpriseApi().retireOrgResource(actor, resourceId);
    },

    ensureChannelInstallation(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().ensureInstallation(actor, input);
    },
    startChannelPairing(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().startPairing(actor, input);
    },
    completeChannelPairing(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().completePairing(actor, input);
    },
    revokeChannelBinding(accessToken, bindingId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().revokeBinding(actor, bindingId);
    },
    listChannelBindings(accessToken) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().listBindings(actor);
    },
    registerRemoteDevice(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().registerDevice(actor, input);
    },
    setRemoteEnabled(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().setRemoteEnabled(actor, input);
    },
    connectRemoteDevice(accessToken, deviceId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().connectDevice(actor, deviceId);
    },
    disconnectRemoteDevice(accessToken, deviceId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().disconnectDevice(actor, deviceId);
    },
    bindImConversation(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().bindConversation(actor, input);
    },
    linkImTask(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().linkTask(actor, input);
    },
    revokeImConversation(accessToken, conversationKey) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().revokeConversation(actor, conversationKey);
    },
    receiveChannelEvent(input) {
      return channelApi().receiveChannelEvent(input);
    },
    pollRelayCommands(accessToken, deviceId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().pollCommands(actor, deviceId);
    },
    acceptRelayCommand(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().acceptCommand(actor, input);
    },
    markRelayDeliveryUnknown(accessToken, commandId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().markDeliveryUnknown(actor, commandId);
    },
    enqueueImOutbound(accessToken, input) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().enqueueOutbound(actor, input);
    },
    retryImOutbound(accessToken, deliveryId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().retryOutbound(actor, deliveryId);
    },
    getRelayCommand(accessToken, commandId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().getCommand(actor, commandId);
    },
    getImOutbound(accessToken, deliveryId) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().getOutbound(actor, deliveryId);
    },
    getImConversation(accessToken, conversationKey) {
      const actor = principal(accessToken);
      if (!actor.ok) {
        return actor;
      }
      return channelApi().getConversation(actor, conversationKey);
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    },
  };

  function enterpriseApi(): EnterpriseApi {
    if (enterprise === undefined) {
      enterprise = createEnterpriseApi(db, config, audit);
    }
    return enterprise;
  }

  function channelApi(): ChannelApi {
    if (channel === undefined) {
      channel = createChannelApi(db, config, audit);
    }
    return channel;
  }

  function rotate(refreshToken: string): LoginSuccess | PlatformFailure {
    const hash = hashRefresh(refreshToken);
    const session = rowOf(
      db.prepare("SELECT session_id, employee_id, status, refresh_expires_at FROM sessions WHERE refresh_hash = ?").get(hash),
    );
    if (session === undefined) {
      return failure("AUTH_REQUIRED", "登录凭证无效");
    }
    const sessionId = textOf(session, "session_id");
    const employeeId = textOf(session, "employee_id");
    const status = textOf(session, "status");
    const refreshExpires = numberOf(session, "refresh_expires_at");
    if (sessionId === undefined || employeeId === undefined || refreshExpires === undefined) {
      return failure("AUTH_REQUIRED", "登录凭证无效");
    }
    if (status === "revoked") {
      return failure("SESSION_REVOKED", "设备会话已撤销");
    }
    if (status !== "active") {
      return failure("SESSION_REVOKED", "已经退出");
    }
    if (refreshExpires <= config.now()) {
      return failure("AUTH_REQUIRED", "登录已过期");
    }
    const employee = rowOf(db.prepare("SELECT org_id, role, status FROM employees WHERE employee_id = ?").get(employeeId));
    if (employee === undefined) {
      return failure("AUTH_REQUIRED", "登录凭证无效");
    }
    const orgId = textOf(employee, "org_id");
    const role = textOf(employee, "role");
    if (orgId === undefined || !isRole(role)) {
      return failure("AUTH_REQUIRED", "登录凭证无效");
    }
    if (textOf(employee, "status") !== "active") {
      return failure("SESSION_REVOKED", "账号已停用");
    }
    const nextRefresh = newRefreshToken();
    const exp = Math.floor(config.now() / 1000) + config.accessTtlSec;
    withTx(db, () => {
      const changed = db.prepare(
        "UPDATE sessions SET refresh_hash = ?, access_expires_at = ?, refresh_expires_at = ? WHERE session_id = ? AND refresh_hash = ?",
      ).run(hashRefresh(nextRefresh), exp * 1000, config.now() + config.refreshTtlSec * 1000, sessionId, hash);
      if (Number(changed.changes) !== 1) {
        throw new Error("刷新令牌已轮换");
      }
      audit(orgId, employeeId, "refresh", sessionId);
    });
    platformLog(config.dataDir, "info", "session_refreshed", "会话已续期", { employeeId });
    return issue(sessionId, employeeId, orgId, role, nextRefresh);
  }

  function hold(actor: Principal, requestId: string): ReserveSuccess | PlatformFailure {
    const existing = rowOf(db.prepare("SELECT * FROM reservations WHERE request_id = ?").get(requestId));
    if (existing !== undefined) {
      if (textOf(existing, "employee_id") !== actor.employeeId) {
        return failure("CONFLICT", "请求标识已被使用");
      }
      const status = reserveStatus(textOf(existing, "status"));
      const reservedTokens = numberOf(existing, "reserved_tokens");
      if (status === undefined || reservedTokens === undefined) {
        return failure("CONFIG_INVALID", "预留记录无法读取");
      }
      const success: ReserveSuccess = {
        ok: true,
        requestId,
        model: MODEL_ID,
        reservedTokens,
        replayed: true,
        status,
      };
      if (status !== "open") {
        success.usage = usageFromReservation(existing);
      }
      return success;
    }
    const quota = readQuotaRow(actor.employeeId);
    if (quota === undefined) {
      return failure("NOT_FOUND", "没有该员工的额度账户");
    }
    const view = quotaView(quota);
    const reserveTokens = numberOf(quota, "reserve_tokens");
    if (view === undefined || reserveTokens === undefined) {
      return failure("CONFIG_INVALID", "额度账户无法读取");
    }
    if (view.concurrentInUse >= view.concurrentLimit) {
      platformLog(config.dataDir, "warn", "quota_concurrency", "并发位已满", {
        employeeId: actor.employeeId,
        concurrentInUse: view.concurrentInUse,
      }, requestId);
      return failure("QUOTA_EXCEEDED", "并发已达上限");
    }
    if (view.availableTokens < reserveTokens) {
      platformLog(config.dataDir, "warn", "quota_exceeded", "可用额度不足", {
        employeeId: actor.employeeId,
        availableTokens: view.availableTokens,
      }, requestId);
      return failure("QUOTA_EXCEEDED", "额度不足");
    }
    db.prepare(
      `INSERT INTO reservations (
        request_id, employee_id, session_id, model, reserved_tokens, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    ).run(requestId, actor.employeeId, actor.sessionId, MODEL_ID, reserveTokens, config.now());
    db.prepare(
      "UPDATE quota SET open_reserved = open_reserved + ?, concurrent_in_use = concurrent_in_use + 1 WHERE employee_id = ?",
    ).run(reserveTokens, actor.employeeId);
    audit(actor.orgId, actor.employeeId, "reserve", requestId);
    platformLog(config.dataDir, "info", "quota_reserved", "已预留模型额度", {
      employeeId: actor.employeeId,
      model: MODEL_ID,
      reservedTokens: reserveTokens,
    }, requestId);
    return { ok: true, requestId, model: MODEL_ID, reservedTokens: reserveTokens, status: "open" };
  }

  function closeReservation(actor: Principal, requestId: string, usage: UsageView): SettleSuccess | PlatformFailure {
    const existing = rowOf(db.prepare("SELECT * FROM reservations WHERE request_id = ?").get(requestId));
    if (existing === undefined || textOf(existing, "employee_id") !== actor.employeeId) {
      return failure("NOT_FOUND", "没有这个预留");
    }
    const status = reserveStatus(textOf(existing, "status"));
    const reservedTokens = numberOf(existing, "reserved_tokens");
    if (status === undefined || reservedTokens === undefined) {
      return failure("CONFIG_INVALID", "预留记录无法读取");
    }
    if (status !== "open") {
      return { ok: true, requestId, status: status === "settled" ? "settled" : "unknown", usage: usageFromReservation(existing) };
    }
    if (usage.state === "known") {
      db.prepare(
        "UPDATE reservations SET status = 'settled', input_tokens = ?, output_tokens = ? WHERE request_id = ?",
      ).run(usage.inputTokens, usage.outputTokens, requestId);
      db.prepare(
        `UPDATE quota
         SET open_reserved = open_reserved - ?, concurrent_in_use = concurrent_in_use - 1, settled_known = settled_known + ?
         WHERE employee_id = ?`,
      ).run(reservedTokens, usage.inputTokens + usage.outputTokens, actor.employeeId);
      audit(actor.orgId, actor.employeeId, "settle", requestId);
      platformLog(config.dataDir, "info", "quota_settled", "已按已知用量结算", {
        employeeId: actor.employeeId,
        usageState: "known",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }, requestId);
      return { ok: true, requestId, status: "settled", usage };
    }
    db.prepare("UPDATE reservations SET status = 'unknown' WHERE request_id = ?").run(requestId);
    db.prepare(
      `UPDATE quota
       SET open_reserved = open_reserved - ?, concurrent_in_use = concurrent_in_use - 1, unsettled_unknown = unsettled_unknown + ?
       WHERE employee_id = ?`,
    ).run(reservedTokens, reservedTokens, actor.employeeId);
    audit(actor.orgId, actor.employeeId, "settle_unknown", requestId);
    platformLog(config.dataDir, "warn", "quota_unknown", "未知用量保留预留，未记为零", {
      employeeId: actor.employeeId,
      usageState: "unknown",
      reservedTokens,
    }, requestId);
    return { ok: true, requestId, status: "unknown", usage: { state: "unknown" } };
  }

  return app;
}

function parseKind(value: string): InvokeKind | undefined {
  if (value === "text" || value === "stream" || value === "tool" || value === "cancel" || value === "timeout") {
    return value;
  }
  return undefined;
}

function mockOutcome(kind: InvokeKind): { text: string; usage: UsageView; deltas: string[]; toolName?: string } {
  if (kind === "text") {
    return { text: "好", usage: { state: "known", inputTokens: 3, outputTokens: 2 }, deltas: [] };
  }
  if (kind === "stream") {
    return { text: "合成流结束", usage: { state: "known", inputTokens: 3, outputTokens: 4 }, deltas: ["合成", "流结束"] };
  }
  if (kind === "tool") {
    return { text: "", usage: { state: "known", inputTokens: 5, outputTokens: 1 }, deltas: [], toolName: "echo" };
  }
  return { text: "", usage: { state: "unknown" }, deltas: [] };
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  inboundDedupKey,
  parseRelayEnvelope,
  type ChannelKind,
  type RelayCommandKind,
  type RelayEnvelope,
} from "@cpclaw/contracts";
import type { PlatformConfig } from "./config.js";
import { platformLog } from "./log.js";

/** 投递信封有效期工程上限（毫秒）。不是业务 SLA。 */
export const COMMAND_TTL_MS = 5 * 60 * 1000;
/** 外发回复有界重试次数。 */
export const OUTBOUND_RETRY_MAX = 3;
/** 配对令牌有效期（毫秒）。 */
export const PAIRING_TTL_MS = 2 * 60 * 1000;

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

export type ChannelAck = {
  /** 渠道协议 ACK：只表示平台收到事件，不表示 PC 已受理。 */
  protocolAck: true;
  status: "accepted_by_platform" | "device_offline" | "duplicate" | "rejected";
  message: string;
  commandId?: string;
  inboundKey: string;
};

export type BindingView = {
  bindingId: string;
  channel: ChannelKind;
  channelTenantId: string;
  appId: string;
  externalUserId: string;
  revision: number;
  status: "active" | "revoked";
};

export type DeviceEndpointView = {
  deviceId: string;
  remoteEnabled: boolean;
  online: boolean;
  connectionGeneration: number;
};

export type ConversationBindingView = {
  conversationKey: string;
  channel: ChannelKind;
  conversationId: string;
  taskId: string | null;
  bindingRevision: number;
  outputScope: "summary" | "status_only";
  allowInput: boolean;
  allowControl: boolean;
  status: "active" | "revoked";
};

export type CommandReceiptView = {
  commandId: string;
  status: "pending" | "accepted" | "expired" | "delivery_unknown" | "rejected";
  taskId: string | null;
  deviceId: string;
  channel: ChannelKind;
};

export type OutboundDeliveryView = {
  deliveryId: string;
  commandId: string;
  channel: ChannelKind;
  conversationId: string;
  status: "pending" | "submitted" | "failed" | "blocked";
  attempts: number;
  body: string;
};

export const CHANNEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_installations (
  installation_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_install_uniq
  ON channel_installations(org_id, channel, channel_tenant_id, app_id);
CREATE TABLE IF NOT EXISTS channel_pairings (
  pairing_token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_bindings (
  binding_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_binding_ext
  ON identity_bindings(channel, channel_tenant_id, app_id, external_user_id)
  WHERE status = 'active';
CREATE TABLE IF NOT EXISTS device_endpoints (
  device_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  remote_enabled INTEGER NOT NULL,
  online INTEGER NOT NULL,
  connection_generation INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_bindings (
  conversation_key TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  task_id TEXT,
  binding_revision INTEGER NOT NULL,
  output_scope TEXT NOT NULL,
  allow_input INTEGER NOT NULL,
  allow_control INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbound_messages (
  inbound_key TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  command_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_commands (
  command_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  inbound_key TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound_deliveries (
  delivery_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  fail_mode TEXT,
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

function idOk(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

function isChannel(value: string): value is ChannelKind {
  return value === "feishu" || value === "wecom";
}

function isKind(value: string): value is RelayCommandKind {
  return value === "ask" || value === "follow_up" || value === "status" || value === "stop";
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

function conversationKeyOf(
  channel: ChannelKind,
  channelTenantId: string,
  appId: string,
  conversationId: string,
  bindingId: string,
): string {
  return `${channel}:${channelTenantId}:${appId}:${conversationId}:${bindingId}`;
}

/** 拒绝把本地绝对路径当手机可下载链接外发。 */
export function containsAbsolutePathLeak(text: string): boolean {
  return /(?:^|[\s"'`(])\/(?:Users|Volumes|home|tmp|var|private)\//.test(text) || /[A-Za-z]:\\/.test(text);
}

type AuditFn = (orgId: string, actorId: string, action: string, target: string) => void;

export type ChannelApi = {
  ensureInstallation(
    actor: Principal,
    input: { channel: string; channelTenantId: string; appId: string },
  ): { ok: true; installationId: string } | PlatformFailure;
  startPairing(
    actor: Principal,
    input: { channel: string; channelTenantId: string; appId: string },
  ): { ok: true; pairingToken: string; expiresAtMs: number } | PlatformFailure;
  completePairing(
    actor: Principal,
    input: { pairingToken: string; externalUserId: string },
  ): { ok: true; binding: BindingView } | PlatformFailure;
  revokeBinding(actor: Principal, bindingId: string): { ok: true } | PlatformFailure;
  listBindings(actor: Principal): { ok: true; bindings: BindingView[] } | PlatformFailure;
  registerDevice(
    actor: Principal,
    input: { deviceId: string },
  ): { ok: true; device: DeviceEndpointView } | PlatformFailure;
  setRemoteEnabled(
    actor: Principal,
    input: { deviceId: string; enabled: boolean },
  ): { ok: true; device: DeviceEndpointView } | PlatformFailure;
  connectDevice(actor: Principal, deviceId: string): { ok: true; device: DeviceEndpointView } | PlatformFailure;
  disconnectDevice(actor: Principal, deviceId: string): { ok: true; device: DeviceEndpointView } | PlatformFailure;
  bindConversation(
    actor: Principal,
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
  linkTask(
    actor: Principal,
    input: { conversationKey: string; taskId: string },
  ): { ok: true; conversation: ConversationBindingView } | PlatformFailure;
  revokeConversation(actor: Principal, conversationKey: string): { ok: true } | PlatformFailure;
  receiveChannelEvent(
    input: {
      channel: string;
      channelTenantId: string;
      appId: string;
      conversationId: string;
      externalUserId: string;
      messageId: string;
      text: string;
      kind?: string;
    },
  ): { ok: true; ack: ChannelAck } | PlatformFailure;
  pollCommands(
    actor: Principal,
    deviceId: string,
  ): { ok: true; commands: RelayEnvelope[] } | PlatformFailure;
  acceptCommand(
    actor: Principal,
    input: { deviceId: string; commandId: string; taskId: string },
  ): { ok: true; receipt: CommandReceiptView; replayed: boolean } | PlatformFailure;
  markDeliveryUnknown(actor: Principal, commandId: string): { ok: true; receipt: CommandReceiptView } | PlatformFailure;
  enqueueOutbound(
    actor: Principal,
    input: { commandId: string; body: string; failMode?: "none" | "once" | "always" },
  ): { ok: true; delivery: OutboundDeliveryView } | PlatformFailure;
  retryOutbound(actor: Principal, deliveryId: string): { ok: true; delivery: OutboundDeliveryView } | PlatformFailure;
  getCommand(actor: Principal, commandId: string): { ok: true; receipt: CommandReceiptView } | PlatformFailure;
  getOutbound(actor: Principal, deliveryId: string): { ok: true; delivery: OutboundDeliveryView } | PlatformFailure;
  getConversation(
    actor: Principal,
    conversationKey: string,
  ): { ok: true; conversation: ConversationBindingView } | PlatformFailure;
};

export function ensureChannelSchema(db: DatabaseSync): void {
  db.exec(CHANNEL_SCHEMA);
}

export function createChannelApi(db: DatabaseSync, config: PlatformConfig, audit: AuditFn): ChannelApi {
  function bindingView(row: Record<string, unknown>): BindingView | undefined {
    const bindingId = textOf(row, "binding_id");
    const channel = textOf(row, "channel");
    const channelTenantId = textOf(row, "channel_tenant_id");
    const appId = textOf(row, "app_id");
    const externalUserId = textOf(row, "external_user_id");
    const revision = numberOf(row, "revision");
    const status = textOf(row, "status");
    if (
      bindingId === undefined ||
      channel === undefined ||
      !isChannel(channel) ||
      channelTenantId === undefined ||
      appId === undefined ||
      externalUserId === undefined ||
      revision === undefined ||
      (status !== "active" && status !== "revoked")
    ) {
      return undefined;
    }
    return { bindingId, channel, channelTenantId, appId, externalUserId, revision, status };
  }

  function deviceView(row: Record<string, unknown>): DeviceEndpointView | undefined {
    const deviceId = textOf(row, "device_id");
    const remoteEnabled = numberOf(row, "remote_enabled");
    const online = numberOf(row, "online");
    const connectionGeneration = numberOf(row, "connection_generation");
    if (deviceId === undefined || remoteEnabled === undefined || online === undefined || connectionGeneration === undefined) {
      return undefined;
    }
    return {
      deviceId,
      remoteEnabled: remoteEnabled === 1,
      online: online === 1,
      connectionGeneration,
    };
  }

  function conversationView(row: Record<string, unknown>): ConversationBindingView | undefined {
    const conversationKey = textOf(row, "conversation_key");
    const channel = textOf(row, "channel");
    const conversationId = textOf(row, "conversation_id");
    const taskId = textOf(row, "task_id") ?? null;
    const bindingRevision = numberOf(row, "binding_revision");
    const outputScope = textOf(row, "output_scope");
    const allowInput = numberOf(row, "allow_input");
    const allowControl = numberOf(row, "allow_control");
    const status = textOf(row, "status");
    if (
      conversationKey === undefined ||
      channel === undefined ||
      !isChannel(channel) ||
      conversationId === undefined ||
      bindingRevision === undefined ||
      (outputScope !== "summary" && outputScope !== "status_only") ||
      allowInput === undefined ||
      allowControl === undefined ||
      (status !== "active" && status !== "revoked")
    ) {
      return undefined;
    }
    return {
      conversationKey,
      channel,
      conversationId,
      taskId,
      bindingRevision,
      outputScope,
      allowInput: allowInput === 1,
      allowControl: allowControl === 1,
      status,
    };
  }

  function commandView(row: Record<string, unknown>): CommandReceiptView | undefined {
    const commandId = textOf(row, "command_id");
    const status = textOf(row, "status");
    const deviceId = textOf(row, "device_id");
    const channel = textOf(row, "channel");
    if (
      commandId === undefined ||
      deviceId === undefined ||
      channel === undefined ||
      !isChannel(channel) ||
      (status !== "pending" &&
        status !== "accepted" &&
        status !== "expired" &&
        status !== "delivery_unknown" &&
        status !== "rejected")
    ) {
      return undefined;
    }
    return {
      commandId,
      status,
      taskId: textOf(row, "task_id") ?? null,
      deviceId,
      channel,
    };
  }

  function outboundView(row: Record<string, unknown>): OutboundDeliveryView | undefined {
    const deliveryId = textOf(row, "delivery_id");
    const commandId = textOf(row, "command_id");
    const channel = textOf(row, "channel");
    const conversationId = textOf(row, "conversation_id");
    const body = textOf(row, "body");
    const status = textOf(row, "status");
    const attempts = numberOf(row, "attempts");
    if (
      deliveryId === undefined ||
      commandId === undefined ||
      channel === undefined ||
      !isChannel(channel) ||
      conversationId === undefined ||
      body === undefined ||
      attempts === undefined ||
      (status !== "pending" && status !== "submitted" && status !== "failed" && status !== "blocked")
    ) {
      return undefined;
    }
    return { deliveryId, commandId, channel, conversationId, status, attempts, body };
  }

  return {
    ensureInstallation(actor, input) {
      if (actor.role !== "admin") {
        return failure("FORBIDDEN", "只有管理员可以配置渠道应用");
      }
      if (!isChannel(input.channel) || !idOk(input.channelTenantId) || !idOk(input.appId)) {
        return failure("CONFIG_INVALID", "渠道安装参数不符合限制");
      }
      const existing = rowOf(
        db
          .prepare(
            `SELECT installation_id FROM channel_installations
             WHERE org_id = ? AND channel = ? AND channel_tenant_id = ? AND app_id = ?`,
          )
          .get(actor.orgId, input.channel, input.channelTenantId, input.appId),
      );
      if (existing !== undefined) {
        const installationId = textOf(existing, "installation_id");
        if (installationId === undefined) {
          return failure("CONFIG_INVALID", "渠道安装记录损坏");
        }
        return { ok: true, installationId };
      }
      const installationId = randomUUID();
      db.prepare(
        `INSERT INTO channel_installations (
          installation_id, org_id, channel, channel_tenant_id, app_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      ).run(installationId, actor.orgId, input.channel, input.channelTenantId, input.appId, config.now());
      audit(actor.orgId, actor.employeeId, "channel_install", installationId);
      platformLog(config.dataDir, "info", "channel_install", "渠道应用已配置", {
        channel: input.channel,
        appId: input.appId,
      });
      return { ok: true, installationId };
    },

    startPairing(actor, input) {
      if (!isChannel(input.channel) || !idOk(input.channelTenantId) || !idOk(input.appId)) {
        return failure("CONFIG_INVALID", "配对参数不符合限制");
      }
      const install = rowOf(
        db
          .prepare(
            `SELECT installation_id FROM channel_installations
             WHERE org_id = ? AND channel = ? AND channel_tenant_id = ? AND app_id = ? AND status = 'active'`,
          )
          .get(actor.orgId, input.channel, input.channelTenantId, input.appId),
      );
      if (install === undefined) {
        return failure("NOT_FOUND", "渠道应用未配置");
      }
      const pairingToken = randomUUID();
      const expiresAtMs = config.now() + PAIRING_TTL_MS;
      db.prepare(
        `INSERT INTO channel_pairings (
          pairing_token, org_id, employee_id, channel, channel_tenant_id, app_id, expires_at, consumed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        pairingToken,
        actor.orgId,
        actor.employeeId,
        input.channel,
        input.channelTenantId,
        input.appId,
        expiresAtMs,
        config.now(),
      );
      audit(actor.orgId, actor.employeeId, "channel_pair_start", pairingToken);
      return { ok: true, pairingToken, expiresAtMs };
    },

    completePairing(actor, input) {
      if (!idOk(input.pairingToken) || !idOk(input.externalUserId)) {
        return failure("CONFIG_INVALID", "配对完成参数不符合限制");
      }
      return withTx(db, () => {
        const pairing = rowOf(
          db.prepare("SELECT * FROM channel_pairings WHERE pairing_token = ?").get(input.pairingToken),
        );
        if (pairing === undefined) {
          return failure("NOT_FOUND", "配对令牌不存在");
        }
        if (textOf(pairing, "employee_id") !== actor.employeeId || textOf(pairing, "org_id") !== actor.orgId) {
          return failure("FORBIDDEN", "配对令牌不属于当前员工");
        }
        if (numberOf(pairing, "consumed") === 1) {
          return failure("CONFLICT", "配对令牌已使用");
        }
        const expiresAt = numberOf(pairing, "expires_at");
        if (expiresAt === undefined || expiresAt <= config.now()) {
          return failure("FORBIDDEN", "配对令牌已过期");
        }
        const channel = textOf(pairing, "channel");
        const channelTenantId = textOf(pairing, "channel_tenant_id");
        const appId = textOf(pairing, "app_id");
        if (channel === undefined || !isChannel(channel) || channelTenantId === undefined || appId === undefined) {
          return failure("CONFIG_INVALID", "配对记录损坏");
        }
        const clash = rowOf(
          db
            .prepare(
              `SELECT binding_id, employee_id FROM identity_bindings
               WHERE channel = ? AND channel_tenant_id = ? AND app_id = ? AND external_user_id = ? AND status = 'active'`,
            )
            .get(channel, channelTenantId, appId, input.externalUserId),
        );
        if (clash !== undefined && textOf(clash, "employee_id") !== actor.employeeId) {
          return failure("CONFLICT", "外部身份已绑定其他员工");
        }
        db.prepare("UPDATE channel_pairings SET consumed = 1 WHERE pairing_token = ?").run(input.pairingToken);
        if (clash !== undefined && textOf(clash, "employee_id") === actor.employeeId) {
          const existingId = textOf(clash, "binding_id");
          const row = existingId === undefined
            ? undefined
            : rowOf(db.prepare("SELECT * FROM identity_bindings WHERE binding_id = ?").get(existingId));
          const view = row === undefined ? undefined : bindingView(row);
          if (view === undefined) {
            return failure("CONFIG_INVALID", "绑定记录损坏");
          }
          return { ok: true as const, binding: view };
        }
        const bindingId = randomUUID();
        db.prepare(
          `INSERT INTO identity_bindings (
            binding_id, org_id, employee_id, channel, channel_tenant_id, app_id, external_user_id, revision, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?)`,
        ).run(
          bindingId,
          actor.orgId,
          actor.employeeId,
          channel,
          channelTenantId,
          appId,
          input.externalUserId,
          config.now(),
        );
        audit(actor.orgId, actor.employeeId, "channel_pair_complete", bindingId);
        platformLog(config.dataDir, "info", "channel_bound", "IM 身份已配对", {
          channel,
          bindingId,
          employeeId: actor.employeeId,
        });
        return {
          ok: true as const,
          binding: {
            bindingId,
            channel,
            channelTenantId,
            appId,
            externalUserId: input.externalUserId,
            revision: 1,
            status: "active" as const,
          },
        };
      });
    },

    revokeBinding(actor, bindingId) {
      if (!idOk(bindingId)) {
        return failure("CONFIG_INVALID", "绑定标识不符合限制");
      }
      return withTx(db, () => {
        const row = rowOf(db.prepare("SELECT * FROM identity_bindings WHERE binding_id = ?").get(bindingId));
        if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
          return failure("NOT_FOUND", "绑定不存在");
        }
        if (textOf(row, "status") === "revoked") {
          return { ok: true as const };
        }
        const nextRevision = (numberOf(row, "revision") ?? 1) + 1;
        db.prepare("UPDATE identity_bindings SET status = 'revoked', revision = ? WHERE binding_id = ?").run(
          nextRevision,
          bindingId,
        );
        db.prepare(
          "UPDATE conversation_bindings SET status = 'revoked', binding_revision = ? WHERE binding_id = ? AND status = 'active'",
        ).run(nextRevision, bindingId);
        db.prepare(
          `UPDATE relay_commands SET status = 'rejected'
           WHERE binding_id = ? AND status IN ('pending', 'delivery_unknown')`,
        ).run(bindingId);
        db.prepare(
          `UPDATE outbound_deliveries SET status = 'blocked'
           WHERE employee_id = ? AND status = 'pending'
             AND command_id IN (SELECT command_id FROM relay_commands WHERE binding_id = ?)`,
        ).run(actor.employeeId, bindingId);
        audit(actor.orgId, actor.employeeId, "channel_unbind", bindingId);
        platformLog(config.dataDir, "warn", "channel_unbound", "IM 绑定已撤销，新输入与待投递已阻断", {
          bindingId,
          employeeId: actor.employeeId,
        });
        return { ok: true as const };
      });
    },

    listBindings(actor) {
      const rows = db
        .prepare("SELECT * FROM identity_bindings WHERE employee_id = ? ORDER BY created_at")
        .all(actor.employeeId);
      const bindings: BindingView[] = [];
      for (const item of rows) {
        const row = rowOf(item);
        const view = row === undefined ? undefined : bindingView(row);
        if (view !== undefined) {
          bindings.push(view);
        }
      }
      return { ok: true, bindings };
    },

    registerDevice(actor, input) {
      if (!idOk(input.deviceId)) {
        return failure("CONFIG_INVALID", "设备标识不符合限制");
      }
      const existing = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(input.deviceId));
      if (existing !== undefined) {
        if (textOf(existing, "employee_id") !== actor.employeeId) {
          return failure("FORBIDDEN", "设备已属于其他员工");
        }
        db.prepare("UPDATE device_endpoints SET session_id = ?, last_seen_at = ? WHERE device_id = ?").run(
          actor.sessionId,
          config.now(),
          input.deviceId,
        );
        const refreshed = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(input.deviceId));
        const view = refreshed === undefined ? undefined : deviceView(refreshed);
        if (view === undefined) {
          return failure("CONFIG_INVALID", "设备记录损坏");
        }
        return { ok: true, device: view };
      }
      db.prepare(
        `INSERT INTO device_endpoints (
          device_id, org_id, employee_id, session_id, remote_enabled, online, connection_generation, last_seen_at
        ) VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
      ).run(input.deviceId, actor.orgId, actor.employeeId, actor.sessionId, config.now());
      audit(actor.orgId, actor.employeeId, "device_register", input.deviceId);
      return {
        ok: true,
        device: { deviceId: input.deviceId, remoteEnabled: false, online: false, connectionGeneration: 0 },
      };
    },

    setRemoteEnabled(actor, input) {
      if (!idOk(input.deviceId)) {
        return failure("CONFIG_INVALID", "设备标识不符合限制");
      }
      const row = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(input.deviceId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "设备不存在");
      }
      db.prepare("UPDATE device_endpoints SET remote_enabled = ?, last_seen_at = ? WHERE device_id = ?").run(
        input.enabled ? 1 : 0,
        config.now(),
        input.deviceId,
      );
      if (!input.enabled) {
        db.prepare("UPDATE device_endpoints SET online = 0 WHERE device_id = ?").run(input.deviceId);
      }
      const refreshed = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(input.deviceId));
      const view = refreshed === undefined ? undefined : deviceView(refreshed);
      if (view === undefined) {
        return failure("CONFIG_INVALID", "设备记录损坏");
      }
      audit(actor.orgId, actor.employeeId, input.enabled ? "remote_on" : "remote_off", input.deviceId);
      return { ok: true, device: view };
    },

    connectDevice(actor, deviceId) {
      if (!idOk(deviceId)) {
        return failure("CONFIG_INVALID", "设备标识不符合限制");
      }
      const row = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(deviceId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "设备不存在");
      }
      if (numberOf(row, "remote_enabled") !== 1) {
        return failure("FORBIDDEN", "远程对话未开启");
      }
      const generation = (numberOf(row, "connection_generation") ?? 0) + 1;
      db.prepare(
        "UPDATE device_endpoints SET online = 1, connection_generation = ?, session_id = ?, last_seen_at = ? WHERE device_id = ?",
      ).run(generation, actor.sessionId, config.now(), deviceId);
      platformLog(config.dataDir, "info", "device_connected", "PC 远程连接已建立", {
        deviceId,
        connectionGeneration: generation,
        employeeId: actor.employeeId,
      });
      return {
        ok: true,
        device: { deviceId, remoteEnabled: true, online: true, connectionGeneration: generation },
      };
    },

    disconnectDevice(actor, deviceId) {
      if (!idOk(deviceId)) {
        return failure("CONFIG_INVALID", "设备标识不符合限制");
      }
      const row = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(deviceId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "设备不存在");
      }
      db.prepare("UPDATE device_endpoints SET online = 0, last_seen_at = ? WHERE device_id = ?").run(
        config.now(),
        deviceId,
      );
      platformLog(config.dataDir, "warn", "device_offline", "PC 远程连接已断开", {
        deviceId,
        employeeId: actor.employeeId,
      });
      return {
        ok: true,
        device: {
          deviceId,
          remoteEnabled: numberOf(row, "remote_enabled") === 1,
          online: false,
          connectionGeneration: numberOf(row, "connection_generation") ?? 0,
        },
      };
    },

    bindConversation(actor, input) {
      if (!idOk(input.bindingId) || !idOk(input.conversationId) || !idOk(input.deviceId)) {
        return failure("CONFIG_INVALID", "会话绑定参数不符合限制");
      }
      if (input.taskId !== undefined && !idOk(input.taskId)) {
        return failure("CONFIG_INVALID", "任务标识不符合限制");
      }
      const binding = rowOf(db.prepare("SELECT * FROM identity_bindings WHERE binding_id = ?").get(input.bindingId));
      if (binding === undefined || textOf(binding, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "身份绑定不存在");
      }
      if (textOf(binding, "status") !== "active") {
        return failure("FORBIDDEN", "身份绑定已撤销");
      }
      const device = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(input.deviceId));
      if (device === undefined || textOf(device, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "目标设备不存在");
      }
      const channel = textOf(binding, "channel");
      const channelTenantId = textOf(binding, "channel_tenant_id");
      const appId = textOf(binding, "app_id");
      const revision = numberOf(binding, "revision");
      if (channel === undefined || !isChannel(channel) || channelTenantId === undefined || appId === undefined || revision === undefined) {
        return failure("CONFIG_INVALID", "身份绑定损坏");
      }
      const key = conversationKeyOf(channel, channelTenantId, appId, input.conversationId, input.bindingId);
      const outputScope = input.outputScope ?? "summary";
      const allowInput = input.allowInput ?? true;
      const allowControl = input.allowControl ?? true;
      const existing = rowOf(db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(key));
      if (existing !== undefined) {
        db.prepare(
          `UPDATE conversation_bindings
           SET device_id = ?, task_id = COALESCE(?, task_id), output_scope = ?, allow_input = ?, allow_control = ?,
               binding_revision = ?, status = 'active'
           WHERE conversation_key = ?`,
        ).run(
          input.deviceId,
          input.taskId ?? null,
          outputScope,
          allowInput ? 1 : 0,
          allowControl ? 1 : 0,
          revision,
          key,
        );
      } else {
        db.prepare(
          `INSERT INTO conversation_bindings (
            conversation_key, org_id, employee_id, binding_id, channel, channel_tenant_id, app_id,
            conversation_id, device_id, task_id, binding_revision, output_scope, allow_input, allow_control, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        ).run(
          key,
          actor.orgId,
          actor.employeeId,
          input.bindingId,
          channel,
          channelTenantId,
          appId,
          input.conversationId,
          input.deviceId,
          input.taskId ?? null,
          revision,
          outputScope,
          allowInput ? 1 : 0,
          allowControl ? 1 : 0,
          config.now(),
        );
      }
      audit(actor.orgId, actor.employeeId, "conversation_bind", key);
      const refreshed = rowOf(db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(key));
      const view = refreshed === undefined ? undefined : conversationView(refreshed);
      if (view === undefined) {
        return failure("CONFIG_INVALID", "会话绑定损坏");
      }
      return { ok: true, conversation: view };
    },

    linkTask(actor, input) {
      if (input.conversationKey.length === 0 || input.conversationKey.length > 256 || !idOk(input.taskId)) {
        return failure("CONFIG_INVALID", "关联参数不符合限制");
      }
      const row = rowOf(
        db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(input.conversationKey),
      );
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "会话绑定不存在");
      }
      if (textOf(row, "status") !== "active") {
        return failure("FORBIDDEN", "会话绑定已撤销");
      }
      db.prepare("UPDATE conversation_bindings SET task_id = ? WHERE conversation_key = ?").run(
        input.taskId,
        input.conversationKey,
      );
      const refreshed = rowOf(
        db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(input.conversationKey),
      );
      const view = refreshed === undefined ? undefined : conversationView(refreshed);
      if (view === undefined) {
        return failure("CONFIG_INVALID", "会话绑定损坏");
      }
      audit(actor.orgId, actor.employeeId, "conversation_link_task", input.taskId);
      return { ok: true, conversation: view };
    },

    revokeConversation(actor, conversationKey) {
      if (conversationKey.length === 0 || conversationKey.length > 256) {
        return failure("CONFIG_INVALID", "会话键不符合限制");
      }
      const row = rowOf(db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(conversationKey));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "会话绑定不存在");
      }
      db.prepare("UPDATE conversation_bindings SET status = 'revoked' WHERE conversation_key = ?").run(conversationKey);
      db.prepare(
        `UPDATE outbound_deliveries SET status = 'blocked'
         WHERE employee_id = ? AND status = 'pending' AND conversation_id = ?`,
      ).run(actor.employeeId, textOf(row, "conversation_id") ?? "");
      audit(actor.orgId, actor.employeeId, "conversation_revoke", conversationKey);
      return { ok: true };
    },

    receiveChannelEvent(input) {
      if (
        !isChannel(input.channel) ||
        !idOk(input.channelTenantId) ||
        !idOk(input.appId) ||
        !idOk(input.conversationId) ||
        !idOk(input.externalUserId) ||
        !idOk(input.messageId) ||
        input.text.length === 0 ||
        input.text.length > 2000
      ) {
        return failure("CONFIG_INVALID", "渠道事件不符合限制");
      }
      const channel: ChannelKind = input.channel;
      const kind = input.kind ?? "ask";
      if (!isKind(kind)) {
        return failure("CONFIG_INVALID", "消息类型不受支持");
      }
      const inboundKey = inboundDedupKey(channel, input.channelTenantId, input.appId, input.messageId);
      return withTx(db, () => {
        const dup = rowOf(db.prepare("SELECT * FROM inbound_messages WHERE inbound_key = ?").get(inboundKey));
        if (dup !== undefined) {
          const existingCommandId = textOf(dup, "command_id");
          platformLog(config.dataDir, "info", "inbound_duplicate", "重复渠道事件已去重", {
            inboundKey,
            channel,
          });
          const ack: ChannelAck = {
            protocolAck: true,
            status: "duplicate",
            message: "重复消息，不新建执行",
            inboundKey,
          };
          if (existingCommandId !== undefined) {
            ack.commandId = existingCommandId;
          }
          return { ok: true as const, ack };
        }
        const binding = rowOf(
          db
            .prepare(
              `SELECT * FROM identity_bindings
               WHERE channel = ? AND channel_tenant_id = ? AND app_id = ? AND external_user_id = ? AND status = 'active'`,
            )
            .get(channel, input.channelTenantId, input.appId, input.externalUserId),
        );
        if (binding === undefined) {
          db.prepare(
            `INSERT INTO inbound_messages (
              inbound_key, org_id, channel, message_id, conversation_id, external_user_id, text, command_id, created_at
            ) VALUES (?, '', ?, ?, ?, ?, ?, NULL, ?)`,
          ).run(
            inboundKey,
            channel,
            input.messageId,
            input.conversationId,
            input.externalUserId,
            input.text,
            config.now(),
          );
          return {
            ok: true as const,
            ack: {
              protocolAck: true as const,
              status: "rejected" as const,
              message: "未绑定或已撤销，拒绝新输入",
              inboundKey,
            },
          };
        }
        const orgId = textOf(binding, "org_id");
        const employeeId = textOf(binding, "employee_id");
        const bindingId = textOf(binding, "binding_id");
        const bindingRevision = numberOf(binding, "revision");
        if (orgId === undefined || employeeId === undefined || bindingId === undefined || bindingRevision === undefined) {
          return failure("CONFIG_INVALID", "身份绑定损坏");
        }
        const convKey = conversationKeyOf(
          channel,
          input.channelTenantId,
          input.appId,
          input.conversationId,
          bindingId,
        );
        const conversation = rowOf(
          db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(convKey),
        );
        if (conversation === undefined || textOf(conversation, "status") !== "active") {
          db.prepare(
            `INSERT INTO inbound_messages (
              inbound_key, org_id, channel, message_id, conversation_id, external_user_id, text, command_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          ).run(
            inboundKey,
            orgId,
            input.channel,
            input.messageId,
            input.conversationId,
            input.externalUserId,
            input.text,
            config.now(),
          );
          return {
            ok: true as const,
            ack: {
              protocolAck: true as const,
              status: "rejected" as const,
              message: "会话未在 PC 显式关联",
              inboundKey,
            },
          };
        }
        if (numberOf(conversation, "allow_input") !== 1 && kind !== "status" && kind !== "stop") {
          return {
            ok: true as const,
            ack: {
              protocolAck: true as const,
              status: "rejected" as const,
              message: "当前会话不允许输入",
              inboundKey,
            },
          };
        }
        if (kind === "stop" && numberOf(conversation, "allow_control") !== 1) {
          return {
            ok: true as const,
            ack: {
              protocolAck: true as const,
              status: "rejected" as const,
              message: "当前会话不允许控制",
              inboundKey,
            },
          };
        }
        const deviceId = textOf(conversation, "device_id");
        if (deviceId === undefined) {
          return failure("CONFIG_INVALID", "会话未指定设备");
        }
        const device = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(deviceId));
        if (
          device === undefined ||
          textOf(device, "employee_id") !== employeeId ||
          numberOf(device, "remote_enabled") !== 1 ||
          numberOf(device, "online") !== 1
        ) {
          db.prepare(
            `INSERT INTO inbound_messages (
              inbound_key, org_id, channel, message_id, conversation_id, external_user_id, text, command_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          ).run(
            inboundKey,
            orgId,
            input.channel,
            input.messageId,
            input.conversationId,
            input.externalUserId,
            input.text,
            config.now(),
          );
          platformLog(config.dataDir, "warn", "device_unavailable", "指定电脑当前不可用，不创建待上线执行", {
            deviceId,
            channel: input.channel,
            inboundKey,
          });
          return {
            ok: true as const,
            ack: {
              protocolAck: true as const,
              status: "device_offline" as const,
              message: "指定电脑当前不可用，请上线后重新发送",
              inboundKey,
            },
          };
        }
        const commandId = randomUUID();
        const expiresAt = config.now() + COMMAND_TTL_MS;
        db.prepare(
          `INSERT INTO inbound_messages (
            inbound_key, org_id, channel, message_id, conversation_id, external_user_id, text, command_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          inboundKey,
          orgId,
          input.channel,
          input.messageId,
          input.conversationId,
          input.externalUserId,
          input.text,
          commandId,
          config.now(),
        );
        db.prepare(
          `INSERT INTO relay_commands (
            command_id, org_id, employee_id, inbound_key, binding_id, binding_revision, device_id,
            channel, channel_tenant_id, app_id, conversation_id, kind, text, expires_at, status, task_id, accepted_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)`,
        ).run(
          commandId,
          orgId,
          employeeId,
          inboundKey,
          bindingId,
          bindingRevision,
          deviceId,
          input.channel,
          input.channelTenantId,
          input.appId,
          input.conversationId,
          kind,
          input.text,
          expiresAt,
          textOf(conversation, "task_id") ?? null,
          config.now(),
        );
        platformLog(config.dataDir, "info", "command_queued", "渠道消息已入中继队列", {
          commandId,
          channel: input.channel,
          deviceId,
          kind,
        }, commandId);
        return {
          ok: true as const,
          ack: {
            protocolAck: true as const,
            status: "accepted_by_platform" as const,
            message: "平台已接收，等待 PC 持久化受理",
            commandId,
            inboundKey,
          },
        };
      });
    },

    pollCommands(actor, deviceId) {
      if (!idOk(deviceId)) {
        return failure("CONFIG_INVALID", "设备标识不符合限制");
      }
      const device = rowOf(db.prepare("SELECT * FROM device_endpoints WHERE device_id = ?").get(deviceId));
      if (device === undefined || textOf(device, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "设备不存在");
      }
      if (numberOf(device, "online") !== 1) {
        return failure("FORBIDDEN", "设备未在线");
      }
      const rows = db
        .prepare(
          `SELECT * FROM relay_commands
           WHERE device_id = ? AND employee_id = ? AND status = 'pending'
           ORDER BY created_at ASC`,
        )
        .all(deviceId, actor.employeeId);
      const commands: RelayEnvelope[] = [];
      for (const item of rows) {
        const row = rowOf(item);
        if (row === undefined) {
          continue;
        }
        const expiresAt = numberOf(row, "expires_at");
        const commandId = textOf(row, "command_id");
        if (expiresAt !== undefined && expiresAt <= config.now() && commandId !== undefined) {
          db.prepare("UPDATE relay_commands SET status = 'expired' WHERE command_id = ? AND status = 'pending'").run(
            commandId,
          );
          platformLog(config.dataDir, "warn", "command_expired", "过期信封已拒绝，上线不执行旧指令", {
            commandId,
            deviceId,
          }, commandId);
          continue;
        }
        const parsed = parseRelayEnvelope({
          schemaVersion: 1,
          commandId: textOf(row, "command_id"),
          channel: textOf(row, "channel"),
          channelTenantId: textOf(row, "channel_tenant_id"),
          appId: textOf(row, "app_id"),
          conversationId: textOf(row, "conversation_id"),
          bindingId: textOf(row, "binding_id"),
          bindingRevision: numberOf(row, "binding_revision"),
          deviceId: textOf(row, "device_id"),
          employeeId: textOf(row, "employee_id"),
          kind: textOf(row, "kind"),
          text: textOf(row, "text"),
          expiresAtMs: numberOf(row, "expires_at"),
          inboundKey: textOf(row, "inbound_key"),
        });
        if (parsed.ok) {
          commands.push(parsed.envelope);
        }
      }
      return { ok: true, commands };
    },

    acceptCommand(actor, input) {
      if (!idOk(input.deviceId) || !idOk(input.commandId) || !idOk(input.taskId)) {
        return failure("CONFIG_INVALID", "受理参数不符合限制");
      }
      return withTx(db, () => {
        const row = rowOf(db.prepare("SELECT * FROM relay_commands WHERE command_id = ?").get(input.commandId));
        if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
          return failure("NOT_FOUND", "命令不存在");
        }
        if (textOf(row, "device_id") !== input.deviceId) {
          return failure("FORBIDDEN", "命令不属于该设备");
        }
        const status = textOf(row, "status");
        if (status === "accepted") {
          const view = commandView(row);
          if (view === undefined) {
            return failure("CONFIG_INVALID", "回执损坏");
          }
          return { ok: true as const, receipt: view, replayed: true };
        }
        if (status === "expired" || status === "rejected") {
          return failure("FORBIDDEN", "命令已过期或已拒绝");
        }
        const expiresAt = numberOf(row, "expires_at");
        if (expiresAt !== undefined && expiresAt <= config.now()) {
          db.prepare("UPDATE relay_commands SET status = 'expired' WHERE command_id = ?").run(input.commandId);
          return failure("FORBIDDEN", "命令已过期，不补执行");
        }
        const bindingId = textOf(row, "binding_id");
        const binding = bindingId === undefined
          ? undefined
          : rowOf(db.prepare("SELECT * FROM identity_bindings WHERE binding_id = ?").get(bindingId));
        if (binding === undefined || textOf(binding, "status") !== "active") {
          db.prepare("UPDATE relay_commands SET status = 'rejected' WHERE command_id = ?").run(input.commandId);
          return failure("FORBIDDEN", "绑定已撤销，拒绝受理");
        }
        const expectedRevision = numberOf(row, "binding_revision");
        const currentRevision = numberOf(binding, "revision");
        if (expectedRevision !== currentRevision) {
          db.prepare("UPDATE relay_commands SET status = 'rejected' WHERE command_id = ?").run(input.commandId);
          return failure("CONFLICT", "绑定修订已变更");
        }
        db.prepare(
          "UPDATE relay_commands SET status = 'accepted', task_id = ?, accepted_at = ? WHERE command_id = ?",
        ).run(input.taskId, config.now(), input.commandId);
        audit(actor.orgId, actor.employeeId, "command_accepted", input.commandId);
        platformLog(config.dataDir, "info", "command_accepted", "PC 已持久化受理回执", {
          commandId: input.commandId,
          taskId: input.taskId,
          deviceId: input.deviceId,
        }, input.commandId);
        const refreshed = rowOf(db.prepare("SELECT * FROM relay_commands WHERE command_id = ?").get(input.commandId));
        const view = refreshed === undefined ? undefined : commandView(refreshed);
        if (view === undefined) {
          return failure("CONFIG_INVALID", "回执损坏");
        }
        return { ok: true as const, receipt: view, replayed: false };
      });
    },

    markDeliveryUnknown(actor, commandId) {
      if (!idOk(commandId)) {
        return failure("CONFIG_INVALID", "命令标识不符合限制");
      }
      const row = rowOf(db.prepare("SELECT * FROM relay_commands WHERE command_id = ?").get(commandId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "命令不存在");
      }
      if (textOf(row, "status") === "accepted") {
        const view = commandView(row);
        if (view === undefined) {
          return failure("CONFIG_INVALID", "回执损坏");
        }
        return { ok: true, receipt: view };
      }
      db.prepare(
        "UPDATE relay_commands SET status = 'delivery_unknown' WHERE command_id = ? AND status = 'pending'",
      ).run(commandId);
      platformLog(config.dataDir, "warn", "delivery_unknown", "投递无回执，标记待核实，不换设备重跑", {
        commandId,
      }, commandId);
      const refreshed = rowOf(db.prepare("SELECT * FROM relay_commands WHERE command_id = ?").get(commandId));
      const view = refreshed === undefined ? undefined : commandView(refreshed);
      if (view === undefined) {
        return failure("CONFIG_INVALID", "回执损坏");
      }
      return { ok: true, receipt: view };
    },

    enqueueOutbound(actor, input) {
      if (!idOk(input.commandId) || input.body.length === 0 || input.body.length > 2000) {
        return failure("CONFIG_INVALID", "外发参数不符合限制");
      }
      if (containsAbsolutePathLeak(input.body)) {
        return failure("FORBIDDEN", "本地绝对路径不能作为手机可下载链接外发");
      }
      const command = rowOf(db.prepare("SELECT * FROM relay_commands WHERE command_id = ?").get(input.commandId));
      if (command === undefined || textOf(command, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "命令不存在");
      }
      if (textOf(command, "status") !== "accepted") {
        return failure("FORBIDDEN", "只有已受理命令可以外发结果");
      }
      const channel = textOf(command, "channel");
      const conversationId = textOf(command, "conversation_id");
      const bindingId = textOf(command, "binding_id");
      if (channel === undefined || !isChannel(channel) || conversationId === undefined || bindingId === undefined) {
        return failure("CONFIG_INVALID", "命令记录损坏");
      }
      const convKey = conversationKeyOf(
        channel,
        textOf(command, "channel_tenant_id") ?? "",
        textOf(command, "app_id") ?? "",
        conversationId,
        bindingId,
      );
      const conversation = rowOf(db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(convKey));
      if (conversation === undefined || textOf(conversation, "status") !== "active") {
        return failure("FORBIDDEN", "会话绑定已撤销，阻断待投递结果");
      }
      const scope = textOf(conversation, "output_scope");
      if (scope === "status_only" && input.body.length > 120) {
        return failure("FORBIDDEN", "当前会话只允许状态外发");
      }
      const deliveryId = randomUUID();
      const failMode = input.failMode ?? "none";
      db.prepare(
        `INSERT INTO outbound_deliveries (
          delivery_id, org_id, employee_id, command_id, channel, conversation_id, body, status, attempts, fail_mode, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      ).run(
        deliveryId,
        actor.orgId,
        actor.employeeId,
        input.commandId,
        channel,
        conversationId,
        input.body,
        failMode,
        config.now(),
      );
      return submitOutbound(actor, deliveryId);
    },

    retryOutbound(actor, deliveryId) {
      return submitOutbound(actor, deliveryId);
    },

    getCommand(actor, commandId) {
      if (!idOk(commandId)) {
        return failure("CONFIG_INVALID", "命令标识不符合限制");
      }
      const row = rowOf(db.prepare("SELECT * FROM relay_commands WHERE command_id = ?").get(commandId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "命令不存在");
      }
      const view = commandView(row);
      if (view === undefined) {
        return failure("CONFIG_INVALID", "回执损坏");
      }
      return { ok: true, receipt: view };
    },

    getOutbound(actor, deliveryId) {
      if (!idOk(deliveryId)) {
        return failure("CONFIG_INVALID", "投递标识不符合限制");
      }
      const row = rowOf(db.prepare("SELECT * FROM outbound_deliveries WHERE delivery_id = ?").get(deliveryId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "投递不存在");
      }
      const view = outboundView(row);
      if (view === undefined) {
        return failure("CONFIG_INVALID", "投递记录损坏");
      }
      return { ok: true, delivery: view };
    },

    getConversation(actor, conversationKey) {
      const row = rowOf(db.prepare("SELECT * FROM conversation_bindings WHERE conversation_key = ?").get(conversationKey));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "会话绑定不存在");
      }
      const view = conversationView(row);
      if (view === undefined) {
        return failure("CONFIG_INVALID", "会话绑定损坏");
      }
      return { ok: true, conversation: view };
    },
  };

  function submitOutbound(
    actor: Principal,
    deliveryId: string,
  ): { ok: true; delivery: OutboundDeliveryView } | PlatformFailure {
    if (!idOk(deliveryId)) {
      return failure("CONFIG_INVALID", "投递标识不符合限制");
    }
    return withTx(db, () => {
      const row = rowOf(db.prepare("SELECT * FROM outbound_deliveries WHERE delivery_id = ?").get(deliveryId));
      if (row === undefined || textOf(row, "employee_id") !== actor.employeeId) {
        return failure("NOT_FOUND", "投递不存在");
      }
      const status = textOf(row, "status");
      if (status === "submitted") {
        const view = outboundView(row);
        if (view === undefined) {
          return failure("CONFIG_INVALID", "投递记录损坏");
        }
        return { ok: true as const, delivery: view };
      }
      if (status === "blocked") {
        return failure("FORBIDDEN", "投递已因撤销阻断");
      }
      const attempts = (numberOf(row, "attempts") ?? 0) + 1;
      if (attempts > OUTBOUND_RETRY_MAX) {
        db.prepare("UPDATE outbound_deliveries SET status = 'failed', attempts = ? WHERE delivery_id = ?").run(
          attempts,
          deliveryId,
        );
        platformLog(config.dataDir, "warn", "outbound_failed", "回复重试耗尽，不重新执行任务", {
          deliveryId,
          attempts,
        });
        const failed = rowOf(db.prepare("SELECT * FROM outbound_deliveries WHERE delivery_id = ?").get(deliveryId));
        const view = failed === undefined ? undefined : outboundView(failed);
        if (view === undefined) {
          return failure("CONFIG_INVALID", "投递记录损坏");
        }
        return { ok: true as const, delivery: view };
      }
      const failMode = textOf(row, "fail_mode") ?? "none";
      const shouldFail = failMode === "always" || (failMode === "once" && attempts === 1);
      if (shouldFail) {
        db.prepare("UPDATE outbound_deliveries SET status = 'failed', attempts = ? WHERE delivery_id = ?").run(
          attempts,
          deliveryId,
        );
        platformLog(config.dataDir, "warn", "outbound_retry", "回复提交失败，仅重试回复", {
          deliveryId,
          attempts,
        });
      } else {
        db.prepare("UPDATE outbound_deliveries SET status = 'submitted', attempts = ? WHERE delivery_id = ?").run(
          attempts,
          deliveryId,
        );
        platformLog(config.dataDir, "info", "outbound_submitted", "已回原会话提交回复", {
          deliveryId,
          channel: textOf(row, "channel") ?? "",
          conversationId: textOf(row, "conversation_id") ?? "",
        });
      }
      const refreshed = rowOf(db.prepare("SELECT * FROM outbound_deliveries WHERE delivery_id = ?").get(deliveryId));
      const view = refreshed === undefined ? undefined : outboundView(refreshed);
      if (view === undefined) {
        return failure("CONFIG_INVALID", "投递记录损坏");
      }
      return { ok: true as const, delivery: view };
    });
  }
}

/** IM 中继信封。办公平台原始字段不进这里；这是平台内部契约。 */

export type ChannelKind = "feishu" | "wecom";

export type RelayCommandKind = "ask" | "follow_up" | "status" | "stop";

export type RelayEnvelope = {
  schemaVersion: 1;
  commandId: string;
  channel: ChannelKind;
  channelTenantId: string;
  appId: string;
  conversationId: string;
  bindingId: string;
  bindingRevision: number;
  deviceId: string;
  employeeId: string;
  kind: RelayCommandKind;
  text: string;
  expiresAtMs: number;
  inboundKey: string;
};

export type RelayParseResult =
  | { ok: true; envelope: RelayEnvelope }
  | { ok: false; code: "SCHEMA_INVALID"; message: string };

const idPattern = /^[A-Za-z0-9._:-]{1,64}$/;

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isChannel(value: unknown): value is ChannelKind {
  return value === "feishu" || value === "wecom";
}

function isKind(value: unknown): value is RelayCommandKind {
  return value === "ask" || value === "follow_up" || value === "status" || value === "stop";
}

/** 校验中继信封；过期由调用方用当前时钟判断。 */
export function parseRelayEnvelope(input: unknown): RelayParseResult {
  if (!isRecord(input)) {
    return { ok: false, code: "SCHEMA_INVALID", message: "信封不是对象" };
  }
  if (input.schemaVersion !== 1) {
    return { ok: false, code: "SCHEMA_INVALID", message: "信封版本不受支持" };
  }
  const commandId = input.commandId;
  const channel = input.channel;
  const channelTenantId = input.channelTenantId;
  const appId = input.appId;
  const conversationId = input.conversationId;
  const bindingId = input.bindingId;
  const bindingRevision = input.bindingRevision;
  const deviceId = input.deviceId;
  const employeeId = input.employeeId;
  const kind = input.kind;
  const text = input.text;
  const expiresAtMs = input.expiresAtMs;
  const inboundKey = input.inboundKey;
  if (
    typeof commandId !== "string" ||
    !idPattern.test(commandId) ||
    !isChannel(channel) ||
    typeof channelTenantId !== "string" ||
    !idPattern.test(channelTenantId) ||
    typeof appId !== "string" ||
    !idPattern.test(appId) ||
    typeof conversationId !== "string" ||
    !idPattern.test(conversationId) ||
    typeof bindingId !== "string" ||
    !idPattern.test(bindingId) ||
    typeof bindingRevision !== "number" ||
    !Number.isInteger(bindingRevision) ||
    bindingRevision < 1 ||
    typeof deviceId !== "string" ||
    !idPattern.test(deviceId) ||
    typeof employeeId !== "string" ||
    !idPattern.test(employeeId) ||
    !isKind(kind) ||
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > 2000 ||
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs) ||
    typeof inboundKey !== "string" ||
    !idPattern.test(inboundKey)
  ) {
    return { ok: false, code: "SCHEMA_INVALID", message: "信封字段不符合限制" };
  }
  return {
    ok: true,
    envelope: {
      schemaVersion: 1,
      commandId,
      channel,
      channelTenantId,
      appId,
      conversationId,
      bindingId,
      bindingRevision,
      deviceId,
      employeeId,
      kind,
      text,
      expiresAtMs,
      inboundKey,
    },
  };
}

/** 入站去重键：渠道 + 租户 + 应用 + 原消息标识。 */
export function inboundDedupKey(
  channel: ChannelKind,
  channelTenantId: string,
  appId: string,
  messageId: string,
): string {
  return `${channel}:${channelTenantId}:${appId}:${messageId}`;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogService =
  | "cpclaw-dev-host"
  | "cpclaw-lifecycle"
  | "cpclaw-desktop-host"
  | "cpclaw-desktop-worker"
  | "cpclaw-desktop-ui"
  | "cpclaw-harness-adapter"
  | "cpclaw-model-gateway"
  | "cpclaw-platform"
  | "cpclaw-verification";

export type LogEvent = {
  timestamp: string;
  level: LogLevel;
  service: LogService;
  event: string;
  message: string;
  requestId?: string;
  fields?: Record<string, string | number | boolean>;
};

export type LogEventResult =
  | { ok: true; event: LogEvent }
  | { ok: false; message: string };

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const eventPattern = /^[a-z0-9_]{1,64}$/;
const requestIdPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const fieldKeyPattern = /^[a-zA-Z][a-zA-Z0-9]{0,32}$/;

function isLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function isService(value: string): value is LogService {
  return (
    value === "cpclaw-dev-host" ||
    value === "cpclaw-lifecycle" ||
    value === "cpclaw-desktop-host" ||
    value === "cpclaw-desktop-worker" ||
    value === "cpclaw-desktop-ui" ||
    value === "cpclaw-harness-adapter" ||
    value === "cpclaw-model-gateway" ||
    value === "cpclaw-platform" ||
    value === "cpclaw-verification"
  );
}

function fieldValueOk(value: string | number | boolean): boolean {
  if (typeof value === "string") {
    return value.length <= 200 && !value.includes("\0");
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "boolean";
}

export function createLogEvent(input: {
  timestamp: string;
  level: string;
  service: string;
  event: string;
  message: string;
  requestId?: string;
  fields?: Record<string, string | number | boolean>;
}): LogEventResult {
  if (!timestampPattern.test(input.timestamp)) {
    return { ok: false, message: "日志时间必须是 UTC ISO-8601" };
  }
  if (!isLevel(input.level)) {
    return { ok: false, message: "日志级别不在白名单" };
  }
  if (!isService(input.service)) {
    return { ok: false, message: "日志服务名不在白名单" };
  }
  if (!eventPattern.test(input.event)) {
    return { ok: false, message: "日志事件名只允许小写字母、数字和下划线" };
  }
  if (input.message.length === 0 || input.message.length > 500) {
    return { ok: false, message: "日志消息长度必须在 1 到 500" };
  }

  const event: LogEvent = {
    timestamp: input.timestamp,
    level: input.level,
    service: input.service,
    event: input.event,
    message: input.message,
  };

  if (input.requestId !== undefined) {
    if (!requestIdPattern.test(input.requestId)) {
      return { ok: false, message: "requestId 格式不符合限制" };
    }
    event.requestId = input.requestId;
  }

  if (input.fields !== undefined) {
    const keys = Object.keys(input.fields);
    if (keys.length > 12) {
      return { ok: false, message: "日志字段超过 12 个" };
    }
    const fields: Record<string, string | number | boolean> = {};
    for (const key of keys) {
      if (!fieldKeyPattern.test(key)) {
        return { ok: false, message: `日志字段名不允许：${key}` };
      }
      const value = input.fields[key];
      if (value === undefined || !fieldValueOk(value)) {
        return { ok: false, message: `日志字段值不允许：${key}` };
      }
      fields[key] = value;
    }
    event.fields = fields;
  }

  return { ok: true, event };
}

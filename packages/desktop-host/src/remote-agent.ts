import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChannelKind, RelayEnvelope } from "@cpclaw/contracts";
import { hostLog } from "./host-log.js";
import type { LocalWorkspace } from "./workspace.js";

const SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  inbound_key TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  accepted_at TEXT NOT NULL
) STRICT;
`;

export type RemoteAgentFailure = {
  ok: false;
  code: "SCHEMA_INVALID" | "NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "EXPIRED" | "FORBIDDEN";
  message: string;
};

export type RemoteReceipt = {
  commandId: string;
  channel: ChannelKind;
  taskId: string;
  runId: string | null;
  inboundKey: string;
  text: string;
  kind: string;
  acceptedAt: string;
  replayed: boolean;
};

function fail(code: RemoteAgentFailure["code"], message: string): RemoteAgentFailure {
  return { ok: false, code, message };
}

function isId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

/**
 * PC 远程会话代理：持久化 commandId 回执，并把 IM 输入送进同一宿主队列。
 * 不调度 Harness，也不代替工作区成为任务权威来源。
 */
export class RemoteSessionAgent {
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  private readonly workspace: LocalWorkspace;
  private closed = false;

  private constructor(dataDir: string, workspace: LocalWorkspace) {
    this.dataDir = dataDir;
    this.workspace = workspace;
    this.db = new DatabaseSync(join(dataDir, "remote-agent.sqlite"));
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.ensureSchema();
  }

  static open(dataDir: string, workspace: LocalWorkspace): RemoteSessionAgent {
    if (!isAbsolute(dataDir)) {
      throw new Error("数据目录必须是绝对路径");
    }
    mkdirSync(dataDir, { recursive: true });
    return new RemoteSessionAgent(dataDir, workspace);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  /**
   * 受理中继信封：同一 commandId 只创建一次输入；重复投递返回原回执。
   */
  acceptEnvelope(
    envelope: RelayEnvelope,
    input: { taskId: string; runId?: string; nowMs: number },
  ): { ok: true; receipt: RemoteReceipt } | RemoteAgentFailure {
    if (!isId(input.taskId) || (input.runId !== undefined && !isId(input.runId))) {
      return fail("SCHEMA_INVALID", "任务标识不符合限制");
    }
    if (envelope.expiresAtMs <= input.nowMs) {
      return fail("EXPIRED", "信封已过期，不补执行");
    }
    if (envelope.employeeId.length === 0) {
      return fail("FORBIDDEN", "信封缺少员工");
    }

    const existing = this.db.prepare("SELECT * FROM command_receipts WHERE command_id = ?").get(envelope.commandId);
    if (existing !== undefined) {
      const receipt = this.readReceiptRow(existing, true);
      if (receipt === undefined) {
        return fail("SCHEMA_INVALID", "回执损坏");
      }
      hostLog(this.dataDir, "info", "remote_replay", "重复 commandId 返回原回执", {
        commandId: envelope.commandId,
        taskId: receipt.taskId,
      });
      return { ok: true, receipt };
    }

    const queued = this.workspace.enqueueInput(input.taskId, envelope.text, {
      source: envelope.channel,
      commandId: envelope.commandId,
    });
    if (!queued.ok) {
      return fail(queued.code === "NOT_FOUND" ? "NOT_FOUND" : "FORBIDDEN", queued.message);
    }

    const acceptedAt = new Date(input.nowMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO command_receipts (
          command_id, channel, task_id, run_id, inbound_key, text, kind, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.commandId,
        envelope.channel,
        input.taskId,
        input.runId ?? null,
        envelope.inboundKey,
        envelope.text,
        envelope.kind,
        acceptedAt,
      );
    hostLog(this.dataDir, "info", "remote_accepted", "PC 已持久化受理并入队", {
      commandId: envelope.commandId,
      taskId: input.taskId,
      channel: envelope.channel,
      inputSeq: queued.seq,
    });
    return {
      ok: true,
      receipt: {
        commandId: envelope.commandId,
        channel: envelope.channel,
        taskId: input.taskId,
        runId: input.runId ?? null,
        inboundKey: envelope.inboundKey,
        text: envelope.text,
        kind: envelope.kind,
        acceptedAt,
        replayed: false,
      },
    };
  }

  readReceipt(commandId: string): { ok: true; receipt: RemoteReceipt } | RemoteAgentFailure {
    if (!isId(commandId)) {
      return fail("SCHEMA_INVALID", "命令标识不符合限制");
    }
    const row = this.db.prepare("SELECT * FROM command_receipts WHERE command_id = ?").get(commandId);
    if (row === undefined) {
      return fail("NOT_FOUND", "回执不存在");
    }
    const receipt = this.readReceiptRow(row, false);
    if (receipt === undefined) {
      return fail("SCHEMA_INVALID", "回执损坏");
    }
    return { ok: true, receipt };
  }

  private readReceiptRow(row: unknown, replayed: boolean): RemoteReceipt | undefined {
    if (typeof row !== "object" || row === null) {
      return undefined;
    }
    const record = row as Record<string, unknown>;
    const commandId = record.command_id;
    const channel = record.channel;
    const taskId = record.task_id;
    const runId = record.run_id;
    const inboundKey = record.inbound_key;
    const text = record.text;
    const kind = record.kind;
    const acceptedAt = record.accepted_at;
    if (
      typeof commandId !== "string" ||
      (channel !== "feishu" && channel !== "wecom") ||
      typeof taskId !== "string" ||
      typeof inboundKey !== "string" ||
      typeof text !== "string" ||
      typeof kind !== "string" ||
      typeof acceptedAt !== "string"
    ) {
      return undefined;
    }
    return {
      commandId,
      channel,
      taskId,
      runId: typeof runId === "string" ? runId : null,
      inboundKey,
      text,
      kind,
      acceptedAt,
      replayed,
    };
  }

  private ensureSchema(): void {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (table === undefined) {
      this.db.exec(SCHEMA);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', '1')").run();
      return;
    }
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (
      typeof version !== "object" ||
      version === null ||
      !("value" in version) ||
      (version as { value: unknown }).value !== "1"
    ) {
      throw new Error("远程代理数据库版本无法识别");
    }
  }
}

export function openRemoteSessionAgent(dataDir: string, workspace: LocalWorkspace): RemoteSessionAgent {
  return RemoteSessionAgent.open(dataDir, workspace);
}

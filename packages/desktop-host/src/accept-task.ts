import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAcceptTaskCommand, type AcceptTaskResult, type TaskReceipt } from "@cpclaw/contracts";

type StoredTask = {
  idempotencyKey: string;
  digest: string;
  receipt: TaskReceipt;
};

type StoreFile = {
  tasks: StoredTask[];
};

function digestPayload(taskId: string, expectedTaskRevisionId: string): string {
  return createHash("sha256").update(`${taskId}\n${expectedTaskRevisionId}`).digest("hex");
}

function isStoredTask(value: unknown): value is StoredTask {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const receipt = Reflect.get(value, "receipt");
  return (
    typeof Reflect.get(value, "idempotencyKey") === "string" &&
    typeof Reflect.get(value, "digest") === "string" &&
    typeof receipt === "object" &&
    receipt !== null &&
    typeof Reflect.get(receipt, "runId") === "string"
  );
}

function readStore(filePath: string): StoreFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    const tasks = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "tasks") : undefined;
    if (!Array.isArray(tasks)) {
      return { tasks: [] };
    }
    return { tasks: tasks.filter(isStoredTask) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { tasks: [] };
    }
    throw error;
  }
}

function writeStore(filePath: string, store: StoreFile): void {
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store)}\n`, "utf8");
  renameSync(temporary, filePath);
}

export function acceptTask(
  dataDir: string,
  input: unknown,
  ids: { runId: string },
): AcceptTaskResult {
  const parsed = parseAcceptTaskCommand(input);
  if (!parsed.ok) {
    return parsed;
  }
  mkdirSync(dataDir, { recursive: true });
  const filePath = join(dataDir, "tasks.json");
  const store = readStore(filePath);
  const digest = digestPayload(parsed.command.payload.taskId, parsed.command.payload.expectedTaskRevisionId);
  const existing = store.tasks.find((task) => task.idempotencyKey === parsed.command.idempotencyKey);
  if (existing !== undefined) {
    if (existing.digest !== digest) {
      return {
        ok: false,
        code: "IDEMPOTENCY_CONFLICT",
        message: "同一幂等键对应了不同任务内容",
        requestId: parsed.command.requestId,
      };
    }
    return { ok: true, receipt: { ...existing.receipt, replayed: true } };
  }
  const receipt: TaskReceipt = {
    taskId: parsed.command.payload.taskId,
    runId: ids.runId,
    taskRevisionId: parsed.command.payload.expectedTaskRevisionId,
    status: "queued",
    replayed: false,
  };
  store.tasks.push({ idempotencyKey: parsed.command.idempotencyKey, digest, receipt });
  writeStore(filePath, store);
  return { ok: true, receipt };
}

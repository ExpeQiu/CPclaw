import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

const idPattern = "^[A-Za-z0-9._:-]{1,64}$";

export const acceptTaskSchema = {
  $id: "https://cpclaw.local/schemas/accept-task.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "requestId", "idempotencyKey", "payload"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    requestId: { type: "string", pattern: idPattern },
    idempotencyKey: { type: "string", pattern: idPattern },
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["taskId", "expectedTaskRevisionId"],
      properties: {
        taskId: { type: "string", pattern: idPattern },
        expectedTaskRevisionId: { type: "string", pattern: idPattern },
      },
    },
  },
} as const;

export type AcceptTaskCommand = {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  payload: {
    taskId: string;
    expectedTaskRevisionId: string;
  };
};

export type TaskReceipt = {
  taskId: string;
  runId: string;
  taskRevisionId: string;
  status: "queued";
  replayed: boolean;
};

export type AcceptTaskResult =
  | { ok: true; receipt: TaskReceipt }
  | { ok: false; code: "SCHEMA_INVALID" | "IDEMPOTENCY_CONFLICT"; message: string; requestId: string };

export type ParseCommandResult =
  | { ok: true; command: AcceptTaskCommand }
  | { ok: false; code: "SCHEMA_INVALID"; message: string; requestId: string };

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  removeAdditional: false,
  useDefaults: false,
  coerceTypes: false,
});

const validate: ValidateFunction = ajv.compile(acceptTaskSchema);

function schemaMessage(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return "命令不符合 schema";
  }
  return errors
    .slice(0, 5)
    .map((error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? "invalid"}`)
    .join("; ");
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function parseAcceptTaskCommand(input: unknown): ParseCommandResult {
  if (!validate(input) || !isRecord(input) || !isRecord(input.payload)) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      message: schemaMessage(validate.errors),
      requestId: isRecord(input) && typeof input.requestId === "string" ? input.requestId : "unknown",
    };
  }
  const taskId = input.payload.taskId;
  const expectedTaskRevisionId = input.payload.expectedTaskRevisionId;
  if (
    input.schemaVersion !== 1 ||
    typeof input.requestId !== "string" ||
    typeof input.idempotencyKey !== "string" ||
    typeof taskId !== "string" ||
    typeof expectedTaskRevisionId !== "string"
  ) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      message: "命令字段与已声明形状不一致",
      requestId: typeof input.requestId === "string" ? input.requestId : "unknown",
    };
  }
  return {
    ok: true,
    command: {
      schemaVersion: 1,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      payload: { taskId, expectedTaskRevisionId },
    },
  };
}

export type TaskMode = "ask" | "plan" | "execute";

export function parseTaskMode(input: unknown): TaskMode | undefined {
  if (input === "ask" || input === "plan" || input === "execute") {
    return input;
  }
  return undefined;
}

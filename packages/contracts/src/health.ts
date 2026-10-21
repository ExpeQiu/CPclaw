import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

/** 健康报告只表示进程能应答。它不表示业务任务成功。 */
export const healthReportSchema = {
  $id: "https://cpclaw.local/schemas/health-report.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "status", "service", "mode", "aiMockMode", "runtime"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    status: { type: "string", enum: ["ok"] },
    service: { type: "string", enum: ["cpclaw-dev-host"] },
    mode: { type: "string", enum: ["mock"] },
    aiMockMode: { type: "boolean", enum: [true] },
    runtime: {
      type: "object",
      additionalProperties: false,
      required: ["node", "platform", "arch"],
      properties: {
        node: { type: "string", pattern: "^v22\\.\\d+\\.\\d+$" },
        platform: { type: "string", enum: ["darwin"] },
        arch: { type: "string", enum: ["arm64"] },
      },
    },
  },
} as const;

export type HealthReport = {
  schemaVersion: 1;
  status: "ok";
  service: "cpclaw-dev-host";
  mode: "mock";
  aiMockMode: true;
  runtime: {
    node: string;
    platform: "darwin";
    arch: "arm64";
  };
};

export type HealthFailureCode = "SCHEMA_INVALID" | "RUNTIME_UNVERIFIED";

export type HealthResult =
  | { ok: true; report: HealthReport }
  | { ok: false; code: HealthFailureCode; message: string };

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  removeAdditional: false,
  useDefaults: false,
  coerceTypes: false,
});

const validateHealth: ValidateFunction = ajv.compile(healthReportSchema);

function schemaMessage(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return "健康报告不符合 schema";
  }
  return errors
    .slice(0, 5)
    .map((error) => {
      const path = error.instancePath === "" ? "/" : error.instancePath;
      const message = error.message ?? "invalid";
      return `${path} ${message}`;
    })
    .join("; ");
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function parseHealthReport(input: unknown): HealthResult {
  if (!validateHealth(input) || !isRecord(input) || !isRecord(input.runtime)) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      message: schemaMessage(validateHealth.errors),
    };
  }
  const node = input.runtime.node;
  const platform = input.runtime.platform;
  const arch = input.runtime.arch;
  if (
    input.schemaVersion !== 1 ||
    input.status !== "ok" ||
    input.service !== "cpclaw-dev-host" ||
    input.mode !== "mock" ||
    input.aiMockMode !== true ||
    typeof node !== "string" ||
    platform !== "darwin" ||
    arch !== "arm64"
  ) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      message: "健康报告字段与已声明形状不一致",
    };
  }
  const report: HealthReport = {
    schemaVersion: 1,
    status: "ok",
    service: "cpclaw-dev-host",
    mode: "mock",
    aiMockMode: true,
    runtime: { node, platform, arch },
  };
  return { ok: true, report };
}

const node22 = /^v22\.\d+\.\d+$/;

export function createHealthReport(runtime: {
  node: string;
  platform: string;
  arch: string;
}): HealthResult {
  if (runtime.platform !== "darwin" || runtime.arch !== "arm64") {
    return {
      ok: false,
      code: "RUNTIME_UNVERIFIED",
      message: "当前增量只在 darwin/arm64 上报告健康",
    };
  }
  if (!node22.test(runtime.node)) {
    return {
      ok: false,
      code: "RUNTIME_UNVERIFIED",
      message: "当前增量只在 Node.js 22 补丁版本上报告健康",
    };
  }
  return parseHealthReport({
    schemaVersion: 1,
    status: "ok",
    service: "cpclaw-dev-host",
    mode: "mock",
    aiMockMode: true,
    runtime: {
      node: runtime.node,
      platform: runtime.platform,
      arch: runtime.arch,
    },
  });
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readCurrentAccountSession } from "./account-session.js";
import { inspectPlatformCompat, inspectSessionCompat, inspectWorkspaceCompat } from "./compat.js";
import { hostLog } from "./host-log.js";
import { openSyncStore } from "./sync.js";

export type DoctorCheckId = "identity" | "model" | "cli_mcp" | "im" | "directory" | "sync";

export type DoctorStatus = "ok" | "warn" | "fail" | "skipped";

export type DoctorCheck = {
  id: DoctorCheckId;
  status: DoctorStatus;
  summary: string;
  suggestion: string;
};

export type DoctorReport = {
  schemaVersion: 1;
  runId: string;
  finishedAt: string;
  autoRepair: false;
  checks: DoctorCheck[];
  versions: {
    app: string;
    node: string;
    platform: string;
    arch: string;
    workspaceSchema?: number;
    platformSchema?: number;
  };
};

export type DiagnosticExtraScope = "sync_meta" | "skill_meta" | "im_binding_ids";

export type DoctorInput = {
  dataDir: string;
  /** 平台进程是否可达。Mock 由调用方注入，诊断本身不发起修复。 */
  platformReachable?: boolean;
  /** 模型密钥是否在环境中出现。只记布尔，不读值。 */
  modelKeyPresent?: boolean;
  /** 已授权的目录绝对路径列表。 */
  grantedDirectories?: readonly string[];
  /** CLI/MCP 是否已选定。未定则 skipped。 */
  connectorConfigured?: boolean;
  /** IM 渠道是否已配对。 */
  imPaired?: boolean;
  appVersion?: string;
};

export type DiagnosticPackResult =
  | { ok: true; fileName: string; bytes: number; sha256: string; includedExtra: DiagnosticExtraScope[] }
  | { ok: false; code: "SCHEMA_INVALID" | "FORBIDDEN"; message: string };

const SENSITIVE = /(Bearer\s+\S+|api[_-]?key|refreshToken|password|secret|\/Users\/[^\s"]+)/gi;

function redact(text: string): string {
  return text.replace(SENSITIVE, "[redacted]").slice(0, 200);
}

function checkIdentity(dataDir: string): DoctorCheck {
  const current = readCurrentAccountSession(dataDir);
  if (!current.ok) {
    const sessionPath = join(dataDir, "accounts", "current.json");
    if (existsSync(sessionPath)) {
      try {
        const raw = JSON.parse(readFileSync(sessionPath, "utf8"));
        const compat = inspectSessionCompat(raw);
        if (!compat.ok && compat.code === "SCHEMA_INCOMPATIBLE") {
          return {
            id: "identity",
            status: "fail",
            summary: redact(compat.message),
            suggestion: "升级客户端或导出后重建会话，不要手工改 schemaVersion",
          };
        }
      } catch {
        // 解析失败走通用失败
      }
    }
    return {
      id: "identity",
      status: "fail",
      summary: redact(current.message),
      suggestion: "重新登录；若会话文件损坏，切换账号或清除本机会话后再登",
    };
  }
  if (current.session === null) {
    return {
      id: "identity",
      status: "warn",
      summary: "当前没有登录会话",
      suggestion: "在设置中登录企业账号后再执行任务",
    };
  }
  return {
    id: "identity",
    status: "ok",
    summary: `已登录 ${current.session.employeeId}`,
    suggestion: "无需操作",
  };
}

function checkModel(input: DoctorInput): DoctorCheck {
  if (input.platformReachable === false) {
    return {
      id: "model",
      status: "fail",
      summary: "平台不可达，无法确认模型网关",
      suggestion: "检查平台进程与网络，勿在诊断里改配置",
    };
  }
  if (input.modelKeyPresent === false) {
    return {
      id: "model",
      status: "warn",
      summary: "未检测到模型密钥（仅布尔）",
      suggestion: "由管理员在受控环境配置密钥；诊断不会写入密钥",
    };
  }
  if (input.modelKeyPresent === true) {
    return {
      id: "model",
      status: "ok",
      summary: "平台可达且密钥已声明存在",
      suggestion: "无需操作",
    };
  }
  return {
    id: "model",
    status: "skipped",
    summary: "未注入模型探测结果",
    suggestion: "联调时传入 platformReachable 与 modelKeyPresent",
  };
}

function checkConnector(input: DoctorInput): DoctorCheck {
  if (input.connectorConfigured === undefined) {
    return {
      id: "cli_mcp",
      status: "skipped",
      summary: "首个 CLI/MCP 尚未选定（P2-04 受阻）",
      suggestion: "选定可验证程序与许可证后再检查",
    };
  }
  if (!input.connectorConfigured) {
    return {
      id: "cli_mcp",
      status: "fail",
      summary: "连接器未配置",
      suggestion: "按管理员清单安装获准 CLI/MCP，诊断不会自动安装",
    };
  }
  return {
    id: "cli_mcp",
    status: "ok",
    summary: "连接器已声明配置",
    suggestion: "无需操作",
  };
}

function checkIm(input: DoctorInput): DoctorCheck {
  if (input.imPaired === undefined) {
    return {
      id: "im",
      status: "skipped",
      summary: "飞书/企微测试应用未确认（Q11）",
      suggestion: "正式渠道联调前保持 Mock；诊断不自动配对",
    };
  }
  if (!input.imPaired) {
    return {
      id: "im",
      status: "warn",
      summary: "当前设备未配对 IM",
      suggestion: "在管理端完成可信配对；离线时不可用",
    };
  }
  return {
    id: "im",
    status: "ok",
    summary: "IM 配对已声明",
    suggestion: "无需操作",
  };
}

function checkDirectory(input: DoctorInput): DoctorCheck {
  const grants = input.grantedDirectories ?? [];
  if (grants.length === 0) {
    return {
      id: "directory",
      status: "warn",
      summary: "没有授权目录",
      suggestion: "新建任务时指定绝对路径授权目录",
    };
  }
  for (const path of grants) {
    if (!isAbsolute(path)) {
      return {
        id: "directory",
        status: "fail",
        summary: "存在非绝对路径授权",
        suggestion: "删除相对路径授权并重新选择绝对目录",
      };
    }
    if (!existsSync(path)) {
      return {
        id: "directory",
        status: "fail",
        summary: "授权目录不存在",
        suggestion: "确认目录仍在本机且未被符号链接替换",
      };
    }
  }
  return {
    id: "directory",
    status: "ok",
    summary: `已检查 ${grants.length} 个授权目录`,
    suggestion: "无需操作",
  };
}

function checkSync(dataDir: string): DoctorCheck {
  const workspace = inspectWorkspaceCompat(dataDir);
  if (!workspace.ok && workspace.code === "SCHEMA_INCOMPATIBLE") {
    return {
      id: "sync",
      status: "fail",
      summary: redact(workspace.message),
      suggestion: "升级客户端后再打开；旧库已保留，勿手工降级解释",
    };
  }
  try {
    const store = openSyncStore(dataDir);
    const cursor = store.readCursor("probe");
    store.close();
    return {
      id: "sync",
      status: "ok",
      summary: `同步库可打开；探测游标 confirmed=${cursor.confirmedSeq}`,
      suggestion: "无需操作",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步库打开失败";
    return {
      id: "sync",
      status: "fail",
      summary: redact(message),
      suggestion: "查看宿主日志；诊断不会清理队列或重跑上传",
    };
  }
}

/** 只读诊断。不改配置、不装软件、不清队列、不重跑任务。 */
export function runDoctor(input: DoctorInput): DoctorReport {
  if (!isAbsolute(input.dataDir)) {
    throw new Error("诊断数据目录必须是绝对路径");
  }
  const checks: DoctorCheck[] = [
    checkIdentity(input.dataDir),
    checkModel(input),
    checkConnector(input),
    checkIm(input),
    checkDirectory(input),
    checkSync(input.dataDir),
  ];
  const workspace = inspectWorkspaceCompat(input.dataDir);
  const platform = inspectPlatformCompat(input.dataDir);
  const report: DoctorReport = {
    schemaVersion: 1,
    runId: `diag-${randomUUID()}`,
    finishedAt: new Date().toISOString(),
    autoRepair: false,
    checks,
    versions: {
      app: input.appVersion ?? "0.0.1",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  if (workspace.ok) {
    report.versions.workspaceSchema = workspace.version;
  }
  if (platform.ok) {
    report.versions.platformSchema = platform.version;
  }
  hostLog(input.dataDir, "info", "doctor_finished", "只读诊断已完成", {
    runId: report.runId,
    failCount: checks.filter((item) => item.status === "fail").length,
  });
  return report;
}

function packContainsForbidden(body: string): boolean {
  return /Bearer\s+\S+|refreshToken|api[_-]?key\s*[:=]|password\s*[:=]/i.test(body);
}

/**
 * 导出脱敏诊断包。默认不含正文/凭证。
 * 额外范围必须显式传入；不会因「一键诊断」自动带上会话正文或记忆。
 */
export function exportDiagnosticPack(
  dataDir: string,
  report: DoctorReport,
  options: { includeExtra: boolean; extraScopes?: readonly DiagnosticExtraScope[] },
): DiagnosticPackResult {
  if (report.autoRepair !== false) {
    return { ok: false, code: "FORBIDDEN", message: "诊断报告不得声明自动修复" };
  }
  const extras = options.includeExtra ? [...(options.extraScopes ?? [])] : [];
  if (!options.includeExtra && (options.extraScopes?.length ?? 0) > 0) {
    return { ok: false, code: "SCHEMA_INVALID", message: "未打开额外诊断包时不能附带额外范围" };
  }
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "diagnostic-pack",
    report: {
      ...report,
      checks: report.checks.map((check) => ({
        ...check,
        summary: redact(check.summary),
        suggestion: redact(check.suggestion),
      })),
    },
    includedExtra: extras,
  };
  if (extras.includes("sync_meta")) {
    const store = openSyncStore(dataDir);
    try {
      payload.syncMeta = { probeCursor: store.readCursor("probe") };
    } finally {
      store.close();
    }
  }
  if (extras.includes("skill_meta")) {
    payload.skillMeta = {
      skillsRootPresent: existsSync(join(dataDir, "skills")),
      note: "只声明安装区是否存在，不导出 Skill 正文",
    };
  }
  if (extras.includes("im_binding_ids")) {
    payload.imMeta = { note: "仅占位：正式 IM 标识不进默认诊断包" };
  }
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (packContainsForbidden(text)) {
    return { ok: false, code: "FORBIDDEN", message: "诊断包含有疑似凭证字段，已拒绝写出" };
  }
  const dir = join(dataDir, "diagnostics");
  mkdirSync(dir, { recursive: true });
  const fileName = `diag-${report.runId}.json`;
  const path = join(dir, fileName);
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  hostLog(dataDir, "info", "diagnostic_pack_exported", "已导出脱敏诊断包", {
    bytes: text.length,
    extras: extras.length,
  });
  return { ok: true, fileName, bytes: text.length, sha256, includedExtra: extras };
}

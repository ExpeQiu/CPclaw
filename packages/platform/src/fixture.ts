export const MODEL_ID = "MiniMax-M3" as const;

export type EmployeeRole = "admin" | "employee";

export type SeedEmployee = {
  orgId: string;
  orgName: string;
  employeeId: string;
  name: string;
  role: EmployeeRole;
  password: string;
  limitTokens: number;
  concurrentLimit: number;
  reserveTokens: number;
};

/** 合成账号只在 AI_MOCK_MODE=true 且 CPCLAW_PLATFORM_SEED=fixture 时写入。不是生产口令。 */
export const fixtureEmployees: readonly SeedEmployee[] = [
  {
    orgId: "org-demo",
    orgName: "示例组织",
    employeeId: "admin",
    name: "管理员",
    role: "admin",
    password: "fixture-admin",
    limitTokens: 1000,
    concurrentLimit: 1,
    reserveTokens: 100,
  },
  {
    orgId: "org-demo",
    orgName: "示例组织",
    employeeId: "employee-a",
    name: "员工甲",
    role: "employee",
    password: "fixture-employee-a",
    limitTokens: 1000,
    concurrentLimit: 1,
    reserveTokens: 100,
  },
  {
    orgId: "org-demo",
    orgName: "示例组织",
    employeeId: "employee-b",
    name: "员工乙",
    role: "employee",
    password: "fixture-employee-b",
    limitTokens: 1000,
    concurrentLimit: 1,
    reserveTokens: 100,
  },
  {
    orgId: "org-other",
    orgName: "另一组织",
    employeeId: "employee-c",
    name: "员工丙",
    role: "employee",
    password: "fixture-employee-c",
    limitTokens: 1000,
    concurrentLimit: 1,
    reserveTokens: 100,
  },
];

const idPattern = /^[a-z][a-z0-9-]{0,31}$/;

function isRole(value: unknown): value is EmployeeRole {
  return value === "admin" || value === "employee";
}

function readEmployee(value: unknown, orgId: string, orgName: string): SeedEmployee | string {
  if (typeof value !== "object" || value === null) {
    return "员工条目必须是对象";
  }
  const employeeId = Reflect.get(value, "employeeId");
  const name = Reflect.get(value, "name");
  const role = Reflect.get(value, "role");
  const password = Reflect.get(value, "password");
  const limitTokens = Reflect.get(value, "limitTokens");
  const concurrentLimit = Reflect.get(value, "concurrentLimit");
  const reserveTokens = Reflect.get(value, "reserveTokens");
  if (typeof employeeId !== "string" || !idPattern.test(employeeId)) {
    return "employeeId 格式不符合限制";
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 40) {
    return "员工姓名长度必须在 1 到 40";
  }
  if (!isRole(role)) {
    return "角色只接受 admin 或 employee";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128 || password.includes("\0")) {
    return "口令长度必须在 8 到 128";
  }
  if (!isBound(limitTokens, 1, 1_000_000) || !isBound(concurrentLimit, 1, 8) || !isBound(reserveTokens, 1, 100_000)) {
    return "额度或并发上限超出允许范围";
  }
  return {
    orgId,
    orgName,
    employeeId,
    name,
    role,
    password,
    limitTokens,
    concurrentLimit,
    reserveTokens,
  };
}

function isBound(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function parseBootstrap(payload: unknown): { ok: true; employees: SeedEmployee[] } | { ok: false; message: string } {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, message: "引导文件必须是 JSON 对象" };
  }
  const orgs = Reflect.get(payload, "orgs");
  if (!Array.isArray(orgs) || orgs.length < 1 || orgs.length > 8) {
    return { ok: false, message: "引导文件需要 1 到 8 个组织" };
  }
  const employees: SeedEmployee[] = [];
  const seen = new Set<string>();
  for (const org of orgs) {
    if (typeof org !== "object" || org === null) {
      return { ok: false, message: "组织条目必须是对象" };
    }
    const orgId = Reflect.get(org, "orgId");
    const orgName = Reflect.get(org, "orgName");
    const members = Reflect.get(org, "employees");
    if (typeof orgId !== "string" || !idPattern.test(orgId)) {
      return { ok: false, message: "orgId 格式不符合限制" };
    }
    if (typeof orgName !== "string" || orgName.length < 1 || orgName.length > 40) {
      return { ok: false, message: "组织名称长度必须在 1 到 40" };
    }
    if (!Array.isArray(members) || members.length < 1 || members.length > 20) {
      return { ok: false, message: "每个组织需要 1 到 20 名员工" };
    }
    for (const member of members) {
      const parsed = readEmployee(member, orgId, orgName);
      if (typeof parsed === "string") {
        return { ok: false, message: parsed };
      }
      if (seen.has(parsed.employeeId)) {
        return { ok: false, message: "employeeId 重复" };
      }
      seen.add(parsed.employeeId);
      employees.push(parsed);
    }
  }
  if (!employees.some((employee) => employee.role === "admin")) {
    return { ok: false, message: "引导文件至少要有一名管理员" };
  }
  return { ok: true, employees };
}

const base = process.argv[2];
if (typeof base !== "string" || !base.startsWith("http://127.0.0.1:")) {
  process.stderr.write("缺少本机平台地址\n");
  process.exit(1);
}

const login = await fetch(`${base}/v1/session/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    employeeId: "employee-a",
    password: "fixture-employee-a",
    deviceLabel: "verify-device",
    actor: "admin",
    role: "admin",
  }),
});
const employee = await login.json();
if (login.status !== 200 || employee.role !== "employee") {
  process.stderr.write("员工登录没有按账号角色返回\n");
  process.exit(1);
}

const adminCall = await fetch(`${base}/v1/admin/employees`, {
  headers: { authorization: `Bearer ${employee.accessToken}` },
});
if (adminCall.status !== 403) {
  process.stderr.write("员工调用了管理接口\n");
  process.exit(1);
}

const adminLogin = await fetch(`${base}/v1/session/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    employeeId: "admin",
    password: "fixture-admin",
    deviceLabel: "verify-admin",
  }),
});
const admin = await adminLogin.json();
if (adminLogin.status !== 200 || admin.role !== "admin") {
  process.stderr.write("管理员登录失败\n");
  process.exit(1);
}

const revoked = await fetch(`${base}/v1/admin/sessions/revoke`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${admin.accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ sessionId: employee.sessionId, actor: employee.employeeId }),
});
if (revoked.status !== 200) {
  process.stderr.write("管理员撤销失败\n");
  process.exit(1);
}

const after = await fetch(`${base}/v1/me/sessions`, {
  headers: { authorization: `Bearer ${employee.accessToken}` },
});
if (after.status !== 401) {
  process.stderr.write("撤销后的令牌仍然可用\n");
  process.exit(1);
}

const provider = await fetch(`${base}/v1/admin/provider`, {
  headers: { authorization: `Bearer ${admin.accessToken}` },
});
const providerBody = await provider.json();
const encoded = JSON.stringify(providerBody);
if (provider.status !== 200 || providerBody.model !== "MiniMax-M3" || encoded.includes("apiKey") || encoded.includes("MINIMAX")) {
  process.stderr.write("模型信息泄露或模型标识不对\n");
  process.exit(1);
}

process.stdout.write("平台登录、撤销和员工隔离检查通过\n");

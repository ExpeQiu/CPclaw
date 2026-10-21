export function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>CPclaw 管理</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; max-width: 40rem; }
    label { display: block; margin: 0.75rem 0; }
    button { margin-right: 0.5rem; }
    li { margin: 0.4rem 0; }
  </style>
</head>
<body>
  <h1>CPclaw 管理</h1>
  <form id="login-form">
    <label>员工编号 <input id="employee-id" name="employeeId" autocomplete="username" required></label>
    <label>口令 <input id="password" name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit" id="login">登录</button>
  </form>
  <p id="session-result"></p>
  <section id="admin-panel" hidden>
    <h2>本组织员工</h2>
    <ul id="employees"></ul>
    <button type="button" id="backup">备份</button>
    <p id="provider"></p>
  </section>
  <script>
    let accessToken = "";
    const result = document.querySelector("#session-result");
    const panel = document.querySelector("#admin-panel");
    const list = document.querySelector("#employees");

    async function api(path, options) {
      const headers = { "content-type": "application/json" };
      if (accessToken) headers.authorization = "Bearer " + accessToken;
      const response = await fetch(path, { ...options, headers });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "请求失败");
      return body;
    }

    document.querySelector("#login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const employeeId = document.querySelector("#employee-id").value;
      const password = document.querySelector("#password").value;
      const response = await fetch("/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employeeId, password, deviceLabel: "admin-page", actor: "admin", role: "admin" })
      });
      const body = await response.json();
      if (!response.ok) {
        result.textContent = body.message;
        panel.hidden = true;
        return;
      }
      accessToken = body.accessToken;
      if (body.role !== "admin") {
        result.textContent = "员工不能调用管理接口";
        panel.hidden = true;
        return;
      }
      result.textContent = "已登录管理员";
      panel.hidden = false;
      await reload();
    });

    async function reload() {
      const employees = await api("/v1/admin/employees");
      const provider = await api("/v1/admin/provider");
      list.replaceChildren();
      for (const employee of employees.employees) {
        const item = document.createElement("li");
        item.textContent = employee.employeeId + " " + employee.name + " " + employee.role + " " + employee.status;
        for (const session of employee.sessions) {
          if (session.status !== "active") continue;
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "撤销 " + session.deviceLabel;
          button.dataset.sessionId = session.sessionId;
          button.addEventListener("click", async () => {
            await api("/v1/admin/sessions/revoke", {
              method: "POST",
              body: JSON.stringify({ sessionId: session.sessionId, actor: "employee-a" })
            });
            result.textContent = "已撤销 " + session.deviceLabel;
            await reload();
          });
          item.append(button);
        }
        list.append(item);
      }
      document.querySelector("#provider").textContent = provider.keyPresent
        ? "模型 " + provider.model + " 密钥已配置"
        : "模型 " + provider.model + " 密钥未配置";
    }

    document.querySelector("#backup").addEventListener("click", async () => {
      const body = await api("/v1/admin/backup", { method: "POST", body: "{}" });
      result.textContent = "已备份 " + body.fileName;
    });
  </script>
</body>
</html>
`;
}

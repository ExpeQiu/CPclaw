# ADR-003 原生页面 Computer Use

状态：已实现；来源：将拓展「原生页面」从只读展示升级为结构化页面操控，并参考 Codex 对登录/支付强制确认。

## 决策

1. 已绑定服务可在右侧原生页容器中打开其**允许源**内的 HTTPS 页面（即梦固定源；MCP 取服务地址 origin；CLI 可选 `pageUrl` / `pageOrigins`）。未绑定服务不得任意冲浪。
2. Harness 通过内置服务 `browser-page` 操作页面：先 `discover`，再 `open` / `snapshot` / 按可访问树 `ref` 执行 `click`、`type`、`scroll`、`press`。不做视觉坐标点击。
3. 页面隔离：独立 `persist:cpclaw-native-<hash>` partition，无 preload、无 Node、无宿主桥。操控走主进程 CDP / `sendInputEvent`。
4. 登录与支付由宿主关键词与控件角色判定；命中则 `forceApproval`，即使对话为「完全访问」也不能静默执行。批准后可将会话 allowlist 临时扩到该登录/支付源，便于同任务内完成授权页。
5. 即梦创作与积分通道仍以 CLI 为主；computer use 不替代 `node quote/confirm`，也不代填支付凭据或验证码。

## 后果

- `guide/拓展应用.md`：纯网页不再永久禁止浏览器操作，改为允许源 + 敏感确认。
- 与 ADR-002 同一批准弹窗与权限版本作废规则；敏感动作不走 `canAutoApprove`。

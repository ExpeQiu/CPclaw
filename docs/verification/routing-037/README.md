# 0.0.37 云端按需路由更新（2026-11-05）

经用户明确批准，更新 `root@47.113.225.93` 的 `/opt/cpclaw-platform/repo/packages/model-gateway/src/document-tool.ts`，使用现有 Docker Compose 重建、重启。仅替换该源码，沿用远程其余代码、私有环境配置、网络策略及数据卷。

备份：`/opt/cpclaw-platform/backups/routing-037-20261105T054340Z`，含旧源码、数据库一致快照和旧镜像 ID。旧镜像标签：`cpclaw-platform:rollback-routing-20261105T054340Z`。

健康检查 `status=ok, mode=real`；容器 `running/healthy`；容器编译产物已包含按需执行约定。远程源码与本地 SHA-256 均为 `16dce39cce19aef265652a5cbb1ce8bb986ca0ac0b6121228a1fbc8e58d22d11`。

真实 MiniMax 网关验证：提供本机终端、即梦、飞书服务目录，activeId 为即梦，并提供先前检查即梦的聊天记录。三个普通追问“deepseek-super-agent 是什么”“飞书 CLI 是什么”“为什么启动自动工作流”均直接输出正文，无服务请求、无文档交付；“请调用飞书 CLI 检查连接”产生一个服务请求，目标为 feishu。测试使用独立验证会话并在结束时注销。不实际执行飞书 CLI；不验证概念答案事实准确性，不代表所有提示下均不会误路由。

结构化结果见 [real-model-result.json](real-model-result.json)。桌面 0.0.37 已在前一步替换安装并启动；本次未再次改动安装包。

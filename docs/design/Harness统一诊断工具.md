# Harness 统一诊断工具

日期：2026-11-06。范围：源码、受控测试；本轮不部署平台、不替换安装版。

## 目标与验收

1. 复用诊断采集及既有修复器，统一暴露 inspect / repair / verify；只读检查不恢复图片、不重装技能、不修改任务活动状态。
2. 指定 requestId 时，仅解析当前账号、当前聊天的助手运行；无记录返回 NOT_FOUND。Harness 调用未指定目标时排除当前正在解释诊断的助手消息。
3. 宿主签发五分钟有效、一次性动作，绑定账号、聊天、请求与执行记录/绑定版本；伪造、跨账号、过期、重复使用、证据变化均拒绝。
4. 修复后读取实际状态；仅原修复器验证通过且重新检查不再提供同项修复时返回 verified。局部恢复不等于原任务完成。
5. UI 提供任务、模型、服务、成果、环境五个范围；使用同一采集器，突出范围内结果，保留完整报告，不为每个入口创建新工具。

## 接口

| UI / RPC | Harness 工具 | 输入 |
| --- | --- | --- |
| diagnostic.inspect | diagnostic_inspect | chatId（工具由宿主注入）、requestId?、scope? |
| diagnostic.repair | diagnostic_repair | chatId、actionId |
| diagnostic.verify | diagnostic_verify | chatId、receiptId |

工具的结果超长时复用现有 read_tool_result 分页。原始执行数据继续由 read_resource(kind=execution) 提供。

当前注册给内核的修复仅 MEDIA_RESUME、SKILL_INSTALL_MISSING。需用户交互的登录、解除技能绑定等保留原手动入口，不向模型签发动作。MEDIA_RESUME 先恢复本机文件，未交付才查询原提交和下载原资源；不触发生成。

inspect 的“只读”指不修改原任务或触发修复；允许刷新平台会话、补充请求诊断证据、写入检查日志与诊断台账。scope 是关注范围，不代表只探测单个子系统。检查不依赖模型可用性；活动运行期间可读取证据，界面仍保留原有禁止并发启动解释的交互。

## 执行与兼容

- 复用同一 Harness 会话解释；解释入口先只读检查，传入原请求与范围。
- repair 只接受宿主动作，不接受任意 code、终端命令或权限参数。维护仍服从账号、聊天、系统和外部服务实际权限。
- 修复回执和检查台账分开记录；新修复调用写入现有经验台账。
- 动作/回执在工作进程内最多各保留100条，重启后失效，需重新检查。执行中断或结果不明不自动重试，先读取原执行记录。
- 历史请求支持检查；图片恢复仍要求目标为最新业务运行（允许当前内核解释消息占位），目标过时会被原修复器拒绝。
- 原 chat.diagnose / chat.diagnoseRepair 作为兼容维护接口保留；chat.diagnose 仍有自动维护行为。界面及解释入口使用新只读接口。
- 桌面打包清单加入 diagnostic-tools.mjs；平台 Harness 工具白名单及模型诊断名称列表同步更新。发布必须同步平台与桌面；旧平台会拒绝新增工具目录。

## 文件与风险

诊断动作生命周期集中在 apps/desktop/diagnostic-tools.mjs；采集与修复复用 chat-service.mjs；目录在 harness-tools.mjs；RPC 在 workspace-worker.mjs；界面在 renderer/diagnostics.js。平台 HTTP 契约和模型日志识别同步维护。

本轮不加入全能修复器、自动代码修改、付费重生成或新的诊断 Agent。真实模型对诊断工具的选择质量、生产部署与安装包仍需分别验收。

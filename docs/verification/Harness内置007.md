# CPclaw 0.0.7：内置 Harness 验收（2026-10-23）

## 范围

DMG 内置已编译 Harness SDK/CLI、配置、插件、运行依赖和许可证。安装模式不依赖外置磁盘中的开发仓库、tsx、系统 Node 或 pnpm。普通聊天链路不变，真实报告仍由既有配置开启。

## 实测

- `pnpm build` 通过；桌面宿主测试 30/30 通过。
- 仓库 `scripts/verify.sh` 退出码 0；该脚本的 Mock 验收不代表真实 MiniMax、OIDC 或正式签名发布通过。
- 包内独立 Node 22.23.3；Harness 0.1.6-alpha.2，来源提交 ddefc45fbc7f8e46dd73185e68295696d1297887。源检出包含本地变动，分发字节以清单 SHA-256 为准。
- 干净环境（系统 PATH，无开发工具）、全新临时 HOME、故意无效的外部 Harness 路径：真实桌面工作进程能启动并返回工作台快照。
- 包内宿主经已编译 SDK 启动包内 CLI；1 次 read_material、2 次模型夹具请求；工具返回的材料进入第二次模型请求；报告正文符合预期；子进程关闭后无残留。
- 遍历包内 Harness 所有符号链接，目标均位于应用 Resources 内。
- 模型夹具仅监听 127.0.0.1，不读取生产凭证、不调用真实 MiniMax。

`verify-bundled-harness.mjs` 已纳入打包入口，在生成 DMG/ZIP 前运行。缺失依赖、工作进程失败、工具未执行、结果错误或子进程残留均阻止打包。

## 限制

仅 macOS Apple Silicon 验证；采用 ad-hoc 签名，未做 Developer ID 签名或 Apple 公证。本次不替换本机已有安装，不改变默认报告模式，不将普通聊天迁移到 Harness。

## 分发介质

DMG 只读挂载后，再次通过包内工作进程、材料工具与模型续答验收。镜像 CRC 校验通过，交付目录中的 DMG/ZIP 与构建文件 SHA-256 一致。

DMG SHA-256：`d593ffbc01ca98b2e1c6b8e5cb209cc48f965c056a1a0a899afeed820332ddd6`。

## 真实云端模型补充验收

使用 0.0.7 App 包内 Node、workspace-client、workspace-worker、SDK/CLI，通过既有云端平台调用真实 MiniMax-M3。设置报告引擎为 harness，全部本地数据使用新建临时目录；只发送随机编号和三段合成材料。

结果：passed=true，1 次 read_material、2 次真实模型请求，子进程关闭后无残留。报告含随机项目编号和 project-note.md#p1/p2/p3 三处来源；审阅前无报告文件，接受变更后才落盘；本地计数与实际模型请求数一致。

证据：`harness-packaged-real-007.json`。本次验证的是包内报告链路，不代表普通聊天已迁移到 Harness，也未替换本机安装。

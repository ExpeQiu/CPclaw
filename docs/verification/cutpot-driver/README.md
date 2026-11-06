# CutPot 接入 CPclaw 本机验证

日期：2026-11-05。范围：源码态 Electron + 真实 CutPot 服务/CLI；隔离测试账号、独立数据目录。没有向安装版写入连接，没有付费生成，没有调用真实模型。

## 实现

- 驱动应用支持可选本机 HTTP 工作台地址，持久保存允许源；相同文件夹可更新地址而不重复注册。
- 添加时填写地址后选择 CutPot 文件夹；服务需先由用户或获授权的执行任务启动。地址可用 `http://127.0.0.1:4317/editor`，实际端口以服务启动结果为准。
- 驱动应用有页面时默认显示原生页面，可切换驱动面板；原有 CLI 三方应用的默认显示方式保持不变。
- 修复 workspace-worker 未转发 extensions.* 的问题，真实注册不再返回“未知工作台命令”。

## 真实验证结果

运行 `CUTPOT_ROOT='/absolute/path/to/TPCstore/cutpot' pnpm --filter @cpclaw/desktop exec electron ../../scripts/verify-cutpot-driver.mjs`。脚本要求 Node、FFmpeg/ffprobe、现有 CPclaw 构建依赖和允许本机端口/Electron GUI 的环境。

脚本启动临时端口和数据目录，用夹具平台登录，经真实 workspace worker 注册驱动应用；使用 CPclaw 的 extension-host / service-runtime / local-tools 执行真实 CLI。测试对话在隔离配置中设置完全访问权限，不影响用户已有对话。

通过的行为：

1. 原生能力发现，读取 CutPot 实际 capabilities。
2. CLI 创建工程，内嵌 /editor 读取相同名称。
3. 内嵌页面修改名称并自动保存，CLI project save 回读相同内容。
4. CPclaw 宿主执行 FFmpeg 创建本地测试片，CutPot CLI 导入、添加 2 秒镜头、导出。
5. ffprobe 核验实际导出为 1280×720、50 帧；工程设置为 25 fps，即 2 秒。
6. 另开独立窗口读取同一工程与镜头。独立窗口和内嵌页面共用服务状态。
7. 测试结束关闭测试窗口、停止此次 CutPot 服务及夹具平台，保留证据。

证据：[result.json](result.json)、[能力回执](capabilities.json)、[ffprobe](ffprobe.json)、[内嵌视图](cutpot-view.png)、[独立窗口](independent.png)、[实际导出](export.mp4)。result.json 中临时 URL 在测试结束后已停止，不是长期连接地址。Electron 主窗口 capturePage 不包含原生子视图，内嵌截图单独从实际 WebContentsView 捕获。

## 检查与限制

- service-kinds + computer-use：12 项通过，覆盖工作台持久化、重复注册更新、外部地址/凭据拒绝和页面边界。
- service-runtime：26 项通过；另有 1 项既有注册列表断言在本机失败，因为它未计入可发现的飞书内置服务。确认失败原因后单独跳过该项重跑，其余通过；没有修改该旧断言。
- 修改的 JS/MJS 语法检查通过。本次未运行全仓验证、打包、安装或发布。
- 这是结构化执行链路验收，不是真实模型在自然对话中自主选择并操作 CutPot 的验收。左侧任务由测试脚本确定性发起。
- CLI 改动后需要刷新页面；当前没有自动双向实时同步。浏览器有未保存编辑时应先保存，不能承诺无冲突合并。
- 当前右侧约半屏的宽度会压缩 CutPot 时间轴及属性区域，出现滚动；不把加载通过当作专业编辑布局验收。
- 独立窗口验证仍在 CPclaw 测试进程中承载，但页面直接连接 CutPot 自身服务，没有宿主 preload；另需按 CutPot 原生指南验证系统浏览器操作。
- 启停仍采用显式操作；未建设应用市场安装器、通用生命周期管理、TPCstore CutPot manifest 或统一协议 envelope 适配。CutPot 原生回执与 TPCstore 的统一 envelope 不同。

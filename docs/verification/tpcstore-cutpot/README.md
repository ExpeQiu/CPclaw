# TPCstore → CutPot → CPclaw 接入验收

日期：2026-11-05。状态：源码本机试点通过；未打包、发布或更新安装版；未调用真实模型或付费生成。

## 入口与实现

“拓展 → 驱动应用 → 从 TPCstore 添加”。首次用文件夹选择器选可信 TPCstore 根目录，之后记忆来源；无需输入 CutPot 目录或页面地址。读取来源前确认运行该来源校验 CLI，连接应用前确认执行连接程序。此处运行本机来源，不是从远程下载安装应用。

1. TPCstore apps/cutpot.json 登记 V17、相对运行入口、业务 schema、工作区及可选 integration 连接入口。
2. CPclaw 执行 TPCstore 的 apps list，经过其 schema、产品/质量关联、文件/目录越界和重复操作校验；宿主另外拒绝不支持协议、重复 ID、越界入口。
3. 选择 CutPot 后适配器分配实际本机端口、启动宿主专用数据目录下的服务，确认健康身份，再返回实际 webUrl。CPclaw 复核服务 appRoot 后登记驱动应用，保存来源与数据上下文，打开 /editor。
4. 再连接复用同一服务与数据目录，不创建重复条目。关闭页面不停止服务；需要时走原生 stop。移出列表也不删除工程或强停服务。
5. service_action discover 读取标准适配器能力，app_call 调用 project-show/workflow-show。原生编辑工具继续保留；终端自动注入 CUTPOT_URL/CUTPOT_DATA，避免误连默认 CutPot 工程。

TPCstore 是实际目录与契约提供者、校验入口及适配器来源，日常业务由宿主直接调用应用能力。不增加独立 Agent 循环。

## 验证与证据

复现命令：`CUTPOT_ROOT='/absolute/path/to/TPCstore/cutpot' pnpm --filter @cpclaw/desktop exec electron ../../scripts/verify-tpcstore-cutpot.mjs`。依赖现有 CPclaw 构建、Node、FFmpeg 和 GUI/本机端口权限。测试预置可信 TPCstore 根目录（模拟首次来源选择），原生确认由测试替身批准；目录列表、连接按钮、IPC、工作进程和 CutPot 服务均为真实代码。使用隔离夹具账号与数据，不改用户原有工程。

已通过：

- 从目录取得 CutPot 清单，校验并自动连接；目录界面展示并能点击“连接并打开”。
- 重连返回 reused=true，服务 ID 与页面地址保持一致。
- 标准 app_call 从真实服务读取工程。
- CLI 建工程→内嵌页读取；页面改名→CLI 回读；独立窗口读同一工程。
- 终端未传 --url，仍经宿主环境指向已连接实例；导入、加镜头、导出本机测试视频，ffprobe 核验 1280×720、50 帧、工程 25 fps（2 秒）。
- 页面显式重新加载后显示真实素材与时间线；不宣称事件同步。截图取自实际 WebContentsView；主窗口 capturePage 不包含该子视图。

证据：[结果](result.json)、[目录回执](tpcstore-catalog.json)、[连接回执](tpcstore-connect.json)、[标准调用](adapter-read.json)、[目录界面文本](catalog-ui.txt)、[视频检查](ffprobe.json)、[内嵌视图](cutpot-view.png)、[实际视频](export.mp4)。回执中的临时服务测试结束后已停止。

TPCstore 全套验证 85 项通过（74 基础/契约、7 V04、4 MCP）；CPclaw 本轮目录/路径/argv/驱动/页面测试 16 项通过，运行时回归 26 项通过。运行时既有“注册列表不含飞书”的环境依赖断言此前已确认不适用本机，本轮回归使用 test-skip-pattern 排除此项，未修改旧断言。

## 实际边界

仅完成本机源码连接，不含远程市场下载、依赖安装、签名更新、团队认证、跨设备工程迁移、真实模型自主操作或正式交付。标准适配器首批只读；原生写操作的回执、费用和恢复仍按 CutPot CLI 真实契约处理，不冒充全量 TPCstore 标准操作。半屏编辑布局仍需优化。

数据目录按本机宿主、来源和应用隔离；应用默认不接管原有 CutPot 工作台。连接中断可能留下待核实状态/连接锁，需检查原服务后恢复，不能盲目删除锁或重复提交任务。宿主信任用户所选本机来源，清单静态校验不是来源签名或完整代码审计。

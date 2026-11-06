# 文件夹加载交互验收

日期：2026-11-05。源码态实现；未更新安装版、未调用真实模型、未提交付费生成任务。设计见[交互说明](../../design/加载应用文件夹交互.md)。

## 验证

`node --test apps/desktop/test/app-folder.test.mjs apps/desktop/test/tpcstore-apps.test.mjs apps/desktop/test/service-kinds.test.mjs apps/desktop/test/computer-use.test.mjs`：21 项通过。

`node --test --test-skip-pattern='registry includes CLI' apps/desktop/test/service-runtime.test.mjs`：26 项通过。排除此前已确认受本机飞书发现影响的旧列表断言，未改该断言。本轮不是整仓、安装版或真实模型验收。

`CUTPOT_ROOT='/absolute/path/TPCstore/cutpot' pnpm --filter @cpclaw/desktop exec electron ../../scripts/verify-app-folder.mjs`：通过。使用实际 renderer/IPC/workspace-worker/CutPot 服务和 CLI，测试账号/授权/文件夹选择器为隔离夹具，未改用户原有工程。

- 实际点击“加载应用文件夹”，识别 CutPot 子目录及其 TPCstore 清单，不手填目录或页面地址。
- 原生执行确认被取消后保留选择；重试进入注入的连接错误，错误保留；再重试真实连接并打开工作台。注入错误只验证 UI 恢复，不作为真实依赖故障的证据。
- 重复加载 reused=true，服务 ID 一致，不创建重复条目。
- 选择 TPCstore 根目录可返回真实目录；普通项目明确识别、添加；已识别应用不能跳过检查走普通项目入口。
- 标准只读调用、CLI→页面、页面→CLI、独立窗口读取同一工程均通过。
- 本地测试视频导入、加镜头、导出，通过 ffprobe 核对 2 秒、1280×720、25 fps、50 帧。服务结束后停止。

证据：[结果](result.json)、[识别/重连](folder-result.json)、[识别卡片](folder-recognized.png)、[错误卡片](folder-error.png)。临时地址在测试结束后停止；截图为真实 Electron 主窗口，原生弹窗由测试替身提供选择。

## 边界

当前真实连接适配仍为 CutPot。其他已登记产品及独立 app-manifest.json 暂未有支持时明确说明，不伪装成已连接服务，也不静默降级项目。普通项目不启动服务。静态识别不执行选中源码；真正校验与连接沿用宿主确认。

关闭面板不等于停止服务；连接过程中禁用关闭与重复操作，取消执行通过原生确认完成。若连接过程异常中断仍按已有运行时恢复规则核对服务，不自动强停或重复生成。专业剪辑半屏布局、完整插件分发、其他应用接入、真实模型自主操作、完整重启恢复与发布打包另行验收。

原 `scripts/verify-tpcstore-cutpot.mjs` 已更新到新入口并回归通过：点击“最近的 TPCstore”→“检查并查看应用”→应用卡片“重新连接并打开”，继续完成真实工程与本地视频导出检查。此次同样使用隔离来源、账号与数据。

分类确认：入口默认选中“驱动应用”，选中项采用深色高亮；HTML tab 与运行态一致。Electron 额外断言初始唯一选中 app-driver、加载后服务 kind=app-driver，完整加载链路通过；分类与识别定向测试 9 项通过。已更新截图与结果中的 driverCategory=true。

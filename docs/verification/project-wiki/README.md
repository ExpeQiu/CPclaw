# 项目信息压缩验证记录

日期：2026-10-29（Asia/Shanghai）。本记录验证源码与隔离桌面流程，没有替换已安装应用，也没有向真实模型提交项目资料。

## 已通过

- 最终专项测试：`node --test apps/desktop/test/project-wiki.test.mjs apps/desktop/test/project-wiki-service.test.mjs`，12 / 12。
- 实现期间桌面回归：`node --test apps/desktop/test/*.test.mjs`，133 / 133；其后补充的恢复、人工编辑保护、账号清理和已受理请求保护由最终专项测试与 Electron 验证覆盖。
- 现有项目行为：`node scripts/verify-projects.mjs`。
- 现有项目检索：`node scripts/verify-project-search.mjs`。
- `git diff --check`。
- 最终隔离桌面流程：`pnpm --filter @cpclaw/desktop exec electron ../../scripts/verify-project-wiki-ui.mjs`。使用真实 workspace worker、账号与项目 RPC、真实临时文件和 HTTP 模型响应夹具。两次模型夹具调用分别对应首次生成和原文修改后的增量更新；无变化再次执行没有模型调用。未消耗真实模型额度。
- Electron 覆盖：项目操作区图标位置、不触发项目折叠、扫描及未支持材料、Wiki 生成和查看、引用行号和原文文件定位、增量更新、无变化不请求模型、本次变更、宽窄布局、清理账号预览、无渲染控制台错误。
- 最后一次 `bash scripts/verify.sh` 中各包 TypeScript 构建均通过。

## 未通过的全量验收

`bash scripts/verify.sh` 最终返回 1，在既有 P0 扫描输出：

```text
---- P0-02.b 至 P0-05 ----
界面引用了 Harness：.../apps/desktop/test/kernel-status.test.mjs
```

本次没有修改该测试或放宽扫描规则，不能宣布全量 P0 通过。原始运行日志：`/tmp/cpclaw-wiki-full-verify.log`。最终专项日志：`/tmp/cpclaw-wiki-tests.log`；最终 Electron 日志：`/tmp/cpclaw-wiki-ui.log`。

## 截图

- `desktop-project-wiki.png`：1280 × 860。
- `desktop-project-wiki-narrow.png`：800 × 860。

## 未验证

真实模型的知识加工质量、跨资料语义合并与全局冲突识别、已安装应用、签名安装包、生产平台发布。现有聊天接口无法回读已受理请求的结果，不确定请求保留原编号并提示核实，不能自动保证续接。

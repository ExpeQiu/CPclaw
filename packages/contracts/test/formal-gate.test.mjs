import assert from "node:assert/strict";
import test from "node:test";
import { assessFormalTracks, formalPhaseReady } from "../dist/formal-gate.js";

test("缺输入时正式轨道关闭，空字符串和自动更新开关都不能打开", () => {
  const closed = assessFormalTracks({ CPCLAW_SIGNING_IDENTITY: "  ", CPCLAW_AUTO_UPDATE: "1" });
  assert.equal(closed.every((track) => track.open === false), true);
  assert.equal(formalPhaseReady({}), false);
  assert.equal(closed.find((track) => track.id === "autoUpdate")?.open, false);
});

test("提供对应输入后只打开该轨道，回调未验证时 IM 仍关闭", () => {
  const tracks = assessFormalTracks({
    CPCLAW_FIRST_CLI: "lark-cli",
    CPCLAW_FIRST_MCP: "https://mcp.example/rpc",
    CPCLAW_FEISHU_APP_ID: "cli_xxx",
    CPCLAW_WECOM_AGENT_ID: "1001",
  });
  assert.equal(tracks.find((track) => track.id === "cli")?.open, true);
  assert.equal(tracks.find((track) => track.id === "mcp")?.open, true);
  assert.equal(tracks.find((track) => track.id === "feishu")?.open, false);
  assert.equal(tracks.find((track) => track.id === "wecom")?.open, false);
  assert.equal(formalPhaseReady({
    CPCLAW_SIGNING_IDENTITY: "Developer ID",
    CPCLAW_FIRST_CLI: "lark-cli",
    CPCLAW_FIRST_MCP: "https://mcp.example/rpc",
    CPCLAW_KNOWLEDGE_SAMPLE: "sample.md",
    CPCLAW_LEARNING_BUDGET: "20",
    CPCLAW_FEISHU_APP_ID: "cli_xxx",
    CPCLAW_WECOM_AGENT_ID: "1001",
    CPCLAW_IM_CALLBACK_VERIFIED: "1",
    CPCLAW_FORMAL_DEPLOY: "intranet",
    CPCLAW_OIDC_ISSUER: "https://idp.example",
    CPCLAW_AUTO_UPDATE: "1",
  }), true);
});

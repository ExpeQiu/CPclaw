import assert from "node:assert/strict";
import test from "node:test";
import { readTokenUsage } from "@cpclaw/contracts";
import { resolveGatewayConfig, runModelChecks } from "../dist/index.js";

test("缺失用量保持 unknown，不记为零", () => {
  assert.deepEqual(readTokenUsage(undefined), { state: "unknown" });
  assert.deepEqual(readTokenUsage({}), { state: "unknown" });
  assert.deepEqual(readTokenUsage({ prompt_tokens: null, completion_tokens: 0 }), { state: "unknown" });
  assert.deepEqual(readTokenUsage({ prompt_tokens: 2, completion_tokens: 3 }), {
    state: "known",
    inputTokens: 2,
    outputTokens: 3,
  });
});

test("mock 模式五类记录里，取消和超时的用量不是零", async () => {
  const result = await runModelChecks({ AI_MOCK_MODE: "true" });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(
    result.records.map((record) => record.kind),
    ["text", "stream", "tool", "cancel", "timeout"],
  );
  for (const kind of ["cancel", "timeout"]) {
    const record = result.records.find((item) => item.kind === kind);
    assert.equal(record?.usage.state, "unknown");
  }
});

test("默认走指南里的 OpenAI 兼容地址", () => {
  const config = resolveGatewayConfig({ AI_MOCK_MODE: "false", MINIMAX_API_KEY: "local-test" });
  assert.equal(config.mode, "real");
  if (config.mode !== "real") {
    return;
  }
  assert.equal(config.baseUrl, "https://api.minimaxi.com/v1");
});

test("空地址不回落，主机根地址补上 /v1", () => {
  const empty = resolveGatewayConfig({
    AI_MOCK_MODE: "false",
    MINIMAX_API_KEY: "local-test",
    MINIMAX_BASE_URL: "",
  });
  assert.equal(empty.ok, false);
  const host = resolveGatewayConfig({
    AI_MOCK_MODE: "false",
    MINIMAX_API_KEY: "local-test",
    MINIMAX_BASE_URL: "https://api.minimaxi.com/",
  });
  assert.equal(host.mode, "real");
  if (host.mode !== "real") {
    return;
  }
  assert.equal(host.baseUrl, "https://api.minimaxi.com/v1");
  const explicit = resolveGatewayConfig({
    AI_MOCK_MODE: "false",
    MINIMAX_API_KEY: "local-test",
    MINIMAX_BASE_URL: "https://api.minimaxi.com",
    MINIMAX_OPENAI_BASE_URL: "https://example.test/v1/",
  });
  assert.equal(explicit.mode, "real");
  if (explicit.mode !== "real") {
    return;
  }
  assert.equal(explicit.baseUrl, "https://example.test/v1");
});

test("没有密钥时真实模式失败", async () => {
  const result = await runModelChecks({ AI_MOCK_MODE: "false" });
  assert.equal(result.ok, false);
});

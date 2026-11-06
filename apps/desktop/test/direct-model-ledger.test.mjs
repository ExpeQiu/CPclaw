import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeAccountSession } from "@cpclaw/desktop-host/account-session";
import { createChatService } from "../chat-service.mjs";

test("本机按账号累计直连用量，达到阀值后不再调用模型", async (t) => {
  const root = mkdtempSync("/tmp/cpclaw-direct-ledger-");
  const actor = "ledger-user";
  writeAccountSession(root, { schemaVersion: 1, employeeId: actor, sessionId: "fixture-session", refreshToken: "fixture-refresh" }, { makeCurrent: true });
  writeFileSync(join(root, "desktop-connection.json"), JSON.stringify({ platformUrl: "https://fixture.invalid" }));
  let loops = 0, grants = 0, limit = 15;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/v1/session/refresh")) return Response.json({ employeeId: actor, sessionId: "fixture-session", refreshToken: "fixture-refresh", accessToken: "fixture-access" });
    if (url.endsWith("/v1/me/model-access")) { grants += 1; return Response.json({ schemaVersion: 1, mode: "real", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "direct-key", limitTokens: limit }); }
    if (url.endsWith("/v1/me/quota-requests")) { limit = 40; return Response.json({ ok: true, status: "approved", additionalTokens: 25 }); }
    if (url.endsWith("/v1/market")) return Response.json({ connectors: [], items: [] });
    throw Error("Unexpected route " + url);
  });
  const service = createChatService(root, () => {}, {
    runServiceLoop: async (input) => {
      loops += 1;
      assert.equal(input.directModel.baseUrl, "https://api.minimaxi.com/v1");
      assert.equal(input.directModel.apiKey, "direct-key");
      input.onAccepted("accepted");
      input.onUsage({ inputTokens: 10, outputTokens: 6 });
      return { finalResponse: "已完成" };
    },
  });
  try {
    const { chatId } = await service.dispatch("chat.create", actor, {});
    const first = await service.dispatch("chat.send", actor, { chatId, requestId: "first", text: "你好" });
    assert.equal(first.state, "done");
    const row = new DatabaseSync(join(root, "chat.sqlite")).prepare("SELECT input_tokens,output_tokens,calls FROM account_model_usage WHERE employee=?").get(actor);
    assert.equal(row.input_tokens, 10);
    assert.equal(row.output_tokens, 6);
    assert.equal(row.calls, 1);
    const second = await service.dispatch("chat.send", actor, { chatId, requestId: "second", text: "继续" });
    assert.equal(second.state, "error");
    assert.match((await service.dispatch("chat.history", actor, { chatId })).messages.at(-1).error, /额度不足/);
    assert.equal(loops, 1);
    assert.equal(grants, 1);
    assert.equal((await service.dispatch("account.quotaRequest", actor, { requestId: "raise-1", additionalTokens: 25 })).status, "approved");
    assert.equal(grants, 2);
    const third = await service.dispatch("chat.send", actor, { chatId, requestId: "third", text: "继续" });
    assert.equal(third.state, "done");
    assert.equal(loops, 2);
    assert.equal(grants, 2);
  } finally {
    service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

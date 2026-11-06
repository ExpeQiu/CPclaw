import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runReportLoop } from "../dist/index.js";

test("direct model posts to the provider and reports known usage", async (t) => {
  const root = mkdtempSync("/tmp/cpclaw-direct-model-");
  const sdk = join(root, "node_modules/@deepseek-ai/dsh-sdk-client/lib");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "index.js"), `const fs=require('fs');exports.DeepSeekHarness=class{constructor(o){this.o=o;}async run(_input,options){const home=this.o.dshHome,settings=fs.readFileSync(home+'/settings.yaml','utf8'),patch=fs.readFileSync(home+'/cpclaw-marker.patch.yml','utf8');if(settings.includes('direct-key')||patch.includes('direct-key'))throw Error('key leaked');const base=settings.match(/baseURL: (.+)/)[1];const response=await fetch(base+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+this.o.env.CPCLAW_MODEL_KEY,'content-type':'application/json'},body:JSON.stringify({model:'MiniMax-M3',messages:[{role:'user',content:'hello'}]})});await response.text();options.onNotification({method:'session.event',params:{event:{type:'assistant/message',data:{usage:{inputTokens:11,outputTokens:4}}}}});return {finalResponse:'ok'};}async close(){}};`);
  const before = process.env.CPCLAW_HARNESS_BUNDLE;
  const original = globalThis.fetch;
  const seen = [];
  process.env.CPCLAW_HARNESS_BUNDLE = root;
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (String(url).startsWith("https://api.minimaxi.com")) {
      seen.push({ url: String(url), authorization: init.headers.authorization, body: JSON.parse(init.body) });
      return Promise.resolve(new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
    }
    return original(url, init);
  });
  const usage = [];
  try {
    const result = await runReportLoop({
      homeParent: root, platformBase: "http://budget-fixture.invalid", accessToken: "platform-token",
      directModel: { baseUrl: "https://api.minimaxi.com/v1", apiKey: "direct-key" },
      onUsage: value => usage.push(value),
      goal: "test", materials: [], signal: new AbortController().signal, beforeCall() {}, unknownUsage() {},
      pipeline: { context: "fixture", tools: [], execute: async () => ({ ok: true }) },
    });
    assert.equal(result.finalResponse, "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.minimaxi.com/v1/chat/completions");
    assert.equal(seen[0].authorization, "Bearer direct-key");
    assert.equal(JSON.stringify(seen[0].body).includes("direct-key"), false);
    assert.deepEqual(usage, [{ inputTokens: 11, outputTokens: 4 }]);
  } finally {
    if (before === undefined) delete process.env.CPCLAW_HARNESS_BUNDLE;
    else process.env.CPCLAW_HARNESS_BUNDLE = before;
    rmSync(root, { recursive: true, force: true });
  }
});

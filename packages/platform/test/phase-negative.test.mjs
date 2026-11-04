import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { assessFormalTracks, formalPhaseReady } from "@cpclaw/contracts";
import { fixtureEmployees, openPlatform } from "../dist/index.js";

test("未提供业务输入时不能宣布首期正式通过，签名与自动更新保持关闭", () => {
  assert.equal(formalPhaseReady({}), false);
  assert.equal(assessFormalTracks({ CPCLAW_AUTO_UPDATE: "yes" }).find((track) => track.id === "autoUpdate")?.open, false);
  assert.equal(assessFormalTracks({}).find((track) => track.id === "signing")?.open, false);
});

test("员工 A 的待审候选对 B 和无权员工不可见，审核后只下发给指定成员", () => {
  const dataDir = mkdtempSync("/tmp/cpclaw-learning-");
  const opened = openPlatform({
    dataDir,
    port: 0,
    listenHost: "127.0.0.1",
    sessionSecret: "learning-secret-0123456789abcdef",
    accessTtlSec: 3600,
    refreshTtlSec: 7200,
    seed: { kind: "fixture", employees: fixtureEmployees },
    keyPresent: false,
    now: () => Date.now(),
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const { app } = opened;
  const login = (employeeId) => {
    const result = app.login({ employeeId, password: `fixture-${employeeId}`, deviceLabel: "learning" });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("login");
    return result.accessToken;
  };
  try {
    const admin = login("admin");
    const author = login("employee-a");
    const peer = login("employee-b");
    const outsider = login("employee-c");
    assert.equal(app.learning(author, "submit", { kind: "experience", title: "未授权", body: "不应上行", sourceTaskId: "task-1" }).code, "FORBIDDEN");
    assert.equal(app.setLearningEnabled(admin, true).ok, true);
    const first = app.learning(author, "submit", { kind: "experience", title: "验收经验", body: "只含摘要", sourceTaskId: "task-1" });
    assert.equal(first.ok, true);
    const again = app.learning(author, "submit", { kind: "experience", title: "验收经验", body: "只含摘要", sourceTaskId: "task-1" });
    assert.equal(again.ok, true);
    assert.equal(again.candidate.candidateId, first.candidate.candidateId);
    assert.equal(app.learning(peer, "published", {}).resources.length, 0);
    assert.equal(app.learning(outsider, "published", {}).resources.length, 0);
    assert.equal(app.learning(author, "withdraw", { id: first.candidate.candidateId }).ok, true);
    const resent = app.learning(author, "submit", { kind: "skill", title: "可复用步骤", body: "摘要步骤", sourceTaskId: "task-2" });
    assert.equal(resent.ok, true);
    assert.equal(app.reviewLearningCandidate(admin, { candidateId: resent.candidate.candidateId, decision: "approve", members: ["employee-b"] }).ok, true);
    assert.equal(app.learning(author, "published", {}).resources.length, 0);
    assert.equal(app.learning(peer, "published", {}).resources.length, 1);
    assert.equal(app.learning(outsider, "published", {}).resources.length, 0);
    assert.equal(app.learning(outsider, "published", {}).resources.some((item) => item.title === "可复用步骤"), false);
  } finally {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

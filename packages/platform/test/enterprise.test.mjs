import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureEmployees, openPlatform } from "../dist/index.js";

const secret = "test-session-secret-0123456789abcdef";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-p3-"));
}

function openFixture() {
  const dataDir = tempDir();
  const clock = { now: 1_700_000_000_000 };
  const opened = openPlatform({
    dataDir,
    port: 0,
    listenHost: "127.0.0.1",
    sessionSecret: secret,
    accessTtlSec: 60,
    refreshTtlSec: 3600,
    seed: { kind: "fixture", employees: fixtureEmployees },
    keyPresent: false,
    now: () => clock.now,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    throw new Error("平台没有打开");
  }
  return { dataDir, clock, app: opened.app };
}

function login(app, employeeId, deviceLabel = "device-1") {
  const passwords = {
    admin: "fixture-admin",
    "employee-a": "fixture-employee-a",
    "employee-b": "fixture-employee-b",
    "employee-c": "fixture-employee-c",
  };
  const result = app.login({ employeeId, password: passwords[employeeId], deviceLabel });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("登录失败");
  }
  return result;
}

test("P3-01 上传快照幂等、取消并发与私有读取隔离", () => {
  const { app } = openFixture();
  try {
    const a = login(app, "employee-a");
    const b = login(app, "employee-b");
    const body = "# 报告\n私有正文";
    const key = "artifact-1";
    const created = app.createUpload(a.accessToken, {
      purpose: "artifact",
      contentSha256: sha256(body),
      byteSize: Buffer.byteLength(body),
      idempotencyKey: key,
    });
    assert.equal(created.ok, true);
    const replay = app.createUpload(a.accessToken, {
      purpose: "artifact",
      contentSha256: sha256(body),
      byteSize: Buffer.byteLength(body),
      idempotencyKey: key,
    });
    assert.equal(replay.ok, true);
    if (created.ok && replay.ok) {
      assert.equal(created.upload.uploadId, replay.upload.uploadId);
    }
    const uploadId = created.ok ? created.upload.uploadId : "";
    assert.equal(app.putUploadContent(a.accessToken, uploadId, body).ok, true);
    const cancelled = app.cancelUpload(a.accessToken, uploadId);
    assert.equal(cancelled.ok, true);
    const completeAfterCancel = app.completeUpload(a.accessToken, uploadId);
    assert.equal(completeAfterCancel.ok, false);

    const body2 = "# 第二份";
    const second = app.createUpload(a.accessToken, {
      purpose: "artifact",
      contentSha256: sha256(body2),
      byteSize: Buffer.byteLength(body2),
      idempotencyKey: "artifact-2",
    });
    assert.equal(second.ok, true);
    const id2 = second.ok ? second.upload.uploadId : "";
    assert.equal(app.putUploadContent(a.accessToken, id2, body2).ok, true);
    const done = app.completeUpload(a.accessToken, id2);
    assert.equal(done.ok, true);
    const again = app.completeUpload(a.accessToken, id2);
    assert.equal(again.ok, true);
    if (done.ok && again.ok) {
      assert.equal(done.upload.fileId, again.upload.fileId);
      const fileId = done.upload.fileId;
      assert.equal(app.readPrivateFile(a.accessToken, fileId).ok, true);
      const denied = app.readPrivateFile(b.accessToken, fileId);
      assert.equal(denied.ok, false);
      if (!denied.ok) {
        assert.equal(denied.code, "FORBIDDEN");
      }
    }
    const admin = login(app, "admin", "admin-device");
    assert.equal(app.cleanupStaging(admin.accessToken).ok, true);
  } finally {
    app.close();
  }
});

test("P3-01 日志批次去重、脱敏拒绝与换账号隔离", () => {
  const { app } = openFixture();
  try {
    const a = login(app, "employee-a");
    const b = login(app, "employee-b");
    const batch = {
      batchId: "batch-a-1-2",
      deviceEpoch: "ep-a",
      cursorFrom: 1,
      events: [
        { seq: 1, event: "run_start", message: "开始执行" },
        { seq: 2, event: "run_end", message: "结束" },
      ],
    };
    const first = app.receiveLogBatch(a.accessToken, batch);
    assert.equal(first.ok, true);
    const dup = app.receiveLogBatch(a.accessToken, batch);
    assert.equal(dup.ok, true);
    if (first.ok && dup.ok) {
      assert.equal(dup.receipt.duplicate, true);
      assert.equal(dup.receipt.acceptedThrough, first.receipt.acceptedThrough);
    }
    const stolen = app.getLogBatchReceipt(b.accessToken, batch.batchId);
    assert.equal(stolen.ok, false);
    const leaked = app.receiveLogBatch(a.accessToken, {
      batchId: "batch-leak",
      deviceEpoch: "ep-a",
      cursorFrom: 3,
      events: [{ seq: 3, event: "bad", message: "path=/Users/secret/token" }],
    });
    assert.equal(leaked.ok, false);
  } finally {
    app.close();
  }
});

test("P3-02 Skill 上传不公开、改稿重审、路径穿越拒绝", () => {
  const { app } = openFixture();
  try {
    const admin = login(app, "admin", "admin-device");
    const a = login(app, "employee-a");
    const submitted = app.submitSkill(a.accessToken, {
      skillId: "report-helper",
      version: "1.0.0",
      platforms: ["darwin-arm64"],
      packageBody: "# Skill\n步骤",
    });
    assert.equal(submitted.ok, true);
    const listedBefore = app.listAvailableSkills(a.accessToken);
    assert.equal(listedBefore.ok, true);
    if (listedBefore.ok) {
      assert.equal(listedBefore.skills.length, 0);
    }
    const traversal = app.submitSkill(a.accessToken, {
      skillId: "evil",
      version: "1.0.0",
      platforms: ["darwin-arm64"],
      packageBody: "copy ../etc/passwd",
    });
    assert.equal(traversal.ok, false);
    if (!submitted.ok) {
      throw new Error("提交失败");
    }
    assert.equal(
      app.reviewSkillSubmission(admin.accessToken, { submissionId: submitted.submissionId, decision: "approve" }).ok,
      true,
    );
    const listed = app.listAvailableSkills(a.accessToken);
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.skills.length, 1);
    }
    const revised = app.reviseSkillSubmission(a.accessToken, {
      submissionId: submitted.submissionId,
      packageBody: "# Skill\n改稿",
      platforms: ["darwin-arm64"],
    });
    assert.equal(revised.ok, true);
    if (revised.ok) {
      assert.equal(revised.status, "pending");
    }
  } finally {
    app.close();
  }
});

test("P3-03/04 原文 ACL、撤权与 Enterprise Wiki 未审不可见", () => {
  const { app } = openFixture();
  try {
    const admin = login(app, "admin", "admin-device");
    const a = login(app, "employee-a");
    const b = login(app, "employee-b");
    const c = login(app, "employee-c");
    assert.equal(
      app.ingestKnowledge(admin.accessToken, {
        docId: "policy-1",
        title: "制度摘录",
        format: "markdown",
        body: "制度要求保留来源与版本。",
        aclGroup: "readers",
      }).ok,
      true,
    );
    const hitsA = app.searchKnowledge(a.accessToken, "保留来源");
    assert.equal(hitsA.ok, true);
    if (hitsA.ok) {
      assert.equal(hitsA.hits.length, 1);
    }
    const hitsC = app.searchKnowledge(c.accessToken, "保留来源");
    assert.equal(hitsC.ok, true);
    if (hitsC.ok) {
      assert.equal(hitsC.hits.length, 0);
    }
    const draft = app.draftWiki(a.accessToken, {
      pageId: "wiki-policy",
      title: "制度主题",
      body: "跨文档摘要",
      sourceDocIds: ["policy-1"],
    });
    assert.equal(draft.ok, true);
    assert.equal(app.getPublishedWiki(b.accessToken, "wiki-policy").ok, false);
    assert.equal(app.submitWikiReview(a.accessToken, "wiki-policy").ok, true);
    if (draft.ok) {
      assert.equal(
        app.reviewWiki(admin.accessToken, {
          pageId: "wiki-policy",
          revision: draft.page.revision,
          decision: "approve",
        }).ok,
        true,
      );
    }
    assert.equal(app.getPublishedWiki(b.accessToken, "wiki-policy").ok, true);
    assert.equal(app.revokeKnowledge(admin.accessToken, "policy-1").ok, true);
    assert.equal(app.citeKnowledge(a.accessToken, "policy-1", "offset:0").ok, false);
    assert.equal(app.getPublishedWiki(b.accessToken, "wiki-policy").ok, false);
  } finally {
    app.close();
  }
});

test("P3-05/06 学习默认关闭；A 贡献 B 复用 C 不可见；改稿使旧批准失效", () => {
  const { app } = openFixture();
  try {
    const admin = login(app, "admin", "admin-device");
    const a = login(app, "employee-a");
    const b = login(app, "employee-b");
    const c = login(app, "employee-c");
    const blocked = app.submitLearningCandidate(a.accessToken, {
      kind: "experience",
      title: "报告写法",
      body: "先列来源再写结论",
    });
    assert.equal(blocked.ok, false);
    assert.equal(app.setLearningEnabled(admin.accessToken, true).ok, true);
    const kinds = ["experience", "memory", "skill"];
    const ids = [];
    for (const kind of kinds) {
      const submitted = app.submitLearningCandidate(a.accessToken, {
        kind,
        title: `${kind}-title`,
        body: `${kind}-body`,
        sourceTaskId: "task-1",
      });
      assert.equal(submitted.ok, true);
      if (submitted.ok) {
        ids.push(submitted.candidate.candidateId);
        assert.equal(
          app.reviewLearningCandidate(admin.accessToken, {
            candidateId: submitted.candidate.candidateId,
            decision: "approve",
          }).ok,
          true,
        );
      }
    }
    const forB = app.listOrgResources(b.accessToken);
    assert.equal(forB.ok, true);
    if (forB.ok) {
      assert.equal(forB.resources.length, 3);
      assert.equal(app.recordFeedback(b.accessToken, { resourceId: forB.resources[0].resourceId, helpful: true }).ok, true);
    }
    const forC = app.listOrgResources(c.accessToken);
    assert.equal(forC.ok, true);
    if (forC.ok) {
      assert.equal(forC.resources.length, 0);
    }
    const revised = app.reviseLearningCandidate(a.accessToken, {
      candidateId: ids[0],
      title: "报告写法 v2",
      body: "改稿后需重审",
    });
    assert.equal(revised.ok, true);
    const afterRevise = app.listOrgResources(b.accessToken);
    assert.equal(afterRevise.ok, true);
    if (afterRevise.ok) {
      assert.equal(afterRevise.resources.length, 2);
    }
  } finally {
    app.close();
  }
});

test("P3-07 报告可引用原文版本与位置", () => {
  const { app } = openFixture();
  try {
    const admin = login(app, "admin", "admin-device");
    const a = login(app, "employee-a");
    assert.equal(
      app.ingestKnowledge(admin.accessToken, {
        docId: "note-1",
        title: "项目笔记",
        format: "markdown",
        body: "项目记录只覆盖本机材料与企业证据。",
        aclGroup: "readers",
      }).ok,
      true,
    );
    const cited = app.citeKnowledge(a.accessToken, "note-1", "offset:0");
    assert.equal(cited.ok, true);
    if (cited.ok) {
      assert.equal(cited.version, 1);
      assert.ok(cited.excerpt.includes("项目记录"));
    }
    const uploadBody = `# 报告\n\n来源: note-1@v1 offset:0\n`;
    const up = app.createUpload(a.accessToken, {
      purpose: "artifact",
      contentSha256: sha256(uploadBody),
      byteSize: Buffer.byteLength(uploadBody),
      idempotencyKey: "report-upload",
    });
    assert.equal(up.ok, true);
    if (up.ok) {
      assert.equal(app.putUploadContent(a.accessToken, up.upload.uploadId, uploadBody).ok, true);
      assert.equal(app.completeUpload(a.accessToken, up.upload.uploadId).ok, true);
    }
  } finally {
    app.close();
  }
});

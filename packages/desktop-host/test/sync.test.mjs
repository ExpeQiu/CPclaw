import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LOG_QUEUE_CAP,
  installSkillPackage,
  openSyncStore,
  readCurrentSkill,
} from "../dist/index.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-sync-"));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("上传作业固定快照，原件再改不影响已选版本", () => {
  const dir = tempDir();
  const store = openSyncStore(dir);
  try {
    const created = store.createUploadJob({
      employeeId: "employee-a",
      purpose: "artifact",
      content: "版本一",
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      throw new Error("创建失败");
    }
    assert.equal(created.job.snapshot, "版本一");
    assert.equal(created.job.contentSha256, sha256("版本一"));
    assert.equal(store.bindUploadSession(created.job.jobId, "upl-1").ok, true);
    assert.equal(store.markUploadAvailable(created.job.jobId, "file-1").ok, true);
    const cancelDone = store.cancelUploadJob(created.job.jobId);
    assert.equal(cancelDone.ok, false);
  } finally {
    store.close();
  }
});

test("日志脱敏入队、断网式重发同批、换账号隔离与队列缺口", () => {
  const dir = tempDir();
  const store = openSyncStore(dir);
  try {
    const a = store.enqueueLog("employee-a", "run_start", "Bearer abc.def /Users/expe/secret");
    assert.equal(a.ok, true);
    if (a.ok) {
      assert.equal(a.dropped, false);
    }
    const batch = store.buildLogBatch("employee-a");
    assert.equal(batch.ok, true);
    if (!batch.ok || batch.batch === null) {
      throw new Error("应有批次");
    }
    assert.equal(batch.batch.events[0].message.includes("Bearer"), false);
    assert.equal(batch.batch.events[0].message.includes("/Users/"), false);
    const same = store.buildLogBatch("employee-a");
    assert.equal(same.ok, true);
    if (same.ok && same.batch !== null) {
      assert.equal(same.batch.batchId, batch.batch.batchId);
    }
    assert.equal(
      store.ackLogBatch("employee-a", batch.batch.batchId, batch.batch.cursorFrom + batch.batch.events.length - 1).ok,
      true,
    );
    const cursor = store.readCursor("employee-a");
    assert.equal(cursor.confirmedSeq >= 1, true);

    for (let i = 0; i < LOG_QUEUE_CAP + 2; i += 1) {
      store.enqueueLog("employee-b", "noise", `事件${i}`);
    }
    const bCursor = store.readCursor("employee-b");
    assert.equal(bCursor.dropped > 0, true);
    assert.ok(bCursor.gap !== undefined);

    const stolen = store.ackLogBatch("employee-b", batch.batch.batchId, 1);
    assert.equal(stolen.ok, false);
  } finally {
    store.close();
  }
});

test("Skill 安装摘要不符保留旧版，路径穿越与平台不兼容拒绝", () => {
  const dir = tempDir();
  const bodyV1 = "# v1";
  const first = installSkillPackage({
    dataDir: dir,
    skillId: "helper",
    version: "1.0.0",
    expectedSha256: sha256(bodyV1),
    packageBody: bodyV1,
    platforms: ["darwin-arm64"],
  });
  assert.equal(first.ok, true);
  const badDigest = installSkillPackage({
    dataDir: dir,
    skillId: "helper",
    version: "2.0.0",
    expectedSha256: sha256("not-this"),
    packageBody: "# v2",
    platforms: ["darwin-arm64"],
  });
  assert.equal(badDigest.ok, false);
  const current = readCurrentSkill(dir, "helper");
  assert.equal(current.ok, true);
  if (current.ok) {
    assert.equal(current.installed.version, "1.0.0");
    assert.equal(readFileSync(join(current.installed.path, "SKILL.md"), "utf8"), bodyV1);
  }
  assert.equal(
    installSkillPackage({
      dataDir: dir,
      skillId: "../evil",
      version: "1.0.0",
      expectedSha256: sha256("x"),
      packageBody: "x",
      platforms: ["darwin-arm64"],
    }).ok,
    false,
  );
  assert.equal(
    installSkillPackage({
      dataDir: dir,
      skillId: "helper",
      version: "3.0.0",
      expectedSha256: sha256("# win"),
      packageBody: "# win",
      platforms: ["win32-x64"],
    }).ok,
    false,
  );
});

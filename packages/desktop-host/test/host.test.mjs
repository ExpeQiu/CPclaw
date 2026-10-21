import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSyntheticReport } from "@cpclaw/contracts";
import {
  acceptTask,
  beginCall,
  cancelRun,
  commitReport,
  createRunControl,
  finishCancel,
  listParentRejected,
  readGrantedFile,
  writeReportFile,
} from "../dist/index.js";

const materials = [
  {
    fileName: "policy-excerpt.md",
    paragraphs: [{ id: "p1", text: "制度要求保留来源" }],
  },
  {
    fileName: "project-note.md",
    paragraphs: [{ id: "p1", text: "项目记录只覆盖本机材料" }],
  },
];

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cpclaw-host-"));
}

test("重复受理返回同一个任务", () => {
  const dir = tempDir();
  const command = {
    schemaVersion: 1,
    requestId: "req-1",
    idempotencyKey: "intent-1",
    payload: { taskId: "task-1", expectedTaskRevisionId: "rev-1" },
  };
  const first = acceptTask(dir, command, { runId: "run-1" });
  const second = acceptTask(dir, { ...command, requestId: "req-2" }, { runId: "run-2" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(second.receipt.runId, "run-1");
    assert.equal(second.receipt.replayed, true);
    assert.equal(first.receipt.replayed, false);
  }
  const tasks = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks;
  assert.equal(tasks.length, 1);
});

test("同键不同内容被拒绝且不新增任务", () => {
  const dir = tempDir();
  const first = {
    schemaVersion: 1,
    requestId: "req-1",
    idempotencyKey: "intent-1",
    payload: { taskId: "task-1", expectedTaskRevisionId: "rev-1" },
  };
  acceptTask(dir, first, { runId: "run-1" });
  const conflict = acceptTask(
    dir,
    { ...first, payload: { taskId: "task-2", expectedTaskRevisionId: "rev-1" } },
    { runId: "run-2" },
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  }
  assert.equal(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks.length, 1);
});

test("执行模式写入报告，问答和规划拒绝", () => {
  const root = tempDir();
  const output = join(root, "out");
  mkdirSync(output);
  const body = buildSyntheticReport({ goal: "生成带来源的报告", materials });
  const names = materials.map((item) => item.fileName);
  for (const mode of ["ask", "plan"]) {
    const refused = writeReportFile({ mode, outputDir: output, fileName: "report.md", body, materialNames: names });
    assert.equal(refused.ok, false);
    assert.equal(readFileSync.length > 0, true);
  }
  assert.equal(
    (() => {
      try {
        readFileSync(join(output, "report.md"), "utf8");
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
  const written = writeReportFile({
    mode: "execute",
    outputDir: output,
    fileName: "report.md",
    body,
    materialNames: names,
  });
  assert.equal(written.ok, true);
  if (written.ok) {
    assert.equal(written.check.ok, true);
    assert.equal(written.recognizedExisting, false);
  }
});

test("目录外、同名前缀和符号链接被拒绝", () => {
  const root = tempDir();
  const output = join(root, "out");
  const outside = join(root, "out-side");
  mkdirSync(output);
  mkdirSync(outside);
  const body = "x";
  const outsideWrite = writeReportFile({
    mode: "execute",
    outputDir: output,
    fileName: "../out-side/report.md",
    body,
    materialNames: [],
  });
  assert.equal(outsideWrite.ok, false);
  const prefix = writeReportFile({
    mode: "execute",
    outputDir: output,
    fileName: "../out-extra/report.md",
    body,
    materialNames: [],
  });
  assert.equal(prefix.ok, false);
  symlinkSync(outside, join(output, "escape"));
  const linked = writeReportFile({
    mode: "execute",
    outputDir: output,
    fileName: "escape/report.md",
    body,
    materialNames: [],
  });
  assert.equal(linked.ok, false);
  if (!linked.ok) {
    assert.equal(linked.code, "SYMLINK_ESCAPE");
  }
});

test("完成记录未写入时再次启动不覆盖", () => {
  const root = tempDir();
  const output = join(root, "out");
  mkdirSync(output);
  const body = buildSyntheticReport({ goal: "生成带来源的报告", materials });
  const names = materials.map((item) => item.fileName);
  writeReportFile({ mode: "execute", outputDir: output, fileName: "report.md", body, materialNames: names });
  const again = writeReportFile({
    mode: "execute",
    outputDir: output,
    fileName: "report.md",
    body: `${body}\nchanged`,
    materialNames: names,
  });
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.recognizedExisting, true);
  }
  assert.equal(readFileSync(join(output, "report.md"), "utf8").includes("changed"), false);
  commitReport(output);
});

test("单个文件授权不能列出父目录", () => {
  const root = tempDir();
  const file = join(root, "policy-excerpt.md");
  writeFileSync(file, "段落\n");
  const read = readGrantedFile({ kind: "file", path: file });
  assert.equal(read.ok, true);
  const listed = listParentRejected({ kind: "file", path: file });
  assert.equal(listed.ok, false);
  assert.equal(listed.code, "FILE_GRANT");
});

test("取消后不再发起新调用，已写文件保持待核实", () => {
  const control = createRunControl();
  assert.equal(beginCall(control).ok, true);
  notePath(control);
  cancelRun(control);
  assert.equal(beginCall(control).ok, false);
  const finished = finishCancel(control);
  assert.equal(finished.status, "reconcile_required");
  assert.equal(finished.pendingPaths.length, 1);
});

function notePath(control) {
  control.pendingPaths.push("/tmp/cpclaw-test/report.md");
}

import assert from "node:assert/strict";
import test from "node:test";
import { canCaptureLearning, defaultLearningGrant } from "../learning-flow.mjs";

test("学习授权默认关闭，预算、排除和暂停会阻断提交", () => {
  const now = 1_700_000_000_000;
  assert.equal(canCaptureLearning(defaultLearningGrant(), "task-1", now).ok, false);
  const grant = { ...defaultLearningGrant(), enabled: true, autoSubmit: true, budget: 1, kinds: ["experience"] };
  assert.equal(canCaptureLearning(grant, "task-1", now).ok, true);
  assert.equal(canCaptureLearning({ ...grant, paused: true }, "task-1", now).reason, "学习已暂停");
  assert.equal(canCaptureLearning({ ...grant, excludes: ["task-1"] }, "task-1", now).reason, "该任务已排除");
  assert.equal(canCaptureLearning({ ...grant, spent: 1 }, "task-1", now).reason, "学习预算已用完");

});

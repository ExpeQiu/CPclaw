import assert from "node:assert/strict";
import test from "node:test";
import { baselinePassed, runBusinessBaseline } from "../dist/index.js";

test("业务基线确定性检查通过且只记观测值", () => {
  const report = runBusinessBaseline({
    versionInventory: [
      { name: "cpclaw", version: "0.0.0" },
      { name: "MiniMax-M3", version: "mock" },
    ],
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.mode, "mock");
  assert.equal(baselinePassed(report), true);
  assert.equal(report.costLatency.note.includes("未确认门槛"), true);
  assert.equal(report.observations.length, 3);
  assert.equal(report.observations.every((item) => item.passed), true);
});

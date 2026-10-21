import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkFixtureReport, writeSyntheticReport } from "../dist/index.js";

test("合成材料生成可核对的 report.md", () => {
  const output = join(mkdtempSync(join(tmpdir(), "cpclaw-report-")), "out");
  mkdirSync(output);
  const written = writeSyntheticReport(output);
  assert.equal(written.ok, true);
  const check = checkFixtureReport(output);
  assert.equal(check.ok, true);
});

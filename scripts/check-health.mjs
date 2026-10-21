import { readFileSync } from "node:fs";
import { parseHealthReport } from "@cpclaw/contracts";

const raw = readFileSync(0, "utf8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.stderr.write("健康响应不是 JSON\n");
  process.exit(1);
}

const result = parseHealthReport(parsed);
if (!result.ok) {
  process.stderr.write(`${result.code}: ${result.message}\n`);
  process.exit(1);
}

process.stdout.write("健康报告符合 P0-02.a 契约\n");

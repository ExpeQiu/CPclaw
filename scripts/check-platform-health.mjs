import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");
let body;
try {
  body = JSON.parse(raw);
} catch (error) {
  const message = error instanceof Error ? error.message : "解析失败";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (
  body.schemaVersion !== 1 ||
  body.status !== "ok" ||
  body.service !== "cpclaw-platform" ||
  !["mock", "real"].includes(body.mode) ||
  body.aiMockMode !== (body.mode === "mock")
) {
  process.stderr.write("平台健康响应不符合约定\n");
  process.exit(1);
}

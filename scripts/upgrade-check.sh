#!/bin/bash
# 升级前兼容门禁（本机 Mock）。不下载 latest，不假装已签名。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CPCLAW_DATA_DIR="${CPCLAW_DATA_DIR:-${HOME}/Library/Application Support/CPclaw}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: CPCLAW_DATA_DIR=... bash scripts/upgrade-check.sh"
  exit 0
fi

cd "$ROOT"
node --input-type=module -e '
import {
  PLATFORM_SCHEMA_SUPPORTED,
  SESSION_SCHEMA_SUPPORTED,
  verifyUpgradeGate,
  WORKSPACE_SCHEMA_SUPPORTED,
  writeReleaseManifest,
  buildReleaseManifest,
} from "@cpclaw/desktop-host";

const dataDir = process.env.CPCLAW_DATA_DIR;
if (dataDir === undefined || dataDir === "") {
  console.error("缺少 CPCLAW_DATA_DIR");
  process.exit(1);
}
const built = buildReleaseManifest({
  appVersion: "0.0.1",
  packages: [{ name: "@cpclaw/desktop-host", version: "0.0.1" }],
});
if (!built.ok) {
  console.error(built.message);
  process.exit(1);
}
const written = writeReleaseManifest(dataDir, built.manifest);
if (!written.ok) {
  console.error(written.message);
  process.exit(1);
}
const result = verifyUpgradeGate({
  dataDir,
  targetWorkspaceSchema: WORKSPACE_SCHEMA_SUPPORTED,
  targetPlatformSchema: PLATFORM_SCHEMA_SUPPORTED,
  targetSessionSchema: SESSION_SCHEMA_SUPPORTED,
});
if (!result.ok) {
  console.error(result.message);
  process.exit(1);
}
console.log("升级门禁通过（未签名制品仍不可上生产）");
'

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.env.CPCLAW_STAGE_DIR === undefined || process.env.CPCLAW_STAGE_DIR === ""
  ? mkdtempSync(join(tmpdir(), "cpclaw-unsigned-"))
  : process.env.CPCLAW_STAGE_DIR;
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const packages = ["contracts", "desktop-host", "verification"];
for (const name of packages) {
  const source = join(root, "packages", name);
  const target = join(stage, "node_modules", "@cpclaw", name);
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "package.json"), join(target, "package.json"));
  cpSync(join(source, "dist"), join(target, "dist"), {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
}

const pnpmDir = join(root, "node_modules", ".pnpm");
const copied = new Set();

function pnpmPackageDir(name) {
  const prefix = name.startsWith("@") ? `${name.replace("/", "+")}@` : `${name}@`;
  const entry = readdirSync(pnpmDir).find((item) => item.startsWith(prefix));
  if (entry === undefined) {
    throw new Error(`未找到依赖 ${name}`);
  }
  return join(pnpmDir, entry, "node_modules", name);
}

function copyDependency(name) {
  if (copied.has(name)) {
    return;
  }
  copied.add(name);
  const source = pnpmPackageDir(name);
  const target = join(stage, "node_modules", name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (path) => !path.slice(source.length).includes(`${sep}node_modules${sep}`) && !path.endsWith(".map"),
  });
  const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  const dependencies = manifest.dependencies;
  if (typeof dependencies === "object" && dependencies !== null) {
    for (const dependency of Object.keys(dependencies)) {
      copyDependency(dependency);
    }
  }
}

copyDependency("ajv");

writeFileSync(join(stage, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
writeFileSync(
  join(stage, "run-report.mjs"),
  `import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFixtureReport, writeSyntheticReport } from "@cpclaw/verification";

const output = join(mkdtempSync(join(tmpdir(), "cpclaw-installed-")), "out");
mkdirSync(output);
const written = writeSyntheticReport(output);
if (!written.ok || !written.check.ok) {
  process.stderr.write("安装包未能生成报告\\n");
  process.exit(1);
}
const check = checkFixtureReport(output);
if (!check.ok) {
  process.stderr.write("安装包报告检查未通过\\n");
  process.exit(1);
}
process.stdout.write("unsigned-package report ok\\n");
`,
);

const forbidden = ["/Volumes/", "/Users/"];
const offenders = [];
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (entry === "ajv") {
        continue;
      }
      walk(path);
      continue;
    }
    if (!path.endsWith(".js") && !path.endsWith(".mjs") && !path.endsWith(".json")) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (forbidden.some((token) => text.includes(token))) {
      offenders.push(relative(stage, path));
    }
  }
}
walk(stage);
if (offenders.length > 0) {
  process.stderr.write(`未签名包含有开发机绝对路径: ${offenders.join(", ")}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ stage, unsigned: true, signed: false })}\n`);

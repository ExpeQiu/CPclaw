import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { checkReport, type ReportCheck, type TaskMode } from "@cpclaw/contracts";

export type DirectoryGrant = { kind: "directory"; path: string };
export type FileGrant = { kind: "file"; path: string };

export type WriteRefusal = {
  ok: false;
  code: "MODE_READONLY" | "OUTSIDE_GRANT" | "SYMLINK_ESCAPE" | "PREFIX_COLLISION" | "FILE_GRANT";
  message: string;
};

function stripTrailingSep(value: string): string {
  if (value.length > 1 && value.endsWith(sep)) {
    return value.slice(0, -1);
  }
  return value;
}

export function isPathInside(grantDir: string, target: string): boolean {
  const grant = stripTrailingSep(grantDir);
  const candidate = stripTrailingSep(target);
  return candidate === grant || candidate.startsWith(`${grant}${sep}`);
}

function existingAncestor(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

export function resolveWriteTarget(grantDir: string, target: string): { ok: true; realTarget: string } | WriteRefusal {
  const grantReal = realpathSync(grantDir);
  const lexicalGrant = stripTrailingSep(grantDir);
  const lexicalTarget = stripTrailingSep(target);
  const sameNamePrefix =
    lexicalTarget.startsWith(lexicalGrant) && !lexicalTarget.startsWith(`${lexicalGrant}${sep}`);
  if (sameNamePrefix) {
    return { ok: false, code: "PREFIX_COLLISION", message: "目标与授权目录只是同名前缀" };
  }
  if (!isPathInside(lexicalGrant, lexicalTarget)) {
    return { ok: false, code: "OUTSIDE_GRANT", message: "目标不在授权目录内" };
  }
  const ancestor = existingAncestor(target);
  const ancestorReal = realpathSync(ancestor);
  if (!isPathInside(grantReal, ancestorReal) && ancestorReal !== grantReal) {
    return { ok: false, code: "SYMLINK_ESCAPE", message: "路径经过指向授权目录外的符号链接" };
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    const linked = realpathSync(target);
    if (!isPathInside(grantReal, linked)) {
      return { ok: false, code: "SYMLINK_ESCAPE", message: "目标符号链接指向授权目录外" };
    }
  }
  const leaf = existsSync(target) ? realpathSync(target) : join(realpathSync(dirname(target)), basename(target));
  if (!isPathInside(grantReal, leaf)) {
    return { ok: false, code: "OUTSIDE_GRANT", message: "解析后的目标不在授权目录内" };
  }
  return { ok: true, realTarget: leaf };
}

export type WriteResult =
  | { ok: true; path: string; overwritten: false; recognizedExisting: boolean; check: ReportCheck }
  | WriteRefusal;

type Journal = {
  target: string;
  phase: "written" | "committed";
  digest: string;
};

function journalPath(grantDir: string): string {
  return join(grantDir, ".cpclaw-write-journal.json");
}

function readJournal(grantDir: string): Journal | undefined {
  const path = journalPath(grantDir);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const target = Reflect.get(parsed, "target");
  const phase = Reflect.get(parsed, "phase");
  const digest = Reflect.get(parsed, "digest");
  if (typeof target !== "string" || (phase !== "written" && phase !== "committed") || typeof digest !== "string") {
    return undefined;
  }
  return { target, phase, digest };
}

export function writeReportFile(input: {
  mode: TaskMode;
  outputDir: string;
  fileName: string;
  body: string;
  materialNames: readonly string[];
}): WriteResult {
  if (input.mode === "ask" || input.mode === "plan") {
    return { ok: false, code: "MODE_READONLY", message: "问答和规划模式不能写文件" };
  }
  const target = join(input.outputDir, input.fileName);
  const resolved = resolveWriteTarget(input.outputDir, target);
  if (!resolved.ok) {
    return resolved;
  }
  const digest = createHash("sha256").update(input.body).digest("hex");
  const journal = readJournal(input.outputDir);
  if (existsSync(resolved.realTarget) && (journal === undefined || journal.phase !== "committed")) {
    const existing = readFileSync(resolved.realTarget, "utf8");
    return {
      ok: true,
      path: resolved.realTarget,
      overwritten: false,
      recognizedExisting: true,
      check: checkReport(existing, input.materialNames),
    };
  }
  mkdirSync(input.outputDir, { recursive: true });
  writeFileSync(resolved.realTarget, input.body, "utf8");
  writeFileSync(journalPath(input.outputDir), `${JSON.stringify({ target: input.fileName, phase: "written", digest })}\n`);
  return {
    ok: true,
    path: resolved.realTarget,
    overwritten: false,
    recognizedExisting: false,
    check: checkReport(input.body, input.materialNames),
  };
}

export function commitReport(outputDir: string): void {
  const journal = readJournal(outputDir);
  if (journal === undefined) {
    return;
  }
  writeFileSync(journalPath(outputDir), `${JSON.stringify({ ...journal, phase: "committed" })}\n`);
}

export function readGrantedFile(grant: FileGrant): { ok: true; text: string } | WriteRefusal {
  const real = realpathSync(grant.path);
  if (dirname(real) === real) {
    return { ok: false, code: "FILE_GRANT", message: "单个文件授权不能访问其父目录" };
  }
  return { ok: true, text: readFileSync(real, "utf8") };
}

export function listParentRejected(grant: FileGrant): WriteRefusal {
  if (grant.kind !== "file") {
    return { ok: false, code: "FILE_GRANT", message: "单个文件授权不能列出父目录" };
  }
  return { ok: false, code: "FILE_GRANT", message: "单个文件授权不能列出父目录" };
}

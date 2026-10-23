import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostLog } from "./host-log.js";

export type SkillInstallFailure = { ok: false; code: string; message: string };

export type InstalledSkill = {
  skillId: string;
  version: string;
  contentSha256: string;
  path: string;
};

function fail(code: string, message: string): SkillInstallFailure {
  return { ok: false, code, message };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 固定版本安装区：先写入暂存，校验通过再原子切换当前指针。
 * 失败保留旧版，不污染正在使用的目录。
 */
export function installSkillPackage(input: {
  dataDir: string;
  skillId: string;
  version: string;
  expectedSha256: string;
  packageBody: string;
  platforms: string[];
}): { ok: true; installed: InstalledSkill; previous?: InstalledSkill } | SkillInstallFailure {
  if (input.skillId.includes("..") || input.version.includes("..") || input.packageBody.includes("..")) {
    return fail("PATH_TRAVERSAL", "Skill 标识或包内容含路径穿越");
  }
  if (!input.platforms.includes("darwin-arm64")) {
    return fail("PLATFORM", "平台不兼容，拒绝安装");
  }
  if (sha256(input.packageBody) !== input.expectedSha256) {
    return fail("DIGEST", "摘要不符，拒绝安装");
  }

  const root = join(input.dataDir, "skills");
  const currentLink = join(root, input.skillId, "current.json");
  mkdirSync(join(root, input.skillId), { recursive: true });

  let previous: InstalledSkill | undefined;
  if (existsSync(currentLink)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(currentLink, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const skillId = Reflect.get(parsed, "skillId");
        const version = Reflect.get(parsed, "version");
        const contentSha256 = Reflect.get(parsed, "contentSha256");
        const path = Reflect.get(parsed, "path");
        if (
          typeof skillId === "string" &&
          typeof version === "string" &&
          typeof contentSha256 === "string" &&
          typeof path === "string"
        ) {
          previous = { skillId, version, contentSha256, path };
        }
      }
    } catch {
      previous = undefined;
    }
  }

  const versionDir = join(root, input.skillId, input.version);
  const stagingDir = join(root, input.skillId, `.staging-${input.version}`);
  try {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "SKILL.md"), input.packageBody, "utf8");
    const actual = sha256(readFileSync(join(stagingDir, "SKILL.md"), "utf8"));
    if (actual !== input.expectedSha256) {
      rmSync(stagingDir, { recursive: true, force: true });
      hostLog(input.dataDir, "warn", "skill_install_digest", "安装校验失败，保留旧版", {
        skillId: input.skillId,
      });
      return fail("DIGEST", "写入后摘要不符，已保留旧版");
    }
    rmSync(versionDir, { recursive: true, force: true });
    renameSync(stagingDir, versionDir);
    const installed: InstalledSkill = {
      skillId: input.skillId,
      version: input.version,
      contentSha256: input.expectedSha256,
      path: versionDir,
    };
    writeFileSync(currentLink, `${JSON.stringify(installed, null, 2)}\n`, "utf8");
    hostLog(input.dataDir, "info", "skill_installed", "Skill 已切换到新版本", {
      skillId: input.skillId,
      version: input.version,
    });
    return previous === undefined ? { ok: true, installed } : { ok: true, installed, previous };
  } catch (error) {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // 暂存清理失败不影响返回。
    }
    const message = error instanceof Error ? error.message : "安装失败";
    hostLog(input.dataDir, "error", "skill_install_failed", "安装失败，保留旧版", {
      skillId: input.skillId,
      reason: message.slice(0, 80),
    });
    return fail("INSTALL", `安装失败，已保留旧版: ${message}`);
  }
}

export function readCurrentSkill(
  dataDir: string,
  skillId: string,
): { ok: true; installed: InstalledSkill } | SkillInstallFailure {
  if (skillId.includes("..")) {
    return fail("PATH_TRAVERSAL", "Skill 标识含路径穿越");
  }
  const currentLink = join(dataDir, "skills", skillId, "current.json");
  if (!existsSync(currentLink)) {
    return fail("NOT_FOUND", "尚未安装该 Skill");
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(currentLink, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return fail("CONFIG_INVALID", "安装指针损坏");
    }
    const version = Reflect.get(parsed, "version");
    const contentSha256 = Reflect.get(parsed, "contentSha256");
    const path = Reflect.get(parsed, "path");
    if (typeof version !== "string" || typeof contentSha256 !== "string" || typeof path !== "string") {
      return fail("CONFIG_INVALID", "安装指针损坏");
    }
    return { ok: true, installed: { skillId, version, contentSha256, path } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    return fail("CONFIG_INVALID", message);
  }
}

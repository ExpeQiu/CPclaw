import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReport } from "@cpclaw/contracts";
import { writeReportFile } from "@cpclaw/desktop-host";
import { buildSyntheticReport } from "@cpclaw/contracts";

export type BaselineCase = {
  id: string;
  kind: "positive" | "negative";
  title: string;
};

export type BaselineObservation = {
  caseId: string;
  passed: boolean;
  elapsedMs: number;
  note: string;
};

export type BaselineReport = {
  schemaVersion: 1;
  mode: "mock";
  cases: BaselineCase[];
  observations: BaselineObservation[];
  /** 费用/时延只记观测，不写达标百分比（Q13）。 */
  costLatency: {
    totalElapsedMs: number;
    note: "未确认门槛，仅记录观测值";
  };
  versionInventory: Array<{ name: string; version: string }>;
  finishedAt: string;
};

const MATERIALS = [
  {
    fileName: "policy-excerpt.md",
    paragraphs: [{ id: "p1", text: "制度要求保留来源" }],
  },
  {
    fileName: "project-note.md",
    paragraphs: [{ id: "p1", text: "项目记录只覆盖本机材料" }],
  },
] as const;

const CASES: BaselineCase[] = [
  { id: "report-structure", kind: "positive", title: "合成报告四节与来源" },
  { id: "report-missing-source", kind: "negative", title: "缺来源的报告被拒绝" },
  { id: "ask-mode-no-write", kind: "negative", title: "问答模式不得写入报告" },
];

/**
 * 确定性业务基线。业务质量与试点门槛未确认前只产出观测，不宣布达标。
 */
export function runBusinessBaseline(input?: {
  versionInventory?: Array<{ name: string; version: string }>;
}): BaselineReport {
  const started = Date.now();
  const root = mkdtempSync(join(tmpdir(), "cpclaw-baseline-"));
  const observations: BaselineObservation[] = [];
  const materialNames = MATERIALS.map((item) => item.fileName);
  const body = buildSyntheticReport({
    goal: "生成带来源的报告",
    materials: MATERIALS.map((item) => ({
      fileName: item.fileName,
      paragraphs: [...item.paragraphs],
    })),
  });

  try {
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });

    const t0 = Date.now();
    const written = writeReportFile({
      mode: "execute",
      outputDir: out,
      fileName: "report.md",
      body,
      materialNames,
    });
    const check = written.ok
      ? checkReport(body, materialNames)
      : { ok: false as const, missing: ["write"] as string[] };
    observations.push({
      caseId: "report-structure",
      passed: written.ok === true && check.ok === true,
      elapsedMs: Date.now() - t0,
      note: written.ok
        ? check.ok
          ? "结构通过"
          : `缺项 ${"missing" in check ? check.missing.join(",") : ""}`
        : "写入失败",
    });

    const t1 = Date.now();
    const badCheck = checkReport("# 标题\n\n没有来源节\n", materialNames);
    observations.push({
      caseId: "report-missing-source",
      passed: badCheck.ok === false,
      elapsedMs: Date.now() - t1,
      note: badCheck.ok ? "错误地通过了缺来源报告" : "正确拒绝",
    });

    const t2 = Date.now();
    const askWrite = writeReportFile({
      mode: "ask",
      outputDir: out,
      fileName: "ask-report.md",
      body,
      materialNames,
    });
    observations.push({
      caseId: "ask-mode-no-write",
      passed: askWrite.ok === false,
      elapsedMs: Date.now() - t2,
      note: askWrite.ok ? "问答模式不应写入" : "正确拒绝写入",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return {
    schemaVersion: 1,
    mode: "mock",
    cases: CASES,
    observations,
    costLatency: {
      totalElapsedMs: Date.now() - started,
      note: "未确认门槛，仅记录观测值",
    },
    versionInventory: input?.versionInventory ?? [
      { name: "cpclaw", version: "0.0.0" },
      { name: "@cpclaw/verification", version: "0.0.1" },
    ],
    finishedAt: new Date().toISOString(),
  };
}

export function baselinePassed(report: BaselineReport): boolean {
  return report.observations.every((item) => item.passed);
}

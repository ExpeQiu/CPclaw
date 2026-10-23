import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyntheticReport, checkReport, type ReportCheck } from "@cpclaw/contracts";
import { writeReportFile, type WriteResult } from "@cpclaw/desktop-host";

export { baselinePassed, runBusinessBaseline } from "./baseline.js";
export type { BaselineCase, BaselineObservation, BaselineReport } from "./baseline.js";

export const SYNTHETIC_MATERIALS = [
  {
    fileName: "policy-excerpt.md",
    paragraphs: [{ id: "p1", text: "制度要求保留来源" }],
  },
  {
    fileName: "project-note.md",
    paragraphs: [{ id: "p1", text: "项目记录只覆盖本机材料" }],
  },
] as const;

export function syntheticReportBody(): string {
  return buildSyntheticReport({
    goal: "生成带来源的报告",
    materials: SYNTHETIC_MATERIALS.map((item) => ({
      fileName: item.fileName,
      paragraphs: [...item.paragraphs],
    })),
  });
}

export function writeSyntheticReport(outputDir: string): WriteResult {
  return writeReportFile({
    mode: "execute",
    outputDir,
    fileName: "report.md",
    body: syntheticReportBody(),
    materialNames: SYNTHETIC_MATERIALS.map((item) => item.fileName),
  });
}

export function checkFixtureReport(outputDir: string): ReportCheck {
  const markdown = readFileSync(join(outputDir, "report.md"), "utf8");
  return checkReport(
    markdown,
    SYNTHETIC_MATERIALS.map((item) => item.fileName),
  );
}

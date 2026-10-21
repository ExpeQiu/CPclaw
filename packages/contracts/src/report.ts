const REQUIRED_SECTIONS = ["任务目标", "材料与来源", "要点", "未覆盖项"] as const;

export type ReportCheck =
  | { ok: true; status: "passed" }
  | { ok: false; status: "failed"; missing: string[] };

export function buildSyntheticReport(input: {
  goal: string;
  materials: { fileName: string; paragraphs: { id: string; text: string }[] }[];
}): string {
  const sources = input.materials
    .flatMap((material) => material.paragraphs.map((paragraph) => `- ${material.fileName}#${paragraph.id}`))
    .join("\n");
  const points = input.materials
    .flatMap((material) =>
      material.paragraphs.map((paragraph) => `- ${paragraph.text}（${material.fileName}#${paragraph.id}）`),
    )
    .join("\n");
  return [
    "# 任务目标",
    "",
    input.goal,
    "",
    "# 材料与来源",
    "",
    sources,
    "",
    "# 要点",
    "",
    points,
    "",
    "# 未覆盖项",
    "",
    "- 企业知识未接入",
    "",
  ].join("\n");
}

export function checkReport(markdown: string, materialNames: readonly string[]): ReportCheck {
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    if (!markdown.includes(`# ${section}`)) {
      missing.push(section);
    }
  }
  for (const name of materialNames) {
    if (!markdown.includes(`${name}#`)) {
      missing.push(`来源 ${name}`);
    }
  }
  if (missing.length > 0) {
    return { ok: false, status: "failed", missing };
  }
  return { ok: true, status: "passed" };
}

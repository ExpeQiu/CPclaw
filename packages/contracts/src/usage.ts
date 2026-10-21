export type TokenUsage =
  | { state: "known"; inputTokens: number; outputTokens: number }
  | { state: "unknown" };

export type ModelCheckKind = "text" | "stream" | "tool" | "cancel" | "timeout";

export type ModelCheckRecord = {
  kind: ModelCheckKind;
  model: "MiniMax-M3";
  usage: TokenUsage;
  note: string;
};

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** 缺字段、null、或无法解析时保持 unknown，不用 0 填平。 */
export function readTokenUsage(input: unknown): TokenUsage {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { state: "unknown" };
  }
  const inputTokens = Reflect.get(input, "prompt_tokens") ?? Reflect.get(input, "inputTokens");
  const outputTokens = Reflect.get(input, "completion_tokens") ?? Reflect.get(input, "outputTokens");
  if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens)) {
    return { state: "unknown" };
  }
  return { state: "known", inputTokens, outputTokens };
}

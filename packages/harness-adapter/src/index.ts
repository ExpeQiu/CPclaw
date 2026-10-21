import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_START_TIMEOUT_MS = 180_000;

const SDK_SPECIFIER: string = "@deepseek-ai/dsh-sdk-client";

type SdkNotification = { method: string; params: Record<string, unknown> };

type SdkHarness = {
  run(
    input: string,
    options?: { onNotification?: (notification: SdkNotification) => void },
  ): Promise<{ finalResponse: string }>;
  close(): Promise<void>;
};

type SdkModule = {
  DeepSeekHarness: new (options: Record<string, unknown>) => SdkHarness;
};

function isSdkModule(value: unknown): value is SdkModule {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "DeepSeekHarness") === "function";
}

async function loadSdk(): Promise<SdkModule> {
  const loaded: unknown = await import(SDK_SPECIFIER);
  if (!isSdkModule(loaded)) {
    throw new Error("未能从 @deepseek-ai/dsh-sdk-client 加载 DeepSeekHarness");
  }
  return loaded;
}

export type StreamMeasurement = {
  commit: string;
  streamEnded: boolean;
  finalResponse: string;
  notificationCount: number;
  trace: string[];
  childEnvNames: string[];
  childCommandSeenAfterClose: boolean;
};

export function readHarnessCommit(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export function writeMockProviderHome(homeDir: string, baseUrl: string): void {
  mkdirSync(homeDir, { recursive: true });
  const settings = [
    "llm-pi-ai:",
    "  providers:",
    "    cpclaw-mock:",
    "      apiKeyEnv: CPCLAW_MOCK_LLM_KEY",
    "      api: openai-completions",
    "      baseURL: " + baseUrl,
    "      models:",
    "        - id: mock-text",
    "",
  ].join("\n");
  writeFileSync(join(homeDir, "settings.yaml"), settings, "utf8");
  writeFileSync(join(homeDir, "cpclaw-marker.patch.yml"), "[]\n", "utf8");
}

function markerPatch(homeDir: string): string {
  return join(homeDir, "cpclaw-marker.patch.yml");
}

function scrubbedEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    DSH_HOME: homeDir,
    CPCLAW_MOCK_LLM_KEY: "local-mock",
  };
  return env;
}

export async function runTextStream(input: {
  harnessRoot: string;
  dshHome: string;
  baseUrl: string;
  prompt: string;
}): Promise<StreamMeasurement> {
  const commit = readHarnessCommit(input.harnessRoot);
  writeMockProviderHome(input.dshHome, input.baseUrl);
  const sdk = await loadSdk();
  const harness = new sdk.DeepSeekHarness({
    profile: "sdk",
    provider: "cpclaw-mock",
    model: "mock-text",
    cwd: input.dshHome,
    dshHome: input.dshHome,
    processCwd: input.dshHome,
    patches: [markerPatch(input.dshHome)],
    env: scrubbedEnv(input.dshHome),
    initializeTimeoutMs: SOURCE_START_TIMEOUT_MS,
    requestTimeoutMs: 60_000,
  });
  let notificationCount = 0;
  const trace: string[] = [];
  let streamEnded = false;
  try {
    const result = await harness.run(input.prompt, {
      onNotification: (notification) => {
        notificationCount += 1;
        const event = notification.params.event;
        const eventType = typeof event === "object" && event !== null && typeof Reflect.get(event, "type") === "string"
          ? String(Reflect.get(event, "type"))
          : "";
        if (eventType === "turn/end" && typeof event === "object" && event !== null) {
          const data: unknown = Reflect.get(event, "data");
          const detail = typeof data === "object" && data !== null ? JSON.stringify(data) : "";
          trace.push(`${notification.method}:${eventType}:${detail}`);
        } else {
          trace.push(eventType === "" ? notification.method : `${notification.method}:${eventType}`);
        }
      },
    });
    streamEnded = true;
    await harness.close();
    return {
      commit,
      streamEnded,
      finalResponse: result.finalResponse,
      notificationCount,
      trace,
      childEnvNames: Object.keys(scrubbedEnv(input.dshHome)),
      childCommandSeenAfterClose: processStillMentions(markerPatch(input.dshHome)),
    };
  } catch (error) {
    await harness.close().catch(() => undefined);
    throw error;
  }
}

function processStillMentions(marker: string): boolean {
  try {
    const listing = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
    return listing.includes(marker);
  } catch {
    return true;
  }
}

export async function cancelHarness(input: {
  harnessRoot: string;
  dshHome: string;
  baseUrl: string;
}): Promise<{ closed: boolean; runRejected: boolean; childCommandSeenAfterClose: boolean }> {
  writeMockProviderHome(input.dshHome, input.baseUrl);
  const sdk = await loadSdk();
  const harness = new sdk.DeepSeekHarness({
    profile: "sdk",
    provider: "cpclaw-mock",
    model: "mock-text",
    cwd: input.dshHome,
    dshHome: input.dshHome,
    patches: [markerPatch(input.dshHome)],
    env: scrubbedEnv(input.dshHome),
    initializeTimeoutMs: SOURCE_START_TIMEOUT_MS,
    requestTimeoutMs: 60_000,
  });
  let sawRequest = false;
  const run = harness.run("请保持这条生成不要结束", {
    onNotification: (notification) => {
      const event = notification.params.event;
      const eventType = typeof event === "object" && event !== null && typeof Reflect.get(event, "type") === "string"
        ? String(Reflect.get(event, "type"))
        : "";
      if (eventType === "request/header") {
        sawRequest = true;
      }
    },
  });
  const requested = new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (sawRequest) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 60_000) {
        clearInterval(timer);
        reject(new Error("取消前没有等到模型请求"));
      }
    }, 30);
  });
  try {
    await Promise.race([
      requested,
      run.then(() => Promise.reject(new Error("取消前回合已经结束"))),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await harness.close();
  } catch (error) {
    await harness.close().catch(() => undefined);
    throw error;
  }
  let runRejected = false;
  try {
    await run;
  } catch {
    runRejected = true;
  }
  return {
    closed: true,
    runRejected,
    childCommandSeenAfterClose: processStillMentions(markerPatch(input.dshHome)),
  };
}

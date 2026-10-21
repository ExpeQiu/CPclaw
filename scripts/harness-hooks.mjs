import { join } from "node:path";
import { pathToFileURL } from "node:url";

let harnessRoot = "";

export function initialize(data) {
  if (typeof data === "object" && data !== null && typeof Reflect.get(data, "harnessRoot") === "string") {
    harnessRoot = Reflect.get(data, "harnessRoot");
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@deepseek-ai/dsh-sdk-client" && harnessRoot !== "") {
    return {
      url: pathToFileURL(join(harnessRoot, "packages/sdk/client/src/index.ts")).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

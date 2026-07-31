import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseCliArguments,
  prepareDraftRelease,
} from "./publish-release.mjs";

export async function runStageReleaseDraft(argumentsList, dependencies = {}) {
  return prepareDraftRelease(parseCliArguments(argumentsList), dependencies);
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    const result = await runStageReleaseDraft(process.argv.slice(2));
    console.log(
      `Draft Release 已冻结: ${result.tag}；release_id=${result.releaseId}`,
    );
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `release_id=${result.releaseId}\nrelease_tag=${result.tag}\n`,
        "utf8",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Draft Release 准备失败: ${message}`);
    process.exitCode = 1;
  }
}

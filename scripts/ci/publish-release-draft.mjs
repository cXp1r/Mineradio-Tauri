import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  finalizeDraftRelease,
  parseCliArguments,
} from "./publish-release.mjs";

export async function runPublishReleaseDraft(argumentsList, dependencies = {}) {
  const [releaseIdText, expectedCandidateId, ...releaseArguments] = argumentsList;
  if (
    !/^[1-9]\d*$/.test(releaseIdText ?? "") ||
    !/^[0-9a-f]{64}$/.test(expectedCandidateId ?? "")
  ) {
    throw new Error(
      "用法: publish-release-draft.mjs <release-id> <expected-candidate-id> <release arguments>",
    );
  }
  const releaseId = Number(releaseIdText);
  if (!Number.isSafeInteger(releaseId)) {
    throw new Error("release id 超过安全整数范围");
  }
  return finalizeDraftRelease(
    parseCliArguments(releaseArguments),
    releaseId,
    expectedCandidateId,
    dependencies,
  );
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    const result = await runPublishReleaseDraft(process.argv.slice(2));
    console.log(
      `Release 公开完成: ${result.tag}；Latest=${result.latestTag}；release_id=${result.releaseId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Release 公开失败: ${message}`);
    process.exitCode = 1;
  }
}

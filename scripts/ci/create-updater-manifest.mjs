import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseReleaseTag } from "./verify-release-version.mjs";

const DEFAULT_NOTES = "See the GitHub release notes.";
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export function createUpdaterManifest({
  tag,
  repository,
  assetName,
  signature,
  pubDate = new Date().toISOString(),
  notes = DEFAULT_NOTES,
}) {
  const version = parseReleaseTag(tag);

  if (
    typeof repository !== "string" ||
    !REPOSITORY_PATTERN.test(repository)
  ) {
    throw new Error("仓库必须使用 owner/name 格式");
  }

  const signatureText = typeof signature === "string" ? signature : "";

  if (signatureText.trim().length === 0) {
    throw new Error("签名不能为空");
  }

  const expectedAssetName = `MineRadio-Tauri_${version}_x64-setup.exe`;

  if (assetName !== expectedAssetName) {
    throw new Error(`安装包文件名必须为 ${expectedAssetName}`);
  }

  const platform = {
    signature: signatureText,
    url: `https://github.com/${repository}/releases/download/${tag}/${assetName}`,
  };

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64-nsis": platform,
      "windows-x86_64": platform,
    },
  };
}

function assertRegularFile(filePath, label) {
  let statistics;

  try {
    statistics = statSync(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`${label}不存在: ${filePath}`);
    }

    throw error;
  }

  if (!statistics.isFile()) {
    throw new Error(`${label}不是文件: ${filePath}`);
  }
}

function runCli() {
  const [tag, repository, exePath, signaturePath, outputPath] =
    process.argv.slice(2);

  if (
    [tag, repository, exePath, signaturePath, outputPath].some(
      (argument) => typeof argument !== "string" || argument.length === 0,
    )
  ) {
    throw new Error(
      "用法: create-updater-manifest.mjs <tag> <repository> <exePath> <signaturePath> <outputPath>",
    );
  }

  assertRegularFile(exePath, "安装包文件");
  assertRegularFile(signaturePath, "签名文件");

  const manifest = createUpdaterManifest({
    tag,
    repository,
    assetName: basename(exePath),
    signature: readFileSync(signaturePath, "utf8"),
  });

  writeFileSync(
    outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`创建 updater manifest 失败: ${message}`);
    process.exitCode = 1;
  }
}

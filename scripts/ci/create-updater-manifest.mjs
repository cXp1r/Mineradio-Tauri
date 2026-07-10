import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseReleaseTag } from "./verify-release-version.mjs";

const DEFAULT_NOTES = "See the GitHub release notes.";
const REPOSITORY_PATTERN =
  /^(?=.{1,39}\/)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/(?=.{1,100}$)(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

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

  return statistics;
}

function readUtf8FileStrict(filePath, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(filePath),
    );
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`${label}不是有效的 UTF-8: ${filePath}`);
    }

    throw error;
  }
}

function normalizePathForComparison(filePath) {
  const normalizedPath = resolve(filePath);
  return process.platform === "win32"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function pathsAlias(leftPath, rightPath) {
  if (
    normalizePathForComparison(leftPath) ===
    normalizePathForComparison(rightPath)
  ) {
    return true;
  }

  try {
    const leftStatistics = statSync(leftPath);
    const rightStatistics = statSync(rightPath);
    return (
      leftStatistics.dev === rightStatistics.dev &&
      leftStatistics.ino === rightStatistics.ino
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function runCli() {
  const cliArguments = process.argv.slice(2);
  const [tag, repository, exePath, signaturePath, outputPath] = cliArguments;

  if (
    cliArguments.length !== 5 ||
    cliArguments.some(
      (argument) => typeof argument !== "string" || argument.length === 0,
    )
  ) {
    throw new Error(
      "用法: create-updater-manifest.mjs <tag> <repository> <exePath> <signaturePath> <outputPath>",
    );
  }

  if (
    [exePath, signaturePath].some(
      (inputPath) => pathsAlias(inputPath, outputPath),
    )
  ) {
    throw new Error(`输出路径不能覆盖输入文件: ${outputPath}`);
  }

  const exeStatistics = assertRegularFile(exePath, "安装包文件");

  if (exeStatistics.size <= 0) {
    throw new Error(`安装包文件不能为空: ${exePath}`);
  }

  assertRegularFile(signaturePath, "签名文件");

  const manifest = createUpdaterManifest({
    tag,
    repository,
    assetName: basename(exePath),
    signature: readUtf8FileStrict(signaturePath, "签名文件"),
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

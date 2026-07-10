import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY_PATTERN =
  /^(?=.{1,39}\/)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/(?=.{1,100}$)(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const RELEASE_TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PROVENANCE_FIELDS = [
  "schema_version",
  "repository",
  "tag",
  "commit_sha",
  "assets",
];
const ASSET_FIELDS = ["name", "size", "sha256"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value, expectedFields) {
  const actualFields = Object.keys(value).sort();
  const sortedExpectedFields = [...expectedFields].sort();

  return (
    actualFields.length === sortedExpectedFields.length &&
    actualFields.every((field, index) => field === sortedExpectedFields[index])
  );
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateProvenanceTopLevel(provenance) {
  if (!isJsonObject(provenance)) {
    throw new Error("来源证明必须是 JSON 对象");
  }

  if (!hasExactFields(provenance, PROVENANCE_FIELDS)) {
    throw new Error(
      `来源证明顶层字段必须恰好为: ${PROVENANCE_FIELDS.join(", ")}`,
    );
  }

  if (provenance.schema_version !== 1) {
    throw new Error("来源证明 schema_version 必须为 1");
  }

  if (
    typeof provenance.repository !== "string" ||
    !REPOSITORY_PATTERN.test(provenance.repository)
  ) {
    throw new Error("来源证明 repository 字段格式无效");
  }

  if (
    typeof provenance.tag !== "string" ||
    !RELEASE_TAG_PATTERN.test(provenance.tag)
  ) {
    throw new Error("来源证明 tag 字段格式无效");
  }

  if (
    typeof provenance.commit_sha !== "string" ||
    !COMMIT_SHA_PATTERN.test(provenance.commit_sha)
  ) {
    throw new Error("来源证明 commit_sha 字段格式无效");
  }

  if (!Array.isArray(provenance.assets)) {
    throw new Error("来源证明 assets 字段必须是数组");
  }

  provenance.assets.forEach((asset, index) => {
    if (!isJsonObject(asset)) {
      throw new Error(`来源证明 assets[${index}] 必须是 JSON 对象`);
    }

    if (!hasExactFields(asset, ASSET_FIELDS)) {
      throw new Error(
        `来源证明 assets[${index}] 字段必须恰好为: ${ASSET_FIELDS.join(", ")}`,
      );
    }

    if (typeof asset.name !== "string" || asset.name.trim().length === 0) {
      throw new Error(`来源证明 assets[${index}].name 必须是非空字符串`);
    }

    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`来源证明 assets[${index}].size 必须是正整数`);
    }

    if (
      typeof asset.sha256 !== "string" ||
      !SHA256_PATTERN.test(asset.sha256)
    ) {
      throw new Error(
        `来源证明 assets[${index}].sha256 必须是 64 位小写十六进制`,
      );
    }
  });

  validateExactAssetNames(
    provenance.assets.map((asset) => asset.name),
    provenance.tag.slice(1),
    {
      duplicate: "来源证明资产名称重复",
      missing: "来源证明资产集合缺少",
      extra: "来源证明资产集合存在额外资产",
    },
  );

  const assetNames = provenance.assets.map((asset) => asset.name);
  const sortedAssetNames = [...assetNames].sort(compareNames);

  if (assetNames.some((name, index) => name !== sortedAssetNames[index])) {
    throw new Error("来源证明 assets 必须按 name 升序排列");
  }
}

function parseReleaseTag(tag) {
  const releaseTag = typeof tag === "string" ? tag : "";

  if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error(`发布标签 "${releaseTag}" 格式无效，必须匹配 vX.Y.Z`);
  }

  return releaseTag.slice(1);
}

function expectedAssetNames(version) {
  const executableName = `MineRadio-Tauri_${version}_x64-setup.exe`;

  return [executableName, `${executableName}.sig`, "latest.json"];
}

function validateExactAssetNames(names, version, messages) {
  const seenNames = new Set();

  for (const name of names) {
    if (seenNames.has(name)) {
      throw new Error(`${messages.duplicate}: ${name}`);
    }

    seenNames.add(name);
  }

  const requiredNames = expectedAssetNames(version);
  const missingNames = requiredNames.filter((name) => !seenNames.has(name));

  if (missingNames.length > 0) {
    throw new Error(`${messages.missing}: ${missingNames.join(", ")}`);
  }

  const requiredNameSet = new Set(requiredNames);
  const extraNames = names.filter((name) => !requiredNameSet.has(name)).sort();

  if (extraNames.length > 0) {
    throw new Error(`${messages.extra}: ${extraNames.join(", ")}`);
  }
}

function validateAssetPathNames(assetPaths, version) {
  validateExactAssetNames(
    assetPaths.map((assetPath) => basename(assetPath)),
    version,
    {
      duplicate: "发布资产名称重复",
      missing: "发布资产集合缺少",
      extra: "发布资产集合存在额外资产",
    },
  );
}

function readAssetContent(assetPath) {
  let statistics;

  try {
    statistics = statSync(assetPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`发布资产不存在: ${assetPath}`);
    }

    throw error;
  }

  if (!statistics.isFile()) {
    throw new Error(`发布资产不是普通文件: ${assetPath}`);
  }

  const content = readFileSync(assetPath);

  if (content.byteLength === 0) {
    throw new Error(`发布资产不能为空: ${assetPath}`);
  }

  return content;
}

export function createReleaseProvenance({
  repository,
  tag,
  commitSha,
  assetPaths,
}) {
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
    throw new Error("仓库必须使用严格的 owner/name 格式");
  }

  const version = parseReleaseTag(tag);

  if (typeof commitSha !== "string" || !COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new Error("提交 SHA 必须是 40 位小写十六进制");
  }

  validateAssetPathNames(assetPaths, version);

  const assets = assetPaths
    .map((assetPath) => {
      const content = readAssetContent(assetPath);

      return {
        name: basename(assetPath),
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    })
    .sort((left, right) => compareNames(left.name, right.name));

  return {
    schema_version: 1,
    repository,
    tag,
    commit_sha: commitSha,
    assets,
  };
}

export function verifyReleaseProvenance({
  provenance,
  repository,
  tag,
  commitSha,
  assetPaths,
}) {
  validateProvenanceTopLevel(provenance);

  if (provenance.repository !== repository) {
    throw new Error(
      `来源证明仓库不一致: provenance=${provenance.repository}, expected=${repository}`,
    );
  }

  if (provenance.tag !== tag) {
    throw new Error(
      `来源证明标签不一致: provenance=${provenance.tag}, expected=${tag}`,
    );
  }

  if (provenance.commit_sha !== commitSha) {
    throw new Error(
      `来源证明提交 SHA 不一致: provenance=${provenance.commit_sha}, expected=${commitSha}`,
    );
  }

  const localAssets = createReleaseProvenance({
    repository,
    tag,
    commitSha,
    assetPaths,
  }).assets;
  const provenanceAssets = new Map(
    provenance.assets.map((asset) => [asset.name, asset]),
  );

  for (const localAsset of localAssets) {
    const provenanceAsset = provenanceAssets.get(localAsset.name);

    if (provenanceAsset.size !== localAsset.size) {
      throw new Error(
        `资产 ${localAsset.name} size 不一致: provenance=${provenanceAsset.size}, local=${localAsset.size}`,
      );
    }

    if (provenanceAsset.sha256 !== localAsset.sha256) {
      throw new Error(
        `资产 ${localAsset.name} sha256 不一致: provenance=${provenanceAsset.sha256}, local=${localAsset.sha256}`,
      );
    }
  }

  return provenance;
}

const CLI_USAGE = [
  "用法:",
  "  release-provenance.mjs create <repository> <tag> <commitSha> <outputPath> <exePath> <exeSigPath> <manifestPath>",
  "  release-provenance.mjs verify <repository> <tag> <commitSha> <provenancePath> <exePath> <exeSigPath> <manifestPath>",
].join("\n");

function runCli() {
  const [command, ...arguments_] = process.argv.slice(2);

  if (
    command === "create" &&
    arguments_.length === 7 &&
    arguments_.every((argument) => argument.length > 0)
  ) {
    const [
      repository,
      tag,
      commitSha,
      outputPath,
      executablePath,
      signaturePath,
      manifestPath,
    ] = arguments_;
    const assetPaths = [executablePath, signaturePath, manifestPath];
    if (
      assetPaths.some(
        (assetPath) => pathsAlias(assetPath, outputPath),
      )
    ) {
      throw new Error(`输出路径不能覆盖发布资产输入文件: ${outputPath}`);
    }

    const provenance = createReleaseProvenance({
      repository,
      tag,
      commitSha,
      assetPaths,
    });

    writeFileSync(
      outputPath,
      `${JSON.stringify(provenance, null, 2)}\n`,
      "utf8",
    );
    console.log(`发布来源证明已创建: ${outputPath}`);
    return;
  }

  if (
    command === "verify" &&
    arguments_.length === 7 &&
    arguments_.every((argument) => argument.length > 0)
  ) {
    const [
      repository,
      tag,
      commitSha,
      provenancePath,
      executablePath,
      signaturePath,
      manifestPath,
    ] = arguments_;
    let rawProvenance;

    try {
      rawProvenance = new TextDecoder("utf-8", { fatal: true }).decode(
        readFileSync(provenancePath),
      );
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`来源证明 JSON 不是有效的 UTF-8: ${provenancePath}`);
      }

      throw error;
    }

    let provenance;

    try {
      provenance = JSON.parse(rawProvenance);
    } catch {
      throw new Error(`来源证明 JSON 格式无效: ${provenancePath}`);
    }

    verifyReleaseProvenance({
      provenance,
      repository,
      tag,
      commitSha,
      assetPaths: [executablePath, signaturePath, manifestPath],
    });
    console.log(`发布来源证明验证通过: ${provenance.assets.length} 个资产`);
    return;
  }

  throw new Error(CLI_USAGE);
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`发布来源证明操作失败: ${message}`);
    process.exitCode = 1;
  }
}

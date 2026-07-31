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
  "platform",
  "package_type",
  "install_mode",
  "installer",
];
const INSTALLER_FIELDS = ["name", "size", "sha256"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVENANCE_PLATFORM = "windows-x86_64";
const PROVENANCE_PACKAGE_TYPE = "nsis";
const PROVENANCE_INSTALL_MODE = "currentUser";

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

function validateProvenanceTopLevel(provenance) {
  if (!isJsonObject(provenance)) {
    throw new Error("来源证明必须是 JSON 对象");
  }

  if (!hasExactFields(provenance, PROVENANCE_FIELDS)) {
    throw new Error(
      `来源证明顶层字段必须恰好为: ${PROVENANCE_FIELDS.join(", ")}`,
    );
  }

  if (provenance.schema_version !== 2) {
    throw new Error("来源证明 schema_version 必须为 2");
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

  if (provenance.platform !== PROVENANCE_PLATFORM) {
    throw new Error(`来源证明 platform 必须为 ${PROVENANCE_PLATFORM}`);
  }

  if (provenance.package_type !== PROVENANCE_PACKAGE_TYPE) {
    throw new Error(
      `来源证明 package_type 必须为 ${PROVENANCE_PACKAGE_TYPE}`,
    );
  }

  if (provenance.install_mode !== PROVENANCE_INSTALL_MODE) {
    throw new Error(
      `来源证明 install_mode 必须为 ${PROVENANCE_INSTALL_MODE}`,
    );
  }

  if (!isJsonObject(provenance.installer)) {
    throw new Error("来源证明 installer 必须是 JSON 对象");
  }

  if (!hasExactFields(provenance.installer, INSTALLER_FIELDS)) {
    throw new Error(
      `来源证明 installer 字段必须恰好为: ${INSTALLER_FIELDS.join(", ")}`,
    );
  }

  const expectedInstallerName = `MineRadio-Tauri_${provenance.tag.slice(1)}_x64-setup.exe`;
  if (provenance.installer.name !== expectedInstallerName) {
    throw new Error(`来源证明 installer.name 必须为 ${expectedInstallerName}`);
  }

  if (
    !Number.isSafeInteger(provenance.installer.size) ||
    provenance.installer.size <= 0
  ) {
    throw new Error("来源证明 installer.size 必须是正安全整数");
  }

  if (
    typeof provenance.installer.sha256 !== "string" ||
    !SHA256_PATTERN.test(provenance.installer.sha256)
  ) {
    throw new Error("来源证明 installer.sha256 必须是 64 位小写十六进制");
  }
}

export function canonicalReleaseProvenanceText(provenance) {
  validateProvenanceTopLevel(provenance);
  const canonical = {
    schema_version: provenance.schema_version,
    repository: provenance.repository,
    tag: provenance.tag,
    commit_sha: provenance.commit_sha,
    platform: provenance.platform,
    package_type: provenance.package_type,
    install_mode: provenance.install_mode,
    installer: {
      name: provenance.installer.name,
      size: provenance.installer.size,
      sha256: provenance.installer.sha256,
    },
  };
  return `${JSON.stringify(canonical)}\n`;
}

export function releaseProvenanceDigest(provenance) {
  return createHash("sha256")
    .update(canonicalReleaseProvenanceText(provenance), "utf8")
    .digest("hex");
}

function signatureIdentity(signature, label) {
  if (typeof signature !== "string" || signature.trim().length === 0) {
    throw new Error(`${label}必须是非空字符串`);
  }
  return createHash("sha256").update(signature, "utf8").digest("hex");
}

export function canonicalReleaseCandidateIdentityText({
  provenance,
  version,
  installerSignature,
  provenanceSignature,
}) {
  canonicalReleaseProvenanceText(provenance);
  const expectedVersion = provenance.tag.slice(1);
  if (version !== expectedVersion) {
    throw new Error(
      `候选版本与 provenance tag 不一致: version=${version}, expected=${expectedVersion}`,
    );
  }

  const identity = {
    schema_version: 1,
    repository: provenance.repository,
    tag: provenance.tag,
    version,
    asset_name: provenance.installer.name,
    target: "windows-x86_64-nsis",
    provenance_sha256: releaseProvenanceDigest(provenance),
    installer_signature_sha256: signatureIdentity(
      installerSignature,
      "安装包签名",
    ),
    provenance_signature_sha256: signatureIdentity(
      provenanceSignature,
      "provenance 签名",
    ),
  };
  return `${JSON.stringify(identity)}\n`;
}

export function createReleaseCandidateIdentity(input) {
  return createHash("sha256")
    .update(canonicalReleaseCandidateIdentityText(input), "utf8")
    .digest("hex");
}

export function parseCanonicalReleaseProvenance(rawProvenance) {
  if (typeof rawProvenance !== "string") {
    throw new Error("来源证明原始内容必须是 UTF-8 字符串");
  }

  if (rawProvenance.startsWith("\uFEFF")) {
    throw new Error("来源证明不是 canonical provenance v2 编码");
  }

  let provenance;
  try {
    provenance = JSON.parse(rawProvenance);
  } catch {
    throw new Error("来源证明 JSON 格式无效");
  }

  const canonical = canonicalReleaseProvenanceText(provenance);
  if (rawProvenance !== canonical) {
    throw new Error("来源证明不是 canonical provenance v2 编码");
  }
  return provenance;
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

  const assetContents = new Map(
    assetPaths.map((assetPath) => [basename(assetPath), readAssetContent(assetPath)]),
  );
  const installerName = expectedAssetNames(version)[0];
  const installerContent = assetContents.get(installerName);

  return {
    schema_version: 2,
    repository,
    tag,
    commit_sha: commitSha,
    platform: PROVENANCE_PLATFORM,
    package_type: PROVENANCE_PACKAGE_TYPE,
    install_mode: PROVENANCE_INSTALL_MODE,
    installer: {
      name: installerName,
      size: installerContent.byteLength,
      sha256: createHash("sha256").update(installerContent).digest("hex"),
    },
  };
}

export function verifyReleaseProvenance({
  rawProvenance,
  repository,
  tag,
  commitSha,
  assetPaths,
}) {
  const verifiedProvenance = parseCanonicalReleaseProvenance(rawProvenance);

  if (verifiedProvenance.repository !== repository) {
    throw new Error(
      `来源证明仓库不一致: provenance=${verifiedProvenance.repository}, expected=${repository}`,
    );
  }

  if (verifiedProvenance.tag !== tag) {
    throw new Error(
      `来源证明标签不一致: provenance=${verifiedProvenance.tag}, expected=${tag}`,
    );
  }

  if (verifiedProvenance.commit_sha !== commitSha) {
    throw new Error(
      `来源证明提交 SHA 不一致: provenance=${verifiedProvenance.commit_sha}, expected=${commitSha}`,
    );
  }

  const localInstaller = createReleaseProvenance({
    repository,
    tag,
    commitSha,
    assetPaths,
  }).installer;

  if (verifiedProvenance.installer.size !== localInstaller.size) {
    throw new Error(
      `安装包 ${localInstaller.name} size 不一致: provenance=${verifiedProvenance.installer.size}, local=${localInstaller.size}`,
    );
  }

  if (verifiedProvenance.installer.sha256 !== localInstaller.sha256) {
    throw new Error(
      `安装包 ${localInstaller.name} sha256 不一致: provenance=${verifiedProvenance.installer.sha256}, local=${localInstaller.sha256}`,
    );
  }

  return verifiedProvenance;
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
      canonicalReleaseProvenanceText(provenance),
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
      rawProvenance = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(readFileSync(provenancePath));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`来源证明 JSON 不是有效的 UTF-8: ${provenancePath}`);
      }

      throw error;
    }

    verifyReleaseProvenance({
      rawProvenance,
      repository,
      tag,
      commitSha,
      assetPaths: [executablePath, signaturePath, manifestPath],
    });
    console.log("发布来源证明验证通过: provenance v2");
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

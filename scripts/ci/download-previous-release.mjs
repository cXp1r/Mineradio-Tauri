import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  openReleaseAssetResponse,
  writeVerifiedReleaseAsset,
} from "./download-draft-release.mjs";

const OFFICIAL_REPOSITORY = "zzstar101/Mineradio-Tauri";
const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const INSTALLER_LIMIT = 512 * 1024 * 1024;
const SIGNATURE_LIMIT = 16 * 1024;

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

function parseVersion(tag) {
  const match = TAG_PATTERN.exec(tag ?? "");
  return match
    ? { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]) }
    : null;
}

function compareVersion(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

function validateInput(input, environment) {
  if (input.repository !== OFFICIAL_REPOSITORY) {
    throw new Error("N−1 smoke 只允许固定官方仓库");
  }
  const currentVersion = parseVersion(input.currentTag);
  if (!currentVersion) {
    throw new Error("当前 tag 必须是严格稳定版本");
  }
  if (
    typeof input.stagingDirectory !== "string" ||
    !isAbsolute(input.stagingDirectory)
  ) {
    throw new Error("N−1 staging 必须是绝对路径");
  }
  const token = environment?.GITHUB_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("环境变量 GITHUB_TOKEN 不能为空");
  }
  return { currentVersion, token };
}

async function listAllReleases(fetchImplementation, repository, token) {
  const releases = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const response = await fetchImplementation(
      `${API_ROOT}/repos/${repository}/releases?per_page=100&page=${page}`,
      { method: "GET", headers: apiHeaders(token), redirect: "error" },
    );
    if (!response.ok) {
      throw new Error(`读取 N−1 Release 返回 HTTP ${response.status}`);
    }
    const values = await response.json();
    if (!Array.isArray(values)) {
      throw new Error("N−1 Release 列表不是数组");
    }
    releases.push(...values);
    if (values.length < 100) {
      return releases;
    }
  }
  throw new Error("N−1 Release 分页超过安全上限");
}

function selectPreviousRelease(releases, currentVersion) {
  const stable = releases
    .filter((release) => release?.draft === false && release?.prerelease === false)
    .map((release) => ({ release, version: parseVersion(release.tag_name) }))
    .filter((entry) => entry.version);
  const conflicting = stable.find(
    (entry) => compareVersion(entry.version, currentVersion) >= 0,
  );
  if (conflicting) {
    throw new Error(
      `已存在不低于候选版的正式 Release: ${conflicting.release.tag_name}`,
    );
  }
  const candidates = stable.sort((left, right) =>
    compareVersion(right.version, left.version),
  );
  const previous = candidates[0]?.release;
  if (!previous) {
    throw new Error("找不到严格低于候选版的 N−1 正式 Release");
  }
  if (!Number.isSafeInteger(previous.id) || previous.id <= 0) {
    throw new Error("N−1 Release identity 无效");
  }
  const assets = new Map();
  for (const asset of previous.assets ?? []) {
    if (assets.has(asset?.name)) {
      throw new Error("N−1 Release 资产名称重复");
    }
    assets.set(asset?.name, asset);
  }
  const version = previous.tag_name.slice(1);
  const installerName = `MineRadio-Tauri_${version}_x64-setup.exe`;
  const required = new Map([
    [installerName, INSTALLER_LIMIT],
    [`${installerName}.sig`, SIGNATURE_LIMIT],
  ]);
  for (const [name, limit] of required) {
    const asset = assets.get(name);
    if (
      asset?.state !== "uploaded" ||
      !Number.isSafeInteger(asset?.id) ||
      asset.id <= 0 ||
      !Number.isSafeInteger(asset?.size) ||
      asset.size <= 0 ||
      asset.size > limit ||
      !DIGEST_PATTERN.test(asset?.digest ?? "")
    ) {
      throw new Error("N−1 Release 缺少有效 installer 或签名资产");
    }
  }
  return { previous, assets, required };
}

export async function downloadPreviousRelease(input, dependencies = {}) {
  const environment = dependencies.env ?? process.env;
  const { currentVersion, token } = validateInput(input, environment);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("当前运行时不支持 fetch");
  }
  const { previous, assets, required } = selectPreviousRelease(
    await listAllReleases(fetchImplementation, input.repository, token),
    currentVersion,
  );
  const stagingDirectory = resolve(input.stagingDirectory);
  mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 });
  try {
    const version = previous.tag_name.slice(1);
    const installerName = `MineRadio-Tauri_${version}_x64-setup.exe`;
    const selectedNames = [installerName, `${installerName}.sig`];
    const downloaded = [];
    for (const name of selectedNames) {
      const asset = assets.get(name);
      const response = await openReleaseAssetResponse(
        fetchImplementation,
        input.repository,
        token,
        asset,
      );
      const outputPath = resolve(stagingDirectory, name);
      await writeVerifiedReleaseAsset(
        response,
        asset,
        outputPath,
        required.get(name),
      );
      downloaded.push(outputPath);
    }
    return {
      releaseId: previous.id,
      version,
      installerPath: downloaded[0],
      signaturePath: downloaded[1],
    };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    const [repository, currentTag, stagingDirectory] = process.argv.slice(2);
    if (!repository || !currentTag || !stagingDirectory || process.argv.length !== 5) {
      throw new Error(
        "用法: download-previous-release.mjs <repository> <current-tag> <absolute-staging-directory>",
      );
    }
    const result = await downloadPreviousRelease({
      repository,
      currentTag,
      stagingDirectory,
    });
    console.log(`N−1 Release staging 完成: version=${result.version}`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `previous_version=${result.version}\nprevious_installer=${result.installerPath}\nprevious_signature=${result.signaturePath}\n`,
        "utf8",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`N−1 Release staging 失败: ${message}`);
    process.exitCode = 1;
  }
}

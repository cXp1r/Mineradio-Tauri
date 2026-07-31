import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OFFICIAL_REPOSITORY = "zzstar101/Mineradio-Tauri";
const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const RELEASE_ASSET_HOST = "release-assets.githubusercontent.com";
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
const METADATA_LIMIT = 256 * 1024;
const SIGNATURE_LIMIT = 16 * 1024;
const INSTALLER_LIMIT = 512 * 1024 * 1024;

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

function validateInput(input, environment) {
  if (input.repository !== OFFICIAL_REPOSITORY) {
    throw new Error("Draft smoke 只允许固定官方仓库");
  }
  if (!TAG_PATTERN.test(input.tag ?? "")) {
    throw new Error("Draft smoke tag 必须是严格稳定版本");
  }
  if (!COMMIT_PATTERN.test(input.commitSha ?? "")) {
    throw new Error("Draft smoke commit SHA 无效");
  }
  if (!Number.isSafeInteger(input.releaseId) || input.releaseId <= 0) {
    throw new Error("Draft smoke release id 无效");
  }
  if (
    typeof input.stagingDirectory !== "string" ||
    !isAbsolute(input.stagingDirectory)
  ) {
    throw new Error("Draft smoke staging 必须是绝对路径");
  }
  const token = environment?.GITHUB_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("环境变量 GITHUB_TOKEN 不能为空");
  }
  return { token };
}

export function expectedReleaseAssets(tag) {
  const version = tag.slice(1);
  const executable = `MineRadio-Tauri_${version}_x64-setup.exe`;
  return new Map([
    [executable, INSTALLER_LIMIT],
    [`${executable}.sig`, SIGNATURE_LIMIT],
    ["latest.json", METADATA_LIMIT],
    ["release-provenance.json", SIGNATURE_LIMIT],
    ["release-provenance.json.sig", SIGNATURE_LIMIT],
  ]);
}

async function readJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} 返回 HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

function validateRelease(release, input) {
  if (
    release?.id !== input.releaseId ||
    release?.tag_name !== input.tag ||
    release?.target_commitish !== input.commitSha ||
    release?.name !== `MineRadio-Tauri ${input.tag}`
  ) {
    throw new Error("Draft Release identity 不匹配");
  }
  if (release.draft !== true || release.prerelease !== false) {
    throw new Error("Smoke 下载前 Release 必须保持稳定版 draft");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("Draft Release assets 无效");
  }

  const expected = expectedReleaseAssets(input.tag);
  const seen = new Set();
  for (const asset of release.assets) {
    const limit = expected.get(asset?.name);
    const digest = DIGEST_PATTERN.exec(asset?.digest ?? "");
    if (
      limit === undefined ||
      seen.has(asset.name) ||
      asset.state !== "uploaded" ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > limit ||
      !digest
    ) {
      throw new Error("Draft Release 资产集合或 metadata 无效");
    }
    seen.add(asset.name);
  }
  if (seen.size !== expected.size) {
    throw new Error("Draft Release 必须精确包含五项资产");
  }
  return release.assets;
}

function releaseAuthoritySnapshot(release) {
  return {
    id: release.id,
    tagName: release.tag_name,
    targetCommitish: release.target_commitish,
    name: release.name,
    draft: release.draft,
    prerelease: release.prerelease,
    assets: release.assets
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        state: asset.state,
        size: asset.size,
        digest: asset.digest,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function fetchValidatedDraftRelease(
  fetchImplementation,
  input,
  token,
  label,
) {
  const response = await fetchImplementation(
    `${API_ROOT}/repos/${input.repository}/releases/${input.releaseId}`,
    {
      method: "GET",
      headers: apiHeaders(token),
      redirect: "error",
    },
  );
  const release = await readJsonResponse(response, label);
  const assets = validateRelease(release, input);
  return { release, assets };
}

function assertReleaseAuthorityUnchanged(before, after) {
  if (
    JSON.stringify(releaseAuthoritySnapshot(before)) !==
    JSON.stringify(releaseAuthoritySnapshot(after))
  ) {
    throw new Error("Draft Release 在资产下载期间发生变化");
  }
}

export async function openReleaseAssetResponse(
  fetchImplementation,
  repository,
  token,
  asset,
) {
  const apiUrl = `${API_ROOT}/repos/${repository}/releases/assets/${asset.id}`;
  const initial = await fetchImplementation(apiUrl, {
    method: "GET",
    headers: {
      ...apiHeaders(token),
      Accept: "application/octet-stream",
    },
    redirect: "manual",
  });
  if (initial.status === 200) {
    return initial;
  }
  if (![301, 302, 303, 307, 308].includes(initial.status)) {
    throw new Error(`Draft asset 下载返回 HTTP ${initial.status}`);
  }
  const location = initial.headers.get("location");
  let redirect;
  try {
    redirect = new URL(location ?? "");
  } catch {
    throw new Error("Draft asset redirect 无效");
  }
  if (
    redirect.protocol !== "https:" ||
    redirect.hostname !== RELEASE_ASSET_HOST ||
    redirect.port !== "" ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.hash !== ""
  ) {
    throw new Error("Draft asset redirect host 不受允许");
  }
  const response = await fetchImplementation(redirect, {
    method: "GET",
    headers: { Accept: "application/octet-stream" },
    redirect: "error",
  });
  if (response.status !== 200) {
    throw new Error(`Draft asset CDN 返回 HTTP ${response.status}`);
  }
  return response;
}

export async function writeVerifiedReleaseAsset(
  response,
  asset,
  outputPath,
  maximumBytes,
) {
  const headerLength = response.headers.get("content-length");
  if (headerLength !== null && Number(headerLength) !== asset.size) {
    throw new Error("Draft asset Content-Length 与 API metadata 不一致");
  }
  if (!response.body) {
    throw new Error("Draft asset 缺少响应正文");
  }

  const descriptor = openSync(outputPath, "wx", 0o600);
  const hash = createHash("sha256");
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maximumBytes || received > asset.size) {
        throw new Error("Draft asset 超过声明或安全大小上限");
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const written = writeSync(
          descriptor,
          value,
          offset,
          value.byteLength - offset,
        );
        if (written <= 0) {
          throw new Error("Draft asset 写入未前进");
        }
        offset += written;
      }
    }
  } finally {
    closeSync(descriptor);
  }

  const expectedHash = DIGEST_PATTERN.exec(asset.digest)[1];
  if (received !== asset.size || hash.digest("hex") !== expectedHash) {
    throw new Error("Draft asset 字节与 API metadata 不一致");
  }
  chmodSync(outputPath, 0o444);
  return { name: basename(outputPath), size: received, digest: asset.digest };
}

export async function downloadDraftRelease(input, dependencies = {}) {
  const environment = dependencies.env ?? process.env;
  const { token } = validateInput(input, environment);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("当前运行时不支持 fetch");
  }

  const stagingDirectory = resolve(input.stagingDirectory);
  mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 });
  try {
    const { release, assets } = await fetchValidatedDraftRelease(
      fetchImplementation,
      input,
      token,
      "Draft Release API",
    );
    const limits = expectedReleaseAssets(input.tag);
    const downloaded = [];
    for (const asset of assets) {
      const response = await openReleaseAssetResponse(
        fetchImplementation,
        input.repository,
        token,
        asset,
      );
      downloaded.push(
        await writeVerifiedReleaseAsset(
          response,
          asset,
          resolve(stagingDirectory, asset.name),
          limits.get(asset.name),
        ),
      );
    }
    const { release: recheckedRelease } = await fetchValidatedDraftRelease(
      fetchImplementation,
      input,
      token,
      "Draft Release recheck API",
    );
    assertReleaseAuthorityUnchanged(release, recheckedRelease);
    return {
      releaseId: release.id,
      tag: release.tag_name,
      stagingDirectory,
      assets: downloaded.sort((left, right) => left.name.localeCompare(right.name)),
    };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argumentsList) {
  if (argumentsList.length !== 5) {
    throw new Error(
      "用法: download-draft-release.mjs <repository> <tag> <commit-sha> <release-id> <absolute-staging-directory>",
    );
  }
  const [repository, tag, commitSha, releaseIdText, stagingDirectory] = argumentsList;
  return {
    repository,
    tag,
    commitSha,
    releaseId: Number(releaseIdText),
    stagingDirectory,
  };
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    const result = await downloadDraftRelease(parseArguments(process.argv.slice(2)));
    console.log(
      `Draft Release staging 完成: ${result.tag}；release_id=${result.releaseId}；assets=${result.assets.length}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Draft Release staging 失败: ${message}`);
    process.exitCode = 1;
  }
}

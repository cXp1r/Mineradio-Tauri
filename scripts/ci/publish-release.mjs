import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  describeLocalAssets,
  verifyReleaseAssets,
} from "./verify-release-assets.mjs";
import { verifyReleaseProvenance } from "./release-provenance.mjs";

const API_ROOT = "https://api.github.com";
const API_ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
const DOWNLOAD_ACCEPT = "application/octet-stream";
const REPOSITORY_PATTERN =
  /^(?=.{1,39}\/)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/(?=.{1,100}$)(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const RELEASE_TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXPECTED_PLATFORM_NAMES = [
  "windows-x86_64",
  "windows-x86_64-nsis",
];
const DEFAULT_MAXIMUM_LATEST_ATTEMPTS = 5;

function apiHeaders(token, accept = API_ACCEPT) {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function readErrorBody(response) {
  const text = await response.text();

  if (text.trim().length === 0) {
    return "无响应正文";
  }

  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.message === "string" ? parsed.message : text;
  } catch {
    return text;
  }
}

function createGitHubClient({ repository, token, fetch }) {
  async function requestJson(
    method,
    pathOrUrl,
    { body, allowNotFound = false } = {},
  ) {
    const url = `${API_ROOT}${pathOrUrl}`;
    const headers = apiHeaders(token);

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (allowNotFound && response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `GitHub API 请求失败: ${method} ${url}, status=${response.status}, message=${await readErrorBody(response)}`,
      );
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async function downloadAsset(asset) {
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
      throw new Error(`远端发布资产 ${asset.name} id 无效`);
    }

    const assetUrl = `${API_ROOT}/repos/${repository}/releases/assets/${asset.id}`;
    const response = await fetch(assetUrl, {
      method: "GET",
      headers: apiHeaders(token, DOWNLOAD_ACCEPT),
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(
        `下载远端发布资产 ${asset.name} 失败: status=${response.status}, message=${await readErrorBody(response)}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async function uploadAsset(release, assetPath) {
    const uploadUrl = new URL(
      `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets`,
    );
    uploadUrl.searchParams.set("name", basename(assetPath));
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        ...apiHeaders(token),
        "Content-Type": "application/octet-stream",
      },
      body: readFileSync(assetPath),
    });

    if (!response.ok) {
      throw new Error(
        `上传发布资产 ${basename(assetPath)} 失败: status=${response.status}, message=${await readErrorBody(response)}`,
      );
    }

    return response.json();
  }

  return { requestJson, downloadAsset, uploadAsset };
}

function validateInput(input, environment) {
  if (
    typeof input.repository !== "string" ||
    !REPOSITORY_PATTERN.test(input.repository)
  ) {
    throw new Error("仓库必须使用严格的 owner/name 格式");
  }

  const tagMatch =
    typeof input.tag === "string" ? RELEASE_TAG_PATTERN.exec(input.tag) : null;
  if (!tagMatch) {
    throw new Error(`发布标签 "${input.tag ?? ""}" 格式无效，必须匹配 vX.Y.Z`);
  }

  if (
    typeof input.commitSha !== "string" ||
    !COMMIT_SHA_PATTERN.test(input.commitSha)
  ) {
    throw new Error("提交 SHA 必须是 40 位小写十六进制");
  }

  if (
    typeof input.defaultBranch !== "string" ||
    input.defaultBranch.length === 0 ||
    /[\u0000-\u0020~^:?*[\\]/.test(input.defaultBranch) ||
    input.defaultBranch.includes("..")
  ) {
    throw new Error("默认分支名称无效");
  }

  const token = environment?.GITHUB_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("环境变量 GITHUB_TOKEN 不能为空");
  }

  const version = input.tag.slice(1);
  const expectedExeName = `MineRadio-Tauri_${version}_x64-setup.exe`;
  const expectedNames = new Map([
    ["exePath", expectedExeName],
    ["exeSigPath", `${expectedExeName}.sig`],
    ["manifestPath", "latest.json"],
    ["provenancePath", "release-provenance.json"],
    ["provenanceSigPath", "release-provenance.json.sig"],
  ]);
  const assetPaths = [];

  for (const [field, expectedName] of expectedNames) {
    const assetPath = input[field];
    if (typeof assetPath !== "string" || assetPath.length === 0) {
      throw new Error(`缺少发布资产路径: ${field}`);
    }

    if (basename(assetPath) !== expectedName) {
      throw new Error(`${field} 文件名必须为 ${expectedName}`);
    }

    assetPaths.push(assetPath);
  }

  if (
    typeof input.tauriConfigPath !== "string" ||
    input.tauriConfigPath.length === 0
  ) {
    throw new Error("缺少 Tauri 配置路径: tauriConfigPath");
  }
  describeLocalAssets([input.tauriConfigPath]);

  if (
    typeof input.signatureVerifierPath !== "string" ||
    input.signatureVerifierPath.length === 0
  ) {
    throw new Error("缺少 updater 签名验证器路径: signatureVerifierPath");
  }
  describeLocalAssets([input.signatureVerifierPath]);

  const localAssets = describeLocalAssets(assetPaths);

  return {
    token,
    version,
    expectedExeName,
    assetPaths,
    localAssets,
  };
}

async function listAllReleases(client, repository) {
  const releases = [];

  for (let page = 1; page <= 10_000; page += 1) {
    const pageReleases = await client.requestJson(
      "GET",
      `/repos/${repository}/releases?per_page=100&page=${page}`,
    );

    if (!Array.isArray(pageReleases)) {
      throw new Error("GitHub Release 列表响应必须是数组");
    }

    releases.push(...pageReleases);
    if (pageReleases.length < 100) {
      return releases;
    }
  }

  throw new Error("GitHub Release 列表分页超过安全上限");
}

async function findReleaseByExactTag(client, repository, tag) {
  const matches = (await listAllReleases(client, repository)).filter(
    (release) => release?.tag_name === tag,
  );

  if (matches.length > 1) {
    throw new Error(`发现 ${matches.length} 个同标签 Release: ${tag}`);
  }

  return matches[0] ?? null;
}

async function readRelease(client, repository, releaseId) {
  return client.requestJson(
    "GET",
    `/repos/${repository}/releases/${releaseId}`,
  );
}

function assertReleaseMetadata(release, input) {
  if (!release || !Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error("Release id 无效");
  }

  if (release.tag_name !== input.tag) {
    throw new Error(
      `Release tag 不一致: remote=${release.tag_name}, expected=${input.tag}`,
    );
  }

  if (release.target_commitish !== input.commitSha) {
    throw new Error(
      `Release target_commitish 不一致: remote=${release.target_commitish}, expected=${input.commitSha}`,
    );
  }

  const expectedName = `MineRadio-Tauri ${input.tag}`;
  if (release.name !== expectedName) {
    throw new Error(
      `Release 名称不一致: remote=${release.name}, expected=${expectedName}`,
    );
  }

  if (release.prerelease !== false) {
    throw new Error("Release 被错误标记为预发布");
  }

  if (typeof release.draft !== "boolean") {
    throw new Error("Release draft 状态无效");
  }

  if (!Array.isArray(release.assets)) {
    throw new Error("Release assets 必须是数组");
  }

  return release;
}

async function peelTagCommit(client, repository, tag) {
  const reference = await client.requestJson(
    "GET",
    `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  let object = reference?.object;
  const seenTagObjects = new Set();

  for (let depth = 0; depth < 32; depth += 1) {
    if (object?.type === "commit" && COMMIT_SHA_PATTERN.test(object.sha)) {
      return object.sha;
    }

    if (
      object?.type !== "tag" ||
      !COMMIT_SHA_PATTERN.test(object.sha) ||
      seenTagObjects.has(object.sha)
    ) {
      break;
    }

    seenTagObjects.add(object.sha);
    const tagObject = await client.requestJson(
      "GET",
      `/repos/${repository}/git/tags/${object.sha}`,
    );
    object = tagObject?.object;
  }

  throw new Error(`无法将 tag ${tag} peel 到有效 commit`);
}

async function verifyReleaseSource(client, input) {
  const peeledCommit = await peelTagCommit(
    client,
    input.repository,
    input.tag,
  );
  if (peeledCommit !== input.commitSha) {
    throw new Error(
      `tag peeled commit 与期望提交不一致: remote=${peeledCommit}, expected=${input.commitSha}`,
    );
  }

  const comparison = await client.requestJson(
    "GET",
    `/repos/${input.repository}/compare/${input.commitSha}...${encodeURIComponent(input.defaultBranch)}`,
  );
  if (!new Set(["ahead", "identical"]).has(comparison?.status)) {
    throw new Error(
      `tag 提交尚未进入默认分支 ${input.defaultBranch}: compare status=${comparison?.status}`,
    );
  }
}

function withoutGitHubTokens(environment) {
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([name]) => !new Set(["GITHUB_TOKEN", "GH_TOKEN"]).has(name.toUpperCase()),
    ),
  );
}

export async function defaultVerifySignature({
  signatureVerifierPath,
  tauriConfigPath,
  artifactPath,
  signaturePath,
  env,
}) {
  const result = spawnSync(
    signatureVerifierPath,
    [
      tauriConfigPath,
      artifactPath,
      signaturePath,
    ],
    {
      env: withoutGitHubTokens(env),
      stdio: "inherit",
      windowsHide: true,
    },
  );

  if (result.error) {
    throw new Error(`启动 updater 签名验证器失败: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`updater 签名验证器退出码非 0: ${result.status}`);
  }
}

function readUtf8File(filePath, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(filePath),
    );
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`${label} 不是有效的 UTF-8`);
    }

    throw error;
  }
}

function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(readUtf8File(filePath, label));
  } catch (error) {
    if (error instanceof Error && error.message === `${label} 不是有效的 UTF-8`) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 不是有效 JSON: ${message}`);
  }
}

function verifyUpdaterManifest({
  manifestPath,
  signaturePath,
  repository,
  tag,
  version,
  executableName,
}) {
  const manifest = parseJsonFile(manifestPath, "latest.json");
  if (manifest?.version !== version) {
    throw new Error(
      `latest.json version 不一致: actual=${manifest?.version}, expected=${version}`,
    );
  }

  if (
    manifest?.platforms === null ||
    typeof manifest?.platforms !== "object" ||
    Array.isArray(manifest.platforms)
  ) {
    throw new Error("latest.json platforms 必须是对象");
  }

  const actualPlatformNames = Object.keys(manifest.platforms).sort();
  if (
    actualPlatformNames.length !== EXPECTED_PLATFORM_NAMES.length ||
    actualPlatformNames.some(
      (name, index) => name !== EXPECTED_PLATFORM_NAMES[index],
    )
  ) {
    throw new Error(
      `latest.json 平台集合必须严格为 ${EXPECTED_PLATFORM_NAMES.join(", ")}`,
    );
  }

  const signature = readUtf8File(signaturePath, "安装包签名");
  const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${executableName}`;

  for (const platformName of EXPECTED_PLATFORM_NAMES) {
    const platform = manifest.platforms[platformName];
    if (platform === null || typeof platform !== "object" || Array.isArray(platform)) {
      throw new Error(`latest.json 的 ${platformName} 配置无效`);
    }

    if (platform.signature !== signature) {
      throw new Error(`latest.json 的 ${platformName} 签名未原样匹配`);
    }

    if (platform.url !== expectedUrl) {
      throw new Error(`latest.json 的 ${platformName} URL 不匹配`);
    }
  }

  return manifest;
}

async function verifyRemoteRelease({
  client,
  release,
  input,
  validation,
  environment,
  verifySignature,
  provenanceVerifier,
}) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "mineradio-release-download-"),
  );

  try {
    const downloadedPaths = new Map();
    const remoteAssetsByName = new Map(
      release.assets.map((asset) => [asset.name, asset]),
    );

    if (remoteAssetsByName.size !== release.assets.length) {
      throw new Error("远端发布资产名称重复");
    }

    for (const localAsset of validation.localAssets) {
      const remoteAsset = remoteAssetsByName.get(localAsset.name);
      if (!remoteAsset) {
        throw new Error(`远端发布缺少资产: ${localAsset.name}`);
      }

      const downloadedBytes = await client.downloadAsset(remoteAsset);

      const downloadedPath = join(temporaryDirectory, localAsset.name);
      writeFileSync(downloadedPath, downloadedBytes);
      downloadedPaths.set(localAsset.name, downloadedPath);
    }

    const verifiedAssets = verifyReleaseAssets({
      remoteAssets: release.assets,
      localAssets: describeLocalAssets([...downloadedPaths.values()]),
    });

    const verifierEnvironment = withoutGitHubTokens(environment);
    await verifySignature({
      signatureVerifierPath: input.signatureVerifierPath,
      tauriConfigPath: input.tauriConfigPath,
      artifactPath: downloadedPaths.get(validation.expectedExeName),
      signaturePath: downloadedPaths.get(`${validation.expectedExeName}.sig`),
      env: verifierEnvironment,
    });
    await verifySignature({
      signatureVerifierPath: input.signatureVerifierPath,
      tauriConfigPath: input.tauriConfigPath,
      artifactPath: downloadedPaths.get("release-provenance.json"),
      signaturePath: downloadedPaths.get("release-provenance.json.sig"),
      env: verifierEnvironment,
    });

    const provenancePath = downloadedPaths.get("release-provenance.json");
    const manifestPath = downloadedPaths.get("latest.json");
    const executablePath = downloadedPaths.get(validation.expectedExeName);
    const executableSignaturePath = downloadedPaths.get(
      `${validation.expectedExeName}.sig`,
    );
    await provenanceVerifier({
      provenance: parseJsonFile(provenancePath, "release-provenance.json"),
      repository: input.repository,
      tag: input.tag,
      commitSha: input.commitSha,
      assetPaths: [executablePath, executableSignaturePath, manifestPath],
    });

    verifyUpdaterManifest({
      manifestPath,
      signaturePath: executableSignaturePath,
      repository: input.repository,
      tag: input.tag,
      version: validation.version,
      executableName: validation.expectedExeName,
    });

    return verifiedAssets;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseStrictReleaseVersion(tag) {
  const match = typeof tag === "string" ? RELEASE_TAG_PATTERN.exec(tag) : null;
  return match
    ? {
        major: BigInt(match[1]),
        minor: BigInt(match[2]),
        patch: BigInt(match[3]),
      }
    : null;
}

function compareReleaseVersions(left, right) {
  for (const component of ["major", "minor", "patch"]) {
    if (left[component] < right[component]) {
      return -1;
    }
    if (left[component] > right[component]) {
      return 1;
    }
  }

  return 0;
}

function assertCurrentReleaseCanBeLatest(releases, candidate) {
  const candidateVersion = parseStrictReleaseVersion(candidate.tag_name);
  if (!candidateVersion) {
    throw new Error(`当前 Release tag 不是严格版本: ${candidate.tag_name}`);
  }

  let foundCandidate = false;

  for (const release of releases) {
    if (release?.draft !== false || release?.prerelease !== false) {
      continue;
    }

    if (release.id === candidate.id && release.tag_name === candidate.tag_name) {
      foundCandidate = true;
      continue;
    }

    if (release.tag_name === candidate.tag_name) {
      throw new Error(`发现同标签的其他公开 Release: ${candidate.tag_name}`);
    }

    const version = parseStrictReleaseVersion(release.tag_name);
    if (version && compareReleaseVersions(version, candidateVersion) > 0) {
      throw new Error(
        `存在高于当前 ${candidate.tag_name} 的公开 Release: ${release.tag_name}`,
      );
    }
  }

  if (!foundCandidate) {
    throw new Error(`当前 Release 未出现在公开列表: ${candidate.tag_name}`);
  }
}

function latestMatches(latest, candidate) {
  return latest?.id === candidate.id && latest?.tag_name === candidate.tag_name;
}

async function convergeLatest({
  client,
  repository,
  candidate,
  maximumAttempts,
  sleep,
}) {
  let lastPatchError;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    assertCurrentReleaseCanBeLatest(
      await listAllReleases(client, repository),
      candidate,
    );
    const authoritativeLatest = await client.requestJson(
      "GET",
      `/repos/${repository}/releases/latest`,
      { allowNotFound: true },
    );

    if (latestMatches(authoritativeLatest, candidate)) {
      return candidate;
    }

    try {
      await client.requestJson(
        "PATCH",
        `/repos/${repository}/releases/${candidate.id}`,
        { body: { make_latest: "true" } },
      );
      lastPatchError = undefined;
    } catch (error) {
      lastPatchError = error;
    }

    assertCurrentReleaseCanBeLatest(
      await listAllReleases(client, repository),
      candidate,
    );
    const verifiedLatest = await client.requestJson(
      "GET",
      `/repos/${repository}/releases/latest`,
      { allowNotFound: true },
    );

    if (latestMatches(verifiedLatest, candidate)) {
      return candidate;
    }

    if (attempt < maximumAttempts) {
      await sleep(2_000);
    }
  }

  const suffix =
    lastPatchError instanceof Error ? `；最后一次 PATCH 错误: ${lastPatchError.message}` : "";
  throw new Error(
    `Latest Release 在 ${maximumAttempts} 次尝试后仍未收敛${suffix}`,
  );
}

async function createDraftWithRecovery(client, input) {
  const body = {
    tag_name: input.tag,
    target_commitish: input.commitSha,
    name: `MineRadio-Tauri ${input.tag}`,
    draft: true,
    prerelease: false,
    generate_release_notes: true,
    make_latest: "false",
  };

  try {
    return await client.requestJson(
      "POST",
      `/repos/${input.repository}/releases`,
      { body },
    );
  } catch (creationError) {
    const recovered = await findReleaseByExactTag(
      client,
      input.repository,
      input.tag,
    );
    if (!recovered) {
      throw creationError;
    }

    return recovered;
  }
}

async function uploadAssetsWithRecovery({
  client,
  release,
  input,
  validation,
}) {
  const localAssetsByName = new Map(
    validation.localAssets.map((asset) => [asset.name, asset]),
  );
  let currentRelease = release;

  while (true) {
    if (currentRelease.draft !== true) {
      throw new Error("Release 在验证完成前已被公开");
    }

    const localSubset = currentRelease.assets
      .map((asset) => localAssetsByName.get(asset.name))
      .filter((asset) => asset !== undefined);
    verifyReleaseAssets({
      remoteAssets: currentRelease.assets,
      localAssets: localSubset,
    });

    const remoteNames = new Set(currentRelease.assets.map((asset) => asset.name));
    const missingAssetPath = validation.assetPaths.find(
      (assetPath) => !remoteNames.has(basename(assetPath)),
    );

    if (!missingAssetPath) {
      verifyReleaseAssets({
        remoteAssets: currentRelease.assets,
        localAssets: validation.localAssets,
      });
      return currentRelease;
    }

    let uploadError;
    try {
      await client.uploadAsset(currentRelease, missingAssetPath);
    } catch (error) {
      uploadError = error;
    }

    const refreshedRelease = assertReleaseMetadata(
      await readRelease(client, input.repository, currentRelease.id),
      input,
    );
    const refreshedLocalSubset = refreshedRelease.assets
      .map((asset) => localAssetsByName.get(asset.name))
      .filter((asset) => asset !== undefined);
    verifyReleaseAssets({
      remoteAssets: refreshedRelease.assets,
      localAssets: refreshedLocalSubset,
    });

    if (
      !refreshedRelease.assets.some(
        (asset) => asset.name === basename(missingAssetPath),
      )
    ) {
      if (uploadError) {
        throw uploadError;
      }

      throw new Error(
        `上传成功响应后远端仍缺少资产: ${basename(missingAssetPath)}`,
      );
    }

    currentRelease = refreshedRelease;
  }
}

async function publishDraftWithRecovery(client, input, release) {
  try {
    await client.requestJson(
      "PATCH",
      `/repos/${input.repository}/releases/${release.id}`,
      {
        body: {
          draft: false,
          prerelease: false,
          make_latest: "false",
        },
      },
    );
  } catch (publishError) {
    const recovered = assertReleaseMetadata(
      await readRelease(client, input.repository, release.id),
      input,
    );
    if (recovered.draft === false) {
      return recovered;
    }

    throw publishError;
  }

  const published = assertReleaseMetadata(
    await readRelease(client, input.repository, release.id),
    input,
  );
  if (published.draft !== false) {
    throw new Error(`Release ${input.tag} 在发布 PATCH 后仍是草稿`);
  }

  return published;
}

export async function publishRelease(input, dependencies = {}) {
  const environment = dependencies.env ?? process.env;
  const validation = validateInput(input, environment);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("当前运行时不支持 fetch");
  }

  const maximumLatestAttempts =
    dependencies.maximumLatestAttempts ?? DEFAULT_MAXIMUM_LATEST_ATTEMPTS;
  if (
    !Number.isSafeInteger(maximumLatestAttempts) ||
    maximumLatestAttempts <= 0
  ) {
    throw new Error("maximumLatestAttempts 必须是正安全整数");
  }

  const client = createGitHubClient({
    repository: input.repository,
    token: validation.token,
    fetch: fetchImplementation,
  });
  const signatureVerifier =
    dependencies.verifySignature ?? defaultVerifySignature;
  const provenanceVerifier =
    dependencies.verifyReleaseProvenance ?? verifyReleaseProvenance;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));

  await verifyReleaseSource(client, input);

  let listedRelease = await findReleaseByExactTag(
    client,
    input.repository,
    input.tag,
  );
  let created = false;
  let release;

  if (listedRelease) {
    release = assertReleaseMetadata(
      await readRelease(client, input.repository, listedRelease.id),
      input,
    );
  } else {
    created = true;
    const creationResult = await createDraftWithRecovery(client, input);
    listedRelease = await findReleaseByExactTag(
      client,
      input.repository,
      input.tag,
    );
    if (!listedRelease || listedRelease.id !== creationResult.id) {
      throw new Error("创建 Release 后无法唯一确认同一 release id");
    }

    release = assertReleaseMetadata(
      await readRelease(client, input.repository, listedRelease.id),
      input,
    );

    if (release.draft !== true) {
      throw new Error("新建或恢复的 Release 在上传前必须保持草稿");
    }

  }

  if (release.draft === true) {
    release = await uploadAssetsWithRecovery({
      client,
      release,
      input,
      validation,
    });

    if (release.draft !== true) {
      throw new Error("Release 在验证完成前必须保持草稿");
    }
  }

  const verifiedRemoteAssets = await verifyRemoteRelease({
    client,
    release,
    input,
    validation,
    environment,
    verifySignature: signatureVerifier,
    provenanceVerifier,
  });

  if (release.draft) {
    await verifyReleaseSource(client, input);
    release = assertReleaseMetadata(
      await readRelease(client, input.repository, release.id),
      input,
    );
    verifyReleaseAssets({
      remoteAssets: release.assets,
      localAssets: verifiedRemoteAssets,
    });

    if (release.draft) {
      release = await publishDraftWithRecovery(client, input, release);
    }
  }

  await verifyReleaseSource(client, input);
  release = assertReleaseMetadata(
    await readRelease(client, input.repository, release.id),
    input,
  );
  verifyReleaseAssets({
    remoteAssets: release.assets,
    localAssets: verifiedRemoteAssets,
  });
  if (release.draft !== false) {
    throw new Error(`Release ${input.tag} 在 Latest 收敛前仍是草稿`);
  }
  if (release.immutable !== true) {
    throw new Error(`Release ${input.tag} 未启用 immutable`);
  }

  const latest = await convergeLatest({
    client,
    repository: input.repository,
    candidate: release,
    maximumAttempts: maximumLatestAttempts,
    sleep,
  });

  return {
    releaseId: release.id,
    tag: release.tag_name,
    created,
    published: release.draft === false,
    latestReleaseId: latest.id,
    latestTag: latest.tag_name,
  };
}

const CLI_FIELDS = new Map([
  ["--repository", "repository"],
  ["--tag", "tag"],
  ["--commit-sha", "commitSha"],
  ["--default-branch", "defaultBranch"],
  ["--tauri-config-path", "tauriConfigPath"],
  ["--signature-verifier-path", "signatureVerifierPath"],
  ["--exe-path", "exePath"],
  ["--exe-sig-path", "exeSigPath"],
  ["--manifest-path", "manifestPath"],
  ["--provenance-path", "provenancePath"],
  ["--provenance-sig-path", "provenanceSigPath"],
]);

function cliUsage() {
  return [
    "用法: publish-release.mjs",
    "--repository <owner/name>",
    "--tag <vX.Y.Z>",
    "--commit-sha <40位小写SHA>",
    "--default-branch <分支>",
    "--tauri-config-path <path>",
    "--signature-verifier-path <path>",
    "--exe-path <path>",
    "--exe-sig-path <path>",
    "--manifest-path <path>",
    "--provenance-path <path>",
    "--provenance-sig-path <path>",
  ].join(" ");
}

export function parseCliArguments(argumentsList) {
  if (argumentsList.length !== CLI_FIELDS.size * 2) {
    throw new Error(cliUsage());
  }

  const parsed = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    const field = CLI_FIELDS.get(option);

    if (!field || typeof value !== "string" || value.length === 0 || field in parsed) {
      throw new Error(cliUsage());
    }

    parsed[field] = value;
  }

  if (Object.keys(parsed).length !== CLI_FIELDS.size) {
    throw new Error(cliUsage());
  }

  return parsed;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    const result = await publishRelease(parseCliArguments(process.argv.slice(2)));
    console.log(
      `Release 发布完成: ${result.tag}；Latest=${result.latestTag}；release_id=${result.releaseId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Release 发布失败: ${message}`);
    process.exitCode = 1;
  }
}

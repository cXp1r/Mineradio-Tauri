import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function compareAssetNames(left, right) {
  return left.name.localeCompare(right.name);
}

function indexAssetsByName(assets, location) {
  const assetsByName = new Map();

  for (const asset of assets) {
    if (assetsByName.has(asset.name)) {
      throw new Error(`${location}发布资产名称重复: ${asset.name}`);
    }

    assetsByName.set(asset.name, asset);
  }

  return assetsByName;
}

export function describeLocalAssets(assetPaths) {
  const assetNames = new Set();

  return assetPaths
    .map((assetPath) => {
      const name = basename(assetPath);

      if (assetNames.has(name)) {
        throw new Error(`本地发布资产名称重复: ${name}`);
      }

      assetNames.add(name);

      let statistics;

      try {
        statistics = statSync(assetPath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
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

      return {
        name,
        size: content.byteLength,
        digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      };
    })
    .sort(compareAssetNames);
}

export function verifyReleaseAssets({ remoteAssets, localAssets }) {
  const localAssetsByName = indexAssetsByName(localAssets, "本地");
  const remoteAssetsByName = indexAssetsByName(remoteAssets, "远端");

  for (const remoteAsset of remoteAssets) {
    if (remoteAsset.state !== "uploaded") {
      throw new Error(
        `远端发布资产 ${remoteAsset.name} 状态不是 uploaded: ${remoteAsset.state}`,
      );
    }

    if (
      typeof remoteAsset.digest !== "string" ||
      remoteAsset.digest.trim().length === 0
    ) {
      throw new Error(`远端发布资产 ${remoteAsset.name} 缺少 digest`);
    }

    if (!Number.isSafeInteger(remoteAsset.size) || remoteAsset.size <= 0) {
      throw new Error(
        `远端发布资产 ${remoteAsset.name} size 必须大于 0: ${remoteAsset.size}`,
      );
    }

    const localAsset = localAssetsByName.get(remoteAsset.name);

    if (localAsset && remoteAsset.size !== localAsset.size) {
      throw new Error(
        `远端发布资产 ${remoteAsset.name} size 不一致: remote=${remoteAsset.size}, local=${localAsset.size}`,
      );
    }

    if (localAsset && remoteAsset.digest !== localAsset.digest) {
      throw new Error(
        `远端发布资产 ${remoteAsset.name} digest 不一致: remote=${remoteAsset.digest}, local=${localAsset.digest}`,
      );
    }
  }

  const missingNames = [...localAssetsByName.keys()]
    .filter((name) => !remoteAssetsByName.has(name))
    .sort((left, right) => left.localeCompare(right));

  if (missingNames.length > 0) {
    throw new Error(`远端发布缺少本地资产: ${missingNames.join(", ")}`);
  }

  const extraNames = [...remoteAssetsByName.keys()]
    .filter((name) => !localAssetsByName.has(name))
    .sort((left, right) => left.localeCompare(right));

  if (extraNames.length > 0) {
    throw new Error(`远端发布存在额外资产: ${extraNames.join(", ")}`);
  }

  return localAssets
    .map(({ name, size, digest }) => ({ name, size, digest }))
    .sort(compareAssetNames);
}

function runCli() {
  const [releaseAssetsJsonPath, ...assetPaths] = process.argv.slice(2);

  if (!releaseAssetsJsonPath || assetPaths.length === 0) {
    throw new Error(
      "用法: verify-release-assets.mjs <release-assets-json-path> <assetPath>...",
    );
  }

  let releaseAssetsJson;

  try {
    releaseAssetsJson = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(releaseAssetsJsonPath),
    );
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("assets JSON 不是有效的 UTF-8");
    }

    throw error;
  }

  const remoteAssets = JSON.parse(releaseAssetsJson);

  if (!Array.isArray(remoteAssets)) {
    throw new Error("发布资产 JSON 必须是 GitHub REST assets 数组");
  }

  const descriptors = verifyReleaseAssets({
    remoteAssets,
    localAssets: describeLocalAssets(assetPaths),
  });

  console.log(`发布资产验证通过: ${descriptors.length} 个文件`);
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`发布资产验证失败: ${message}`);
    process.exitCode = 1;
  }
}

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION_SOURCES = [
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/Cargo.toml",
];

export function parseReleaseTag(tag) {
  const releaseTag = typeof tag === "string" ? tag : "";

  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
      releaseTag,
    )
  ) {
    throw new Error(
      `发布标签 "${releaseTag}" 格式无效，必须匹配 vX.Y.Z`,
    );
  }

  return releaseTag.slice(1);
}

export function validateReleaseVersions(tag, versions) {
  const releaseTag = typeof tag === "string" ? tag : "";
  const tagVersion = parseReleaseTag(releaseTag);
  const entries = VERSION_SOURCES.map((source) => [source, versions[source]]);
  const missingSources = entries.filter(([, version]) => !version);

  if (missingSources.length > 0) {
    throw new Error(
      [
        "以下版本来源缺少版本号:",
        ...missingSources.map(([source]) => `- ${source}`),
      ].join("\n"),
    );
  }

  if (new Set(entries.map(([, version]) => version)).size !== 1) {
    throw new Error(
      [
        "版本来源不一致:",
        ...entries.map(([source, version]) => `- ${source}: ${version}`),
      ].join("\n"),
    );
  }

  const version = entries[0][1];

  if (tagVersion !== version) {
    throw new Error(
      `发布标签版本 ${tagVersion} 与应用版本 ${version} 不一致`,
    );
  }

  return { tag: releaseTag, version };
}

function readJsonVersion(repositoryRoot, relativePath) {
  const filePath = resolve(repositoryRoot, relativePath);
  const manifest = JSON.parse(readFileSync(filePath, "utf8"));

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${relativePath} 缺少有效的 version 字段`);
  }

  return manifest.version;
}

function readCargoPackageVersion(repositoryRoot, relativePath) {
  const filePath = resolve(repositoryRoot, relativePath);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  let inPackageSection = false;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*$/);

    if (sectionMatch) {
      if (inPackageSection) {
        break;
      }

      inPackageSection = sectionMatch[1] === "package";
      continue;
    }

    if (inPackageSection) {
      const versionMatch = line.match(
        /^\s*version\s*=\s*"([^"]+)"\s*(?:#.*)?$/,
      );

      if (versionMatch) {
        return versionMatch[1];
      }
    }
  }

  throw new Error(`${relativePath} 的 [package] 缺少有效的 version 字段`);
}

export function readRepositoryVersions(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
) {
  return {
    "package.json": readJsonVersion(repositoryRoot, "package.json"),
    "apps/desktop/package.json": readJsonVersion(
      repositoryRoot,
      "apps/desktop/package.json",
    ),
    "apps/desktop/src-tauri/tauri.conf.json": readJsonVersion(
      repositoryRoot,
      "apps/desktop/src-tauri/tauri.conf.json",
    ),
    "apps/desktop/src-tauri/Cargo.toml": readCargoPackageVersion(
      repositoryRoot,
      "apps/desktop/src-tauri/Cargo.toml",
    ),
  };
}

function runCli() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  const result = validateReleaseVersions(tag, readRepositoryVersions());
  console.log(`发布版本验证通过: ${result.tag} (${result.version})`);
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`发布版本验证失败: ${message}`);
    process.exitCode = 1;
  }
}

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { publishRelease } from "./publish-release.mjs";

const REPOSITORY = "zzstar101/Mineradio-Tauri";
const TAG = "v1.2.3";
const VERSION = "1.2.3";
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const DEFAULT_BRANCH = "main";
const API_ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

type FixturePaths = {
  tauriConfigPath: string;
  signatureVerifierPath: string;
  exePath: string;
  exeSigPath: string;
  manifestPath: string;
  provenancePath: string;
  provenanceSigPath: string;
};

function sha256(content: Uint8Array | string) {
  return createHash("sha256").update(content).digest("hex");
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "mineradio-publish-release-"));
  const exeName = `MineRadio-Tauri_${VERSION}_x64-setup.exe`;
  const paths = {
    tauriConfigPath: join(root, "tauri.conf.json"),
    signatureVerifierPath: join(root, "verify_updater_signature.exe"),
    exePath: join(root, exeName),
    exeSigPath: join(root, `${exeName}.sig`),
    manifestPath: join(root, "latest.json"),
    provenancePath: join(root, "release-provenance.json"),
    provenanceSigPath: join(root, "release-provenance.json.sig"),
  };
  const signature = "trusted-executable-signature\n";
  const releaseUrl = `https://github.com/${REPOSITORY}/releases/download/${TAG}/${exeName}`;
  const manifest = {
    version: VERSION,
    notes: "Release notes.",
    pub_date: "2026-07-10T00:00:00.000Z",
    platforms: {
      "windows-x86_64-nsis": {
        signature,
        url: releaseUrl,
      },
      "windows-x86_64": {
        signature,
        url: releaseUrl,
      },
    },
  };

  writeFileSync(paths.tauriConfigPath, '{"plugins":{"updater":{}}}\n', "utf8");
  writeFileSync(paths.signatureVerifierPath, "verifier-binary", "utf8");
  writeFileSync(paths.exePath, "installer-bytes", "utf8");
  writeFileSync(paths.exeSigPath, signature, "utf8");
  writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeProvenance(paths);
  writeFileSync(paths.provenanceSigPath, "trusted-provenance-signature\n", "utf8");

  return {
    root,
    input: {
      repository: REPOSITORY,
      tag: TAG,
      commitSha: COMMIT_SHA,
      defaultBranch: DEFAULT_BRANCH,
      ...paths,
    },
    paths,
  };
}

function writeProvenance(paths: FixturePaths) {
  const assetPaths = [paths.exePath, paths.exeSigPath, paths.manifestPath];
  const provenance = {
    schema_version: 1,
    repository: REPOSITORY,
    tag: TAG,
    commit_sha: COMMIT_SHA,
    assets: assetPaths
      .map((assetPath) => {
        const content = readFileSync(assetPath);

        return {
          name: basename(assetPath),
          size: content.byteLength,
          sha256: sha256(content),
        };
      })
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
  };

  writeFileSync(
    paths.provenancePath,
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  );
}

function localAssetPaths(fixture: ReturnType<typeof createFixture>) {
  return [
    fixture.paths.exePath,
    fixture.paths.exeSigPath,
    fixture.paths.manifestPath,
    fixture.paths.provenancePath,
    fixture.paths.provenanceSigPath,
  ];
}

function remoteAsset(assetPath: string, id: number) {
  const bytes = readFileSync(assetPath);

  return {
    id,
    name: basename(assetPath),
    size: bytes.byteLength,
    state: "uploaded",
    digest: `sha256:${sha256(bytes)}`,
    url: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${id}`,
    bytes,
  };
}

function matchingRelease(
  fixture: ReturnType<typeof createFixture>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 101,
    tag_name: TAG,
    target_commitish: COMMIT_SHA,
    name: `MineRadio-Tauri ${TAG}`,
    draft: true,
    prerelease: false,
    immutable: true,
    assets: localAssetPaths(fixture).map((assetPath, index) =>
      remoteAsset(assetPath, 1001 + index),
    ),
    ...overrides,
  };
}

function publicAsset(asset: any) {
  const { bytes: _bytes, ...result } = asset;
  return result;
}

function publicRelease(release: any) {
  return {
    ...release,
    assets: release.assets.map(publicAsset),
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFakeGitHub(options: {
  releases?: any[];
  tagSha?: string;
  compareStatus?: string;
  latestId?: number | null;
  createdUploadUrl?: string;
  duplicateAfterCreate?: boolean;
  publishDuringUploadName?: string;
  mutateOnTagRead?: {
    count: number;
    mutate: (releases: any[]) => void;
  };
  detailOverride?: (release: any) => any;
  faults?: {
    createResponseLost?: boolean;
    uploadResponseLostName?: string;
    publishResponseLost?: boolean;
    latestResponseLost?: boolean;
  };
  immutableOnPublish?: boolean;
} = {}) {
  const releases = [...(options.releases ?? [])];
  const requests: any[] = [];
  const faults = { ...(options.faults ?? {}) };
  let latestId = options.latestId ?? null;
  let tagReadCount = 0;
  let nextReleaseId = Math.max(200, ...releases.map((release) => release.id + 1));
  let nextAssetId = Math.max(
    2000,
    ...releases.flatMap((release) =>
      release.assets.map((asset: any) => asset.id + 1),
    ),
  );

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown = undefined;

    if (typeof init.body === "string") {
      body = headers["content-type"]?.includes("application/json")
        ? JSON.parse(init.body)
        : init.body;
    } else if (init.body) {
      body = Buffer.from(await new Response(init.body).arrayBuffer());
    }

    requests.push({ method, url: url.toString(), headers, body });

    const repositoryPrefix = `/repos/${REPOSITORY}`;

    if (
      method === "GET" &&
      url.pathname === `${repositoryPrefix}/git/ref/tags/${TAG}`
    ) {
      tagReadCount += 1;
      if (options.mutateOnTagRead?.count === tagReadCount) {
        options.mutateOnTagRead.mutate(releases);
      }

      return jsonResponse({
        ref: `refs/tags/${TAG}`,
        object: { type: "commit", sha: options.tagSha ?? COMMIT_SHA },
      });
    }

    if (
      method === "GET" &&
      url.pathname === `${repositoryPrefix}/compare/${COMMIT_SHA}...${DEFAULT_BRANCH}`
    ) {
      return jsonResponse({ status: options.compareStatus ?? "ahead" });
    }

    if (method === "GET" && url.pathname === `${repositoryPrefix}/releases`) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * 100;
      return jsonResponse(releases.slice(start, start + 100).map(publicRelease));
    }

    if (
      method === "GET" &&
      url.pathname === `${repositoryPrefix}/releases/latest`
    ) {
      const latest = releases.find((release) => release.id === latestId);
      return latest
        ? jsonResponse(publicRelease(latest))
        : jsonResponse({ message: "Not Found" }, 404);
    }

    const assetMatch = url.pathname.match(
      new RegExp(`^${repositoryPrefix}/releases/assets/(\\d+)$`),
    );
    if (method === "GET" && assetMatch) {
      const assetId = Number(assetMatch[1]);
      const asset = releases
        .flatMap((release) => release.assets)
        .find((candidate) => candidate.id === assetId);

      return asset
        ? new Response(asset.bytes, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          })
        : jsonResponse({ message: "Not Found" }, 404);
    }

    const releaseMatch = url.pathname.match(
      new RegExp(`^${repositoryPrefix}/releases/(\\d+)$`),
    );
    if (method === "GET" && releaseMatch) {
      const release = releases.find(
        (candidate) => candidate.id === Number(releaseMatch[1]),
      );
      if (!release) {
        return jsonResponse({ message: "Not Found" }, 404);
      }

      const detail = publicRelease(release);
      return jsonResponse(options.detailOverride?.(detail) ?? detail);
    }

    if (method === "POST" && url.pathname === `${repositoryPrefix}/releases`) {
      const requestBody = body as any;
      const release = {
        id: nextReleaseId++,
        tag_name: requestBody.tag_name,
        target_commitish: requestBody.target_commitish,
        name: requestBody.name,
        draft: requestBody.draft,
        prerelease: requestBody.prerelease,
        immutable: false,
        upload_url:
          options.createdUploadUrl ??
          `https://uploads.github.com/repos/${REPOSITORY}/releases/${nextReleaseId - 1}/assets{?name,label}`,
        assets: [],
      };
      releases.push(release);

      if (options.duplicateAfterCreate) {
        releases.push({
          ...release,
          id: nextReleaseId++,
          assets: [],
        });
      }

      if (faults.createResponseLost) {
        faults.createResponseLost = false;
        throw new Error("创建响应在服务端成功后丢失");
      }

      return jsonResponse(publicRelease(release), 201);
    }

    const uploadMatch = url.pathname.match(
      new RegExp(`^${repositoryPrefix}/releases/(\\d+)/assets$`),
    );
    if (method === "POST" && uploadMatch) {
      const release = releases.find(
        (candidate) => candidate.id === Number(uploadMatch[1]),
      );
      if (!release) {
        return jsonResponse({ message: "Not Found" }, 404);
      }

      const name = url.searchParams.get("name") ?? "";
      const bytes = body as Buffer;
      const asset = {
        id: nextAssetId++,
        name,
        size: bytes.byteLength,
        state: "uploaded",
        digest: `sha256:${sha256(bytes)}`,
        url: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${nextAssetId - 1}`,
        bytes,
      };
      release.assets.push(asset);

      if (options.publishDuringUploadName === name) {
        release.draft = false;
      }

      if (faults.uploadResponseLostName === name) {
        delete faults.uploadResponseLostName;
        throw new Error("上传响应在服务端成功后丢失");
      }

      return jsonResponse(publicAsset(asset), 201);
    }

    if (method === "PATCH" && releaseMatch) {
      const release = releases.find(
        (candidate) => candidate.id === Number(releaseMatch[1]),
      );
      if (!release) {
        return jsonResponse({ message: "Not Found" }, 404);
      }

      const requestBody = body as any;
      if (requestBody.draft === false) {
        release.draft = false;
        release.prerelease = requestBody.prerelease;
        release.immutable = options.immutableOnPublish ?? true;
        if (faults.publishResponseLost) {
          faults.publishResponseLost = false;
          throw new Error("发布响应在服务端成功后丢失");
        }
      }

      if (requestBody.make_latest === "true") {
        latestId = release.id;
        if (faults.latestResponseLost) {
          faults.latestResponseLost = false;
          throw new Error("Latest 响应在服务端成功后丢失");
        }
      }

      return jsonResponse(publicRelease(release));
    }

    return jsonResponse(
      { message: `未处理的 fake GitHub 请求: ${method} ${url}` },
      500,
    );
  };

  return {
    fetch,
    releases,
    requests,
    get latestId() {
      return latestId;
    },
  };
}

async function runPublish(
  fixture: ReturnType<typeof createFixture>,
  github: ReturnType<typeof createFakeGitHub>,
  inputOverrides: Record<string, unknown> = {},
) {
  const verifierCalls: any[] = [];

  await publishRelease(
    { ...fixture.input, ...inputOverrides },
    {
      fetch: github.fetch,
      env: {
        GITHUB_TOKEN: "secret-token",
        GH_TOKEN: "must-also-be-removed",
        SAFE_ENVIRONMENT_VALUE: "visible",
      },
      sleep: async () => {},
      verifySignature: async (call: any) => {
        verifierCalls.push({
          ...call,
          artifactBytes: readFileSync(call.artifactPath),
          signatureBytes: readFileSync(call.signaturePath),
          env: { ...call.env },
        });
      },
    },
  );

  return verifierCalls;
}

function writeRequests(github: ReturnType<typeof createFakeGitHub>) {
  return github.requests.filter((request) =>
    ["POST", "PATCH", "PUT", "DELETE"].includes(request.method),
  );
}

describe("publishRelease", () => {
  test("导出可注入依赖的 publishRelease", () => {
    expect(publishRelease).toBeFunction();
  });

  test("拒绝非严格仓库、标签与 40 位小写 SHA", async () => {
    const fixture = createFixture();

    try {
      const invalidCases = [
        [{ repository: "owner/repo/extra" }, "仓库"],
        [{ repository: "owner--name/repo" }, "仓库"],
        [{ tag: "v01.2.3" }, "标签"],
        [{ tag: "1.2.3" }, "标签"],
        [{ commitSha: COMMIT_SHA.toUpperCase() }, "SHA"],
        [{ commitSha: COMMIT_SHA.slice(1) }, "SHA"],
        [{ signatureVerifierPath: "" }, "签名验证器"],
      ] as const;

      for (const [overrides, message] of invalidCases) {
        const github = createFakeGitHub();
        await expect(runPublish(fixture, github, overrides)).rejects.toThrow(message);
        expect(github.requests).toHaveLength(0);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("新建草稿、上传五项资产、远端复验、发布并收敛 Latest", async () => {
    const fixture = createFixture();
    const github = createFakeGitHub();

    try {
      const verifierCalls = await runPublish(fixture, github);
      const release = github.releases.find((candidate) => candidate.tag_name === TAG);

      expect(release).toMatchObject({
        target_commitish: COMMIT_SHA,
        name: `MineRadio-Tauri ${TAG}`,
        draft: false,
        prerelease: false,
      });
      expect(release.assets.map((asset: any) => asset.name).sort()).toEqual(
        localAssetPaths(fixture).map((assetPath) => basename(assetPath)).sort(),
      );
      expect(github.latestId).toBe(release.id);

      const createRequest = github.requests.find(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).hostname === "api.github.com",
      );
      expect(createRequest.body).toEqual({
        tag_name: TAG,
        target_commitish: COMMIT_SHA,
        name: `MineRadio-Tauri ${TAG}`,
        draft: true,
        prerelease: false,
        generate_release_notes: true,
        make_latest: "false",
      });
      expect(
        github.requests.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).hostname === "uploads.github.com",
        ),
      ).toHaveLength(5);
      expect(
        github.requests.filter((request) =>
          request.url.includes(`/git/ref/tags/${TAG}`),
        ),
      ).toHaveLength(3);
      expect(
        github.requests.filter((request) => request.url.includes("/compare/")),
      ).toHaveLength(3);

      for (const request of github.requests.filter((candidate) =>
        ["api.github.com", "uploads.github.com"].includes(
          new URL(candidate.url).hostname,
        ),
      )) {
        expect(request.headers["x-github-api-version"]).toBe(API_VERSION);
        expect(request.headers.authorization).toBe("Bearer secret-token");
        expect(request.headers.accept).toBe(
          request.url.includes("/releases/assets/")
            ? "application/octet-stream"
            : API_ACCEPT,
        );
      }

      expect(verifierCalls).toHaveLength(2);
      expect(verifierCalls.map((call) => basename(call.artifactPath)).sort()).toEqual([
        basename(fixture.paths.exePath),
        basename(fixture.paths.provenancePath),
      ]);
      for (const call of verifierCalls) {
        expect(call.env.GITHUB_TOKEN).toBeUndefined();
        expect(call.env.GH_TOKEN).toBeUndefined();
        expect(call.env.SAFE_ENVIRONMENT_VALUE).toBe("visible");
        expect(existsSync(call.artifactPath)).toBe(false);
        expect(existsSync(call.signaturePath)).toBe(false);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("恢复完全匹配的草稿，只执行发布与必要的 Latest PATCH", async () => {
    const fixture = createFixture();
    const release = matchingRelease(fixture);
    const github = createFakeGitHub({ releases: [release] });

    try {
      await runPublish(fixture, github);

      expect(release.draft).toBe(false);
      expect(github.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      expect(
        github.requests.filter(
          (request) => request.method === "PATCH" && request.body.draft === false,
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("完全匹配且已发布时跳过发布 PATCH，Latest 正确时不写入", async () => {
    const fixture = createFixture();
    const release = matchingRelease(fixture, { draft: false });
    const github = createFakeGitHub({ releases: [release], latestId: release.id });

    try {
      const verifierCalls = await runPublish(fixture, github);

      expect(writeRequests(github)).toHaveLength(0);
      expect(verifierCalls).toHaveLength(2);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("拒绝预发布或同标签重复 Release，且不执行写请求", async () => {
    const fixture = createFixture();

    try {
      const prerelease = matchingRelease(fixture, { prerelease: true });
      const prereleaseGithub = createFakeGitHub({ releases: [prerelease] });
      await expect(runPublish(fixture, prereleaseGithub)).rejects.toThrow("预发布");
      expect(writeRequests(prereleaseGithub)).toHaveLength(0);

      const duplicateGithub = createFakeGitHub({
        releases: [matchingRelease(fixture), matchingRelease(fixture, { id: 102 })],
      });
      await expect(runPublish(fixture, duplicateGithub)).rejects.toThrow("同标签");
      expect(writeRequests(duplicateGithub)).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("拒绝既有 Release 的 tag、target_commitish 或名称不匹配", async () => {
    const fixture = createFixture();

    try {
      const cases = [
        {
          release: matchingRelease(fixture, { target_commitish: "main" }),
          message: "target_commitish",
        },
        {
          release: matchingRelease(fixture, { name: `Wrong ${TAG}` }),
          message: "名称",
        },
        {
          release: matchingRelease(fixture),
          detailOverride: (release: any) => ({ ...release, tag_name: "v1.2.4" }),
          message: "tag",
        },
      ];

      for (const item of cases) {
        const github = createFakeGitHub({
          releases: [item.release],
          detailOverride: item.detailOverride,
        });
        await expect(runPublish(fixture, github)).rejects.toThrow(item.message);
        expect(writeRequests(github)).toHaveLength(0);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("既有草稿的精确 partial 资产可补传并完成发布", async () => {
    const fixture = createFixture();
    const release = matchingRelease(fixture);
    release.assets.pop();
    const github = createFakeGitHub({ releases: [release] });

    try {
      await runPublish(fixture, github);
      expect(release.assets).toHaveLength(5);
      expect(release.draft).toBe(false);
      expect(github.latestId).toBe(release.id);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("对 extra、open、null digest 与同 size 错 digest 全部 fail closed", async () => {
    const fixture = createFixture();

    try {
      const cases = [
        {
          mutate: (release: any) =>
            release.assets.push({
              ...remoteAsset(fixture.paths.exePath, 9999),
              name: "unexpected.bin",
            }),
          message: "额外",
        },
        {
          mutate: (release: any) => (release.assets[0].state = "open"),
          message: "uploaded",
        },
        {
          mutate: (release: any) => (release.assets[0].digest = null),
          message: "digest",
        },
        {
          mutate: (release: any) =>
            (release.assets[0].digest = `sha256:${"0".repeat(64)}`),
          message: "digest 不一致",
        },
      ];

      for (const item of cases) {
        const release = matchingRelease(fixture);
        item.mutate(release);
        const github = createFakeGitHub({ releases: [release] });

        await expect(runPublish(fixture, github)).rejects.toThrow(item.message);
        expect(writeRequests(github)).toHaveLength(0);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("API metadata 即使匹配，也拒绝下载后的同 size 错字节", async () => {
    const fixture = createFixture();
    const release = matchingRelease(fixture, { draft: false });
    release.assets[0].bytes = Buffer.from("tampered-bytes!");
    const github = createFakeGitHub({ releases: [release], latestId: release.id });

    try {
      await expect(runPublish(fixture, github)).rejects.toThrow("digest 不一致");
      expect(writeRequests(github)).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("跨 run 重建字节不同时，使用远端签名 provenance 恢复既有 published Release", async () => {
    const fixture = createFixture();
    const release = matchingRelease(fixture, { draft: false });
    const github = createFakeGitHub({ releases: [release], latestId: release.id });

    try {
      const rebuiltSignature = "rebuilt-executable-signature\n";
      const rebuiltManifest = JSON.parse(
        readFileSync(fixture.paths.manifestPath, "utf8"),
      );
      rebuiltManifest.platforms["windows-x86_64"].signature = rebuiltSignature;
      rebuiltManifest.platforms["windows-x86_64-nsis"].signature =
        rebuiltSignature;

      writeFileSync(fixture.paths.exePath, "rebuilt-installer-bytes", "utf8");
      writeFileSync(fixture.paths.exeSigPath, rebuiltSignature, "utf8");
      writeFileSync(
        fixture.paths.manifestPath,
        `${JSON.stringify(rebuiltManifest, null, 2)}\n`,
        "utf8",
      );
      writeProvenance(fixture.paths);
      writeFileSync(
        fixture.paths.provenanceSigPath,
        "rebuilt-provenance-signature\n",
        "utf8",
      );

      const verifierCalls = await runPublish(fixture, github);

      expect(writeRequests(github)).toHaveLength(0);
      expect(verifierCalls).toHaveLength(2);
      expect(verifierCalls[0].artifactBytes.toString("utf8")).toBe(
        "installer-bytes",
      );
      expect(verifierCalls[1].artifactBytes.toString("utf8")).toBe(
        release.assets[3].bytes.toString("utf8"),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("不信任远端返回的下载与上传 URL，避免向任意主机发送 token", async () => {
    const existingFixture = createFixture();
    const existing = matchingRelease(existingFixture, { draft: false });
    for (const asset of existing.assets) {
      asset.url = `https://attacker.invalid/assets/${asset.id}`;
    }
    const existingGithub = createFakeGitHub({
      releases: [existing],
      latestId: existing.id,
    });

    try {
      await runPublish(existingFixture, existingGithub);
      expect(
        existingGithub.requests.some(
          (request) => new URL(request.url).hostname === "attacker.invalid",
        ),
      ).toBe(false);
    } finally {
      rmSync(existingFixture.root, { recursive: true, force: true });
    }

    const newFixture = createFixture();
    const newGithub = createFakeGitHub({
      createdUploadUrl: "https://attacker.invalid/upload{?name,label}",
    });

    try {
      await runPublish(newFixture, newGithub);
      expect(
        newGithub.requests.some(
          (request) => new URL(request.url).hostname === "attacker.invalid",
        ),
      ).toBe(false);
    } finally {
      rmSync(newFixture.root, { recursive: true, force: true });
    }
  });

  test("tag peeled commit 不符或提交尚未进入默认分支时禁止写入", async () => {
    const fixture = createFixture();

    try {
      const wrongTagGithub = createFakeGitHub({
        tagSha: "fedcba9876543210fedcba9876543210fedcba98",
      });
      await expect(runPublish(fixture, wrongTagGithub)).rejects.toThrow("tag");
      expect(writeRequests(wrongTagGithub)).toHaveLength(0);

      const behindGithub = createFakeGitHub({ compareStatus: "behind" });
      await expect(runPublish(fixture, behindGithub)).rejects.toThrow("默认分支");
      expect(writeRequests(behindGithub)).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("创建响应丢失后，通过重新列举唯一匹配草稿安全恢复", async () => {
    const fixture = createFixture();
    const github = createFakeGitHub({ faults: { createResponseLost: true } });

    try {
      await runPublish(fixture, github);

      expect(github.releases).toHaveLength(1);
      expect(github.releases[0].draft).toBe(false);
      expect(
        github.requests.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).hostname === "api.github.com",
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("创建返回后重新列举，若同标签出现并发重复则禁止上传", async () => {
    const fixture = createFixture();
    const github = createFakeGitHub({ duplicateAfterCreate: true });

    try {
      await expect(runPublish(fixture, github)).rejects.toThrow("同标签");
      expect(
        github.requests.filter(
          (request) => new URL(request.url).hostname === "uploads.github.com",
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("最后一个上传响应丢失但五项远端资产 exact 时继续", async () => {
    const fixture = createFixture();
    const github = createFakeGitHub({
      faults: {
        uploadResponseLostName: basename(fixture.paths.provenanceSigPath),
      },
    });

    try {
      await runPublish(fixture, github);

      expect(github.releases[0].assets).toHaveLength(5);
      expect(github.releases[0].draft).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("任一上传响应丢失后按精确 partial 资产安全续传", async () => {
    const fixture = createFixture();
    const github = createFakeGitHub({
      faults: { uploadResponseLostName: basename(fixture.paths.exePath) },
    });

    try {
      await runPublish(fixture, github);
      expect(github.releases[0].draft).toBe(false);
      expect(github.releases[0].assets).toHaveLength(5);
      expect(github.latestId).toBe(github.releases[0].id);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("新 Release 在远端复验完成前若被并发公开则 fail closed", async () => {
    const fixture = createFixture();
    const github = createFakeGitHub({
      publishDuringUploadName: basename(fixture.paths.provenanceSigPath),
    });

    try {
      await expect(runPublish(fixture, github)).rejects.toThrow("验证完成前");
      expect(
        github.requests.filter(
          (request) => request.method === "PATCH" && request.body.draft === false,
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("发布响应丢失但重读已 published 时继续", async () => {
    const fixture = createFixture();
    const release = matchingRelease(fixture);
    const github = createFakeGitHub({
      releases: [release],
      faults: { publishResponseLost: true },
    });

    try {
      await runPublish(fixture, github);
      expect(release.draft).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("Immutable releases 设置漂移时拒绝把发布标记为成功", async () => {
    const fixture = createFixture();
    const github = createFakeGitHub({ immutableOnPublish: false });

    try {
      await expect(runPublish(fixture, github)).rejects.toThrow(
        `Release ${TAG} 未启用 immutable`,
      );
      expect(github.latestId).toBeNull();
      expect(
        github.requests.filter(
          (request) =>
            request.method === "PATCH" && request.body.make_latest === "true",
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("发布前 source 复验期间若资产 metadata 改变则禁止公开", async () => {
    const fixture = createFixture();
    const release = matchingRelease(fixture);
    const github = createFakeGitHub({
      releases: [release],
      mutateOnTagRead: {
        count: 2,
        mutate: (releases) => {
          releases[0].assets[0].digest = `sha256:${"0".repeat(64)}`;
        },
      },
    });

    try {
      await expect(runPublish(fixture, github)).rejects.toThrow("digest 不一致");
      expect(release.draft).toBe(true);
      expect(
        github.requests.filter(
          (request) => request.method === "PATCH" && request.body.draft === false,
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("Latest PATCH 响应丢失但权威 latest 已匹配时继续", async () => {
    const fixture = createFixture();
    const release = matchingRelease(fixture, { draft: false });
    const github = createFakeGitHub({
      releases: [release],
      faults: { latestResponseLost: true },
    });

    try {
      await runPublish(fixture, github);
      expect(github.latestId).toBe(release.id);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("Latest 跨分页发现更高严格 SemVer Release 时 fail closed", async () => {
    const fixture = createFixture();
    const current = matchingRelease(fixture, { draft: false, id: 1 });
    const filler = Array.from({ length: 100 }, (_, index) => ({
      id: 10_000 + index,
      tag_name: `v0.0.${index}`,
      target_commitish: COMMIT_SHA,
      name: `Filler ${index}`,
      draft: false,
      prerelease: false,
      assets: [],
    }));
    const highest = {
      id: 50_000,
      tag_name:
        "v900719925474099312345678901234567890.12345678901234567890.99999999999999999999",
      target_commitish: COMMIT_SHA,
      name: "Highest",
      draft: false,
      prerelease: false,
      assets: [],
    };
    const github = createFakeGitHub({
      releases: [current, ...filler, highest],
      latestId: current.id,
    });

    try {
      await expect(runPublish(fixture, github)).rejects.toThrow(
        `存在高于当前 ${TAG} 的公开 Release: ${highest.tag_name}`,
      );
      expect(github.latestId).toBe(current.id);
      expect(
        github.requests.some(
          (request) =>
            request.method === "GET" &&
            new URL(request.url).searchParams.get("page") === "2",
        ),
      ).toBe(true);
      expect(
        github.requests.filter(
          (request) =>
            request.method === "PATCH" &&
            request.body.make_latest === "true",
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("严格校验 latest.json 的版本、两个平台、URL 与原样签名", async () => {
    const mutations = [
      (manifest: any) => (manifest.version = "1.2.4"),
      (manifest: any) => delete manifest.platforms["windows-x86_64"],
      (manifest: any) => (manifest.platforms.extra = manifest.platforms["windows-x86_64"]),
      (manifest: any) => (manifest.platforms["windows-x86_64"].url = "https://example.invalid/file.exe"),
      (manifest: any) => (manifest.platforms["windows-x86_64"].signature = "changed"),
    ];

    for (const mutate of mutations) {
      const fixture = createFixture();

      try {
        const manifest = JSON.parse(readFileSync(fixture.paths.manifestPath, "utf8"));
        mutate(manifest);
        writeFileSync(
          fixture.paths.manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
        writeProvenance(fixture.paths);
        const release = matchingRelease(fixture, { draft: false });
        const github = createFakeGitHub({ releases: [release], latestId: release.id });

        await expect(runPublish(fixture, github)).rejects.toThrow("latest.json");
        expect(writeRequests(github)).toHaveLength(0);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("拒绝远端 latest.json 中无效的 UTF-8", async () => {
    const fixture = createFixture();

    try {
      writeFileSync(fixture.paths.manifestPath, Uint8Array.of(0xff));
      writeProvenance(fixture.paths);
      const release = matchingRelease(fixture, { draft: false });
      const github = createFakeGitHub({ releases: [release], latestId: release.id });

      await expect(runPublish(fixture, github)).rejects.toThrow(
        "latest.json 不是有效的 UTF-8",
      );
      expect(writeRequests(github)).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("拒绝远端安装包签名中无效的 UTF-8", async () => {
    const fixture = createFixture();

    try {
      writeFileSync(fixture.paths.exeSigPath, Uint8Array.of(0xff));
      const manifest = JSON.parse(
        readFileSync(fixture.paths.manifestPath, "utf8"),
      );
      manifest.platforms["windows-x86_64"].signature = "�";
      manifest.platforms["windows-x86_64-nsis"].signature = "�";
      writeFileSync(
        fixture.paths.manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      writeProvenance(fixture.paths);
      const release = matchingRelease(fixture, { draft: false });
      const github = createFakeGitHub({ releases: [release], latestId: release.id });

      await expect(runPublish(fixture, github)).rejects.toThrow(
        "安装包签名 不是有效的 UTF-8",
      );
      expect(writeRequests(github)).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("拒绝远端 release-provenance.json 中无效的 UTF-8", async () => {
    const fixture = createFixture();

    try {
      writeFileSync(fixture.paths.provenancePath, Uint8Array.of(0xff));
      const release = matchingRelease(fixture, { draft: false });
      const github = createFakeGitHub({ releases: [release], latestId: release.id });

      await expect(runPublish(fixture, github)).rejects.toThrow(
        "release-provenance.json 不是有效的 UTF-8",
      );
      expect(writeRequests(github)).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

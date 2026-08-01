import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { downloadDraftRelease } from "./download-draft-release.mjs";

const REPOSITORY = "zzstar101/Mineradio-Tauri";
const TAG = "v1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RELEASE_ID = 101;
const INSTALLER = "MineRadio-Tauri_1.2.3_x64-setup.exe";

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture() {
  const content = new Map<string, Uint8Array>([
    [INSTALLER, Buffer.from("installer")],
    [`${INSTALLER}.sig`, Buffer.from("installer-signature")],
    ["latest.json", Buffer.from("manifest")],
    ["release-provenance.json", Buffer.from("provenance")],
    ["release-provenance.json.sig", Buffer.from("provenance-signature")],
  ]);
  const assets = [...content].map(([name, bytes], index) => ({
    id: 1_000 + index,
    name,
    size: bytes.byteLength,
    state: "uploaded",
    digest: sha256(bytes),
  }));
  return { content, assets };
}

function input(stagingDirectory: string) {
  return {
    repository: REPOSITORY,
    tag: TAG,
    commitSha: COMMIT,
    releaseId: RELEASE_ID,
    stagingDirectory,
  };
}

function fakeGitHub(options: {
  mutate?: (release: any) => void;
  mutateOnRecheck?: (release: any) => void;
  redirect?: boolean;
} = {}) {
  const data = fixture();
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const release = {
    id: RELEASE_ID,
    tag_name: TAG,
    target_commitish: COMMIT,
    name: `MineRadio-Tauri ${TAG}`,
    draft: true,
    prerelease: false,
    assets: data.assets,
  };
  options.mutate?.(release);
  let releaseReads = 0;

  const fetch = async (raw: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(raw.toString());
    const authorization = new Headers(init.headers).get("authorization");
    requests.push({ url: url.toString(), authorization });
    if (url.pathname.endsWith(`/releases/${RELEASE_ID}`)) {
      releaseReads += 1;
      if (releaseReads === 2) {
        options.mutateOnRecheck?.(release);
      }
      return Response.json(release);
    }
    const match = url.pathname.match(/\/releases\/assets\/(\d+)$/);
    if (match) {
      const asset = data.assets.find((value) => value.id === Number(match[1]));
      if (options.redirect) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://release-assets.githubusercontent.com/draft/${asset.id}`,
          },
        });
      }
      return new Response(data.content.get(asset.name), {
        headers: { "content-length": String(asset.size) },
      });
    }
    if (url.hostname === "release-assets.githubusercontent.com") {
      const id = Number(url.pathname.split("/").at(-1));
      const asset = data.assets.find((value) => value.id === id);
      return new Response(data.content.get(asset.name), {
        headers: { "content-length": String(asset.size) },
      });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  };
  return { data, fetch, release, requests };
}

test("按 exact release id 下载五项只读资产且不把 token 带到 CDN", async () => {
  const parent = mkdtempSync(join(tmpdir(), "mineradio-draft-download-"));
  const staging = join(parent, "staging");
  const github = fakeGitHub({ redirect: true });
  try {
    const result = await downloadDraftRelease(input(staging), {
      fetch: github.fetch,
      env: { GITHUB_TOKEN: "secret-token" },
    });

    expect(result.assets).toHaveLength(5);
    expect(result.releaseId).toBe(RELEASE_ID);
    expect(
      github.requests.filter((request) =>
        new URL(request.url).pathname.endsWith(`/releases/${RELEASE_ID}`),
      ),
    ).toHaveLength(2);
    for (const [name, bytes] of github.data.content) {
      expect(readFileSync(join(staging, name))).toEqual(Buffer.from(bytes));
    }
    expect(
      github.requests
        .filter((request) => new URL(request.url).hostname === "api.github.com")
        .every((request) => request.authorization === "Bearer secret-token"),
    ).toBe(true);
    expect(
      github.requests
        .filter(
          (request) =>
            new URL(request.url).hostname === "release-assets.githubusercontent.com",
        )
        .every((request) => request.authorization === null),
    ).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("下载完成后 Draft identity 或资产 authority 发生变化时 fail closed 并清理 staging", async () => {
  const mutations = [
    (release: any) => (release.draft = false),
    (release: any) => (release.target_commitish = "f".repeat(40)),
    (release: any) => (release.assets[0].id += 10_000),
    (release: any) => (release.assets[0].name = "replacement.exe"),
    (release: any) => (release.assets[0].state = "new"),
    (release: any) => (release.assets[0].size += 1),
    (release: any) =>
      (release.assets[0].digest = `sha256:${"0".repeat(64)}`),
  ];

  for (const mutateOnRecheck of mutations) {
    const parent = mkdtempSync(join(tmpdir(), "mineradio-draft-download-"));
    const staging = join(parent, "staging");
    const github = fakeGitHub({ mutateOnRecheck });
    try {
      await expect(
        downloadDraftRelease(input(staging), {
          fetch: github.fetch,
          env: { GITHUB_TOKEN: "secret-token" },
        }),
      ).rejects.toThrow();
      expect(existsSync(staging)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

test("非 draft、资产缺失或 digest 不符均 fail closed 并清理 staging", async () => {
  const cases = [
    (release: any) => (release.draft = false),
    (release: any) => release.assets.pop(),
    (release: any) => (release.assets[0].digest = `sha256:${"0".repeat(64)}`),
  ];

  for (const mutate of cases) {
    const parent = mkdtempSync(join(tmpdir(), "mineradio-draft-download-"));
    const staging = join(parent, "staging");
    const github = fakeGitHub({ mutate });
    try {
      await expect(
        downloadDraftRelease(input(staging), {
          fetch: github.fetch,
          env: { GITHUB_TOKEN: "secret-token" },
        }),
      ).rejects.toThrow();
      expect(existsSync(staging)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

test("staging 已存在时拒绝覆盖", async () => {
  const parent = mkdtempSync(join(tmpdir(), "mineradio-draft-download-"));
  const github = fakeGitHub();
  try {
    await expect(
      downloadDraftRelease(input(parent), {
        fetch: github.fetch,
        env: { GITHUB_TOKEN: "secret-token" },
      }),
    ).rejects.toThrow();
    expect(github.requests).toHaveLength(0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("CDN redirect 拒绝凭据、非默认端口与 fragment", async () => {
  const redirects = [
    "https://attacker@release-assets.githubusercontent.com/draft/1",
    "https://release-assets.githubusercontent.com:444/draft/1",
    "https://release-assets.githubusercontent.com/draft/1#fragment",
  ];

  for (const location of redirects) {
    const parent = mkdtempSync(join(tmpdir(), "mineradio-draft-download-"));
    const staging = join(parent, "staging");
    const github = fakeGitHub();
    const fetch = async (raw: RequestInfo | URL) => {
      const url = new URL(raw.toString());
      if (url.pathname.endsWith(`/releases/${RELEASE_ID}`)) {
        return Response.json(github.release);
      }
      return new Response(null, { status: 302, headers: { location } });
    };
    try {
      await expect(
        downloadDraftRelease(input(staging), {
          fetch,
          env: { GITHUB_TOKEN: "secret-token" },
        }),
      ).rejects.toThrow("Draft asset redirect host 不受允许");
      expect(existsSync(staging)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

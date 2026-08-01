import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { downloadPreviousRelease } from "./download-previous-release.mjs";

const REPOSITORY = "zzstar101/Mineradio-Tauri";

function release(version: string, id: number, overrides: Record<string, unknown> = {}) {
  const installer = `MineRadio-Tauri_${version}_x64-setup.exe`;
  const files = [
    [installer, Buffer.from(`installer-${version}`)],
    [`${installer}.sig`, Buffer.from(`signature-${version}`)],
    ["latest.json", Buffer.from(`manifest-${version}`)],
    ["release-provenance.json", Buffer.from(`provenance-${version}`)],
    ["release-provenance.json.sig", Buffer.from(`provenance-signature-${version}`)],
  ] as const;
  return {
    id,
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    immutable: true,
    assets: files.map(([name, bytes], index) => ({
      id: id * 100 + index,
      name,
      size: bytes.byteLength,
      state: "uploaded",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      bytes,
    })),
    ...overrides,
  };
}

function fakeGitHub(releases: any[]) {
  const fetch = async (raw: RequestInfo | URL) => {
    const url = new URL(raw.toString());
    if (url.pathname.endsWith("/releases")) {
      return Response.json(releases);
    }
    const match = url.pathname.match(/\/releases\/assets\/(\d+)$/);
    const asset = releases
      .flatMap((value) => value.assets)
      .find((value) => value.id === Number(match?.[1]));
    return asset
      ? new Response(asset.bytes, {
          headers: { "content-length": String(asset.size) },
        })
      : Response.json({ message: "not found" }, { status: 404 });
  };
  return { fetch };
}

test("选择严格低于 N 的最高稳定 Release，并兼容历史三件套", async () => {
  const parent = mkdtempSync(join(tmpdir(), "mineradio-previous-release-"));
  const historical = release("0.10.0", 91);
  historical.immutable = false;
  historical.assets = historical.assets.filter(
    (asset) =>
      asset.name === "latest.json" ||
      asset.name.endsWith(".exe") ||
      asset.name.endsWith(".exe.sig"),
  );
  const github = fakeGitHub([
    release("0.9.0", 90),
    historical,
    release("0.11.0", 92, { prerelease: true }),
  ]);
  try {
    const result = await downloadPreviousRelease(
      {
        repository: REPOSITORY,
        currentTag: "v1.0.0",
        stagingDirectory: join(parent, "staging"),
      },
      { fetch: github.fetch, env: { GITHUB_TOKEN: "secret" } },
    );

    expect(result.version).toBe("0.10.0");
    expect(result.releaseId).toBe(91);
    expect(result.installerPath.endsWith("MineRadio-Tauri_0.10.0_x64-setup.exe")).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("发现任一不低于候选版的正式 Release 时在下载前失败", async () => {
  for (const version of ["1.0.0", "1.0.1"]) {
    const parent = mkdtempSync(join(tmpdir(), "mineradio-previous-release-"));
    try {
      await expect(
        downloadPreviousRelease(
          {
            repository: REPOSITORY,
            currentTag: "v1.0.0",
            stagingDirectory: join(parent, "staging"),
          },
          {
            fetch: fakeGitHub([release("0.10.0", 91), release(version, 100)]).fetch,
            env: { GITHUB_TOKEN: "secret" },
          },
        ),
      ).rejects.toThrow("已存在不低于候选版的正式 Release");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

test("没有 N−1 或最高候选缺少签名时 fail closed", async () => {
  for (const releases of [
    [release("1.0.0", 100)],
    [
      release("0.9.0", 90, {
        immutable: false,
        assets: release("0.9.0", 90).assets.filter(
          (asset) => !asset.name.endsWith(".sig"),
        ),
      }),
    ],
  ]) {
    const parent = mkdtempSync(join(tmpdir(), "mineradio-previous-release-"));
    try {
      await expect(
        downloadPreviousRelease(
          {
            repository: REPOSITORY,
            currentTag: "v1.0.0",
            stagingDirectory: join(parent, "staging"),
          },
          { fetch: fakeGitHub(releases).fetch, env: { GITHUB_TOKEN: "secret" } },
        ),
      ).rejects.toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

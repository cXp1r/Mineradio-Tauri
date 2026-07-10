import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeLocalAssets,
  verifyReleaseAssets,
} from "./verify-release-assets.mjs";

const alphaAsset = {
  name: "alpha.bin",
  size: 5,
  digest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const betaAsset = {
  name: "beta.bin",
  size: 4,
  digest:
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};
const cliPath = fileURLToPath(
  new URL("./verify-release-assets.mjs", import.meta.url),
);

describe("describeLocalAssets", () => {
  test("按文件名排序并返回本地资产的字节数与 SHA-256", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-assets-"),
    );

    try {
      const betaPath = join(temporaryRoot, "beta.bin");
      const alphaPath = join(temporaryRoot, "alpha.bin");
      writeFileSync(betaPath, "beta", "utf8");
      writeFileSync(alphaPath, "alpha", "utf8");

      expect(describeLocalAssets([betaPath, alphaPath])).toEqual([
        {
          name: "alpha.bin",
          size: 5,
          digest:
            "sha256:8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
        },
        {
          name: "beta.bin",
          size: 4,
          digest:
            "sha256:f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753",
        },
      ]);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝目录路径", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-assets-directory-"),
    );
    const directoryPath = join(temporaryRoot, "asset.bin");

    try {
      mkdirSync(directoryPath);

      expect(() => describeLocalAssets([directoryPath])).toThrow(
        `发布资产不是普通文件: ${directoryPath}`,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝不存在的文件", () => {
    const missingPath = join(
      tmpdir(),
      `mineradio-release-assets-missing-${crypto.randomUUID()}.bin`,
    );

    expect(() => describeLocalAssets([missingPath])).toThrow(
      `发布资产不存在: ${missingPath}`,
    );
  });

  test("拒绝零字节文件", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-assets-empty-"),
    );
    const emptyPath = join(temporaryRoot, "empty.bin");

    try {
      writeFileSync(emptyPath, "", "utf8");

      expect(() => describeLocalAssets([emptyPath])).toThrow(
        `发布资产不能为空: ${emptyPath}`,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝 basename 重复的本地文件", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-assets-duplicate-"),
    );
    const firstDirectory = join(temporaryRoot, "first");
    const secondDirectory = join(temporaryRoot, "second");
    const firstPath = join(firstDirectory, "asset.bin");
    const secondPath = join(secondDirectory, "asset.bin");

    try {
      mkdirSync(firstDirectory);
      mkdirSync(secondDirectory);
      writeFileSync(firstPath, "first", "utf8");
      writeFileSync(secondPath, "second", "utf8");

      expect(() => describeLocalAssets([firstPath, secondPath])).toThrow(
        "本地发布资产名称重复: asset.bin",
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("verifyReleaseAssets", () => {
  test("接受完全一致的资产并返回按名称排序的 descriptors", () => {
    expect(
      verifyReleaseAssets({
        remoteAssets: [
          { ...betaAsset, state: "uploaded", id: 2 },
          { ...alphaAsset, state: "uploaded", id: 1 },
        ],
        localAssets: [betaAsset, alphaAsset],
      }),
    ).toEqual([alphaAsset, betaAsset]);
  });

  test("拒绝 state=open 的远端资产", () => {
    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [{ ...alphaAsset, state: "open" }],
        localAssets: [alphaAsset],
      }),
    ).toThrow("远端发布资产 alpha.bin 状态不是 uploaded: open");
  });

  test("拒绝 digest=null 的远端资产", () => {
    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [
          { ...alphaAsset, state: "uploaded", digest: null },
        ],
        localAssets: [alphaAsset],
      }),
    ).toThrow("远端发布资产 alpha.bin 缺少 digest");
  });

  test("拒绝 size 相同但 digest 不同的资产", () => {
    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [
          {
            ...alphaAsset,
            state: "uploaded",
            digest:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          },
        ],
        localAssets: [alphaAsset],
      }),
    ).toThrow("远端发布资产 alpha.bin digest 不一致");
  });

  test("拒绝 size 不同的资产", () => {
    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [
          { ...alphaAsset, state: "uploaded", size: alphaAsset.size + 1 },
        ],
        localAssets: [alphaAsset],
      }),
    ).toThrow("远端发布资产 alpha.bin size 不一致: remote=6, local=5");
  });

  test("即使远端与本地 size 都是零也拒绝", () => {
    const zeroByteAsset = { ...alphaAsset, size: 0 };

    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [{ ...zeroByteAsset, state: "uploaded" }],
        localAssets: [zeroByteAsset],
      }),
    ).toThrow("远端发布资产 alpha.bin size 必须大于 0: 0");
  });

  test("拒绝远端缺失本地资产", () => {
    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [{ ...alphaAsset, state: "uploaded" }],
        localAssets: [alphaAsset, betaAsset],
      }),
    ).toThrow("远端发布缺少本地资产: beta.bin");
  });

  test("拒绝远端存在额外资产", () => {
    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [
          { ...alphaAsset, state: "uploaded" },
          { ...betaAsset, state: "uploaded" },
        ],
        localAssets: [alphaAsset],
      }),
    ).toThrow("远端发布存在额外资产: beta.bin");
  });

  test("拒绝远端资产名称重复", () => {
    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [
          { ...alphaAsset, state: "uploaded", id: 1 },
          { ...alphaAsset, state: "uploaded", id: 2 },
        ],
        localAssets: [alphaAsset],
      }),
    ).toThrow("远端发布资产名称重复: alpha.bin");
  });

  test("拒绝传入重复名称的本地 descriptors", () => {
    expect(() =>
      verifyReleaseAssets({
        remoteAssets: [{ ...alphaAsset, state: "uploaded" }],
        localAssets: [alphaAsset, { ...alphaAsset }],
      }),
    ).toThrow("本地发布资产名称重复: alpha.bin");
  });
});

describe("verify-release-assets CLI", () => {
  test("验证 REST assets 数组与本地文件后输出中文成功信息", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-assets-cli-success-"),
    );

    try {
      const executablePath = join(temporaryRoot, "安装包.exe");
      const signaturePath = join(temporaryRoot, "安装包.exe.sig");
      const releaseAssetsPath = join(temporaryRoot, "release-assets.json");
      writeFileSync(executablePath, "MZ-release", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");

      const remoteAssets = describeLocalAssets([
        executablePath,
        signaturePath,
      ]).map((asset, index) => ({
        ...asset,
        state: "uploaded",
        id: index + 1,
      }));
      writeFileSync(
        releaseAssetsPath,
        `${JSON.stringify(remoteAssets, null, 2)}\n`,
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [cliPath, releaseAssetsPath, executablePath, signaturePath],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("发布资产验证通过: 2 个文件");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("校验失败时以非零状态输出中文错误", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-assets-cli-failure-"),
    );

    try {
      const assetPath = join(temporaryRoot, "asset.bin");
      const releaseAssetsPath = join(temporaryRoot, "release-assets.json");
      writeFileSync(assetPath, "release-bytes", "utf8");

      const [localAsset] = describeLocalAssets([assetPath]);
      writeFileSync(
        releaseAssetsPath,
        JSON.stringify([
          {
            ...localAsset,
            state: "uploaded",
            digest:
              "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          },
        ]),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [cliPath, releaseAssetsPath, assetPath],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "发布资产验证失败: 远端发布资产 asset.bin digest 不一致",
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝不是有效 UTF-8 的 assets JSON", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-assets-invalid-utf8-"),
    );

    try {
      const assetPath = join(temporaryRoot, "asset.bin");
      const releaseAssetsPath = join(temporaryRoot, "release-assets.json");
      writeFileSync(assetPath, "release-bytes", "utf8");
      writeFileSync(releaseAssetsPath, Uint8Array.of(0xff));

      const result = spawnSync(
        process.execPath,
        [cliPath, releaseAssetsPath, assetPath],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("assets JSON 不是有效的 UTF-8");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

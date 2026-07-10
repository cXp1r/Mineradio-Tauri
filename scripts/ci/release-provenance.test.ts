import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  createReleaseProvenance,
  verifyReleaseProvenance,
} from "./release-provenance.mjs";

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

const cliPath = fileURLToPath(
  new URL("./release-provenance.mjs", import.meta.url),
);

describe("createReleaseProvenance", () => {
  test("生成固定 schema，并按名称排序记录三项发布资产", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-create-"),
    );

    try {
      const executableName = "MineRadio-Tauri_1.2.3_x64-setup.exe";
      const executablePath = join(temporaryRoot, executableName);
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      writeFileSync(executablePath, "installer", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, '{"version":"1.2.3"}\n', "utf8");

      expect(
        createReleaseProvenance({
          repository: "zzstar101/Mineradio-Tauri",
          tag: "v1.2.3",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          assetPaths: [manifestPath, signaturePath, executablePath],
        }),
      ).toEqual({
        schema_version: 1,
        repository: "zzstar101/Mineradio-Tauri",
        tag: "v1.2.3",
        commit_sha: "0123456789abcdef0123456789abcdef01234567",
        assets: [
          {
            name: executableName,
            size: 9,
            sha256: sha256("installer"),
          },
          {
            name: `${executableName}.sig`,
            size: 9,
            sha256: sha256("signature"),
          },
          {
            name: "latest.json",
            size: 20,
            sha256: sha256('{"version":"1.2.3"}\n'),
          },
        ],
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝非严格 owner/name 格式的仓库", () => {
    for (const repository of [
      "zzstar101",
      "zzstar101/Mineradio-Tauri/extra",
      "/Mineradio-Tauri",
      "zzstar101/",
      "owner--name/repository",
      "owner/repository?download=1",
      "owner/..",
    ]) {
      expect(() =>
        createReleaseProvenance({
          repository,
          tag: "v1.2.3",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          assetPaths: [],
        }),
      ).toThrow("仓库必须使用严格的 owner/name 格式");
    }
  });

  test("拒绝不符合 vX.Y.Z 的发布标签", () => {
    for (const tag of [
      "1.2.3",
      "v1.2",
      "v1.2.3-beta",
      "v01.2.3",
      "v1.02.3",
      "v1.2.03",
    ]) {
      expect(() =>
        createReleaseProvenance({
          repository: "zzstar101/Mineradio-Tauri",
          tag,
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          assetPaths: [],
        }),
      ).toThrow(`发布标签 "${tag}" 格式无效，必须匹配 vX.Y.Z`);
    }
  });

  test("拒绝非 40 位小写十六进制的 commit SHA", () => {
    for (const commitSha of [
      "0123456789abcdef0123456789abcdef0123456",
      "0123456789abcdef0123456789abcdef012345678",
      "0123456789ABCDEF0123456789ABCDEF01234567",
      "g123456789abcdef0123456789abcdef01234567",
      "sha256:0123456789abcdef0123456789abcdef01234567",
    ]) {
      expect(() =>
        createReleaseProvenance({
          repository: "zzstar101/Mineradio-Tauri",
          tag: "v1.2.3",
          commitSha,
          assetPaths: [],
        }),
      ).toThrow("提交 SHA 必须是 40 位小写十六进制");
    }
  });

  test("要求资产集合恰好包含对应版本安装包、签名与 latest.json", () => {
    const executableName = "MineRadio-Tauri_1.2.3_x64-setup.exe";
    const validInput = {
      repository: "zzstar101/Mineradio-Tauri",
      tag: "v1.2.3",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    };

    expect(() =>
      createReleaseProvenance({
        ...validInput,
        assetPaths: [executableName, `${executableName}.sig`],
      }),
    ).toThrow("发布资产集合缺少: latest.json");

    expect(() =>
      createReleaseProvenance({
        ...validInput,
        assetPaths: [
          executableName,
          `${executableName}.sig`,
          "latest.json",
          "unexpected.txt",
        ],
      }),
    ).toThrow("发布资产集合存在额外资产: unexpected.txt");

    expect(() =>
      createReleaseProvenance({
        ...validInput,
        assetPaths: [
          executableName,
          `${executableName}.sig`,
          "latest.json",
          "nested/latest.json",
        ],
      }),
    ).toThrow("发布资产名称重复: latest.json");
  });

  test("拒绝零字节发布资产", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-empty-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      writeFileSync(executablePath, "", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, "{}", "utf8");

      expect(() =>
        createReleaseProvenance({
          repository: "zzstar101/Mineradio-Tauri",
          tag: "v1.2.3",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          assetPaths: [executablePath, signaturePath, manifestPath],
        }),
      ).toThrow(`发布资产不能为空: ${executablePath}`);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("要求每个发布资产路径都指向存在的普通文件", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-file-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      const input = {
        repository: "zzstar101/Mineradio-Tauri",
        tag: "v1.2.3",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        assetPaths: [executablePath, signaturePath, manifestPath],
      };
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, "{}", "utf8");

      expect(() => createReleaseProvenance(input)).toThrow(
        `发布资产不存在: ${executablePath}`,
      );

      mkdirSync(executablePath);
      expect(() => createReleaseProvenance(input)).toThrow(
        `发布资产不是普通文件: ${executablePath}`,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("verifyReleaseProvenance", () => {
  test("接受来源与当前发布资产完全一致的证明", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-verify-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      const assetPaths = [executablePath, signaturePath, manifestPath];
      const input = {
        repository: "zzstar101/Mineradio-Tauri",
        tag: "v1.2.3",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        assetPaths,
      };
      writeFileSync(executablePath, "installer", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, '{"version":"1.2.3"}\n', "utf8");
      const provenance = createReleaseProvenance(input);

      expect(verifyReleaseProvenance({ provenance, ...input })).toEqual(
        provenance,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝仓库、标签或 commit SHA 与期望发布来源不符", () => {
    const executableName = "MineRadio-Tauri_1.2.3_x64-setup.exe";
    const asset = { size: 1, sha256: "a".repeat(64) };
    const provenance = {
      schema_version: 1,
      repository: "zzstar101/Mineradio-Tauri",
      tag: "v1.2.3",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      assets: [
        { name: executableName, ...asset },
        { name: `${executableName}.sig`, ...asset },
        { name: "latest.json", ...asset },
      ],
    };
    const commonInput = {
      provenance,
      repository: provenance.repository,
      tag: provenance.tag,
      commitSha: provenance.commit_sha,
      assetPaths: [],
    };

    expect(() =>
      verifyReleaseProvenance({
        ...commonInput,
        repository: "other/Mineradio-Tauri",
      }),
    ).toThrow(
      "来源证明仓库不一致: provenance=zzstar101/Mineradio-Tauri, expected=other/Mineradio-Tauri",
    );

    expect(() =>
      verifyReleaseProvenance({ ...commonInput, tag: "v1.2.4" }),
    ).toThrow("来源证明标签不一致: provenance=v1.2.3, expected=v1.2.4");

    expect(() =>
      verifyReleaseProvenance({
        ...commonInput,
        commitSha: "fedcba9876543210fedcba9876543210fedcba98",
      }),
    ).toThrow(
      "来源证明提交 SHA 不一致: provenance=0123456789abcdef0123456789abcdef01234567, expected=fedcba9876543210fedcba9876543210fedcba98",
    );
  });

  test("拒绝畸形的顶层 schema 与来源字段", () => {
    const validProvenance = {
      schema_version: 1,
      repository: "zzstar101/Mineradio-Tauri",
      tag: "v1.2.3",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      assets: [],
    };
    const input = {
      repository: validProvenance.repository,
      tag: validProvenance.tag,
      commitSha: validProvenance.commit_sha,
      assetPaths: [],
    };
    const cases = [
      {
        provenance: null,
        error: "来源证明必须是 JSON 对象",
      },
      {
        provenance: { ...validProvenance, schema_version: 2 },
        error: "来源证明 schema_version 必须为 1",
      },
      {
        provenance: {
          ...validProvenance,
          generated_at: "2026-07-10T00:00:00.000Z",
        },
        error: "来源证明顶层字段必须恰好为",
      },
      {
        provenance: {
          schema_version: 1,
          repository: validProvenance.repository,
          tag: validProvenance.tag,
          commit_sha: validProvenance.commit_sha,
        },
        error: "来源证明顶层字段必须恰好为",
      },
      {
        provenance: { ...validProvenance, repository: "invalid" },
        error: "来源证明 repository 字段格式无效",
      },
      {
        provenance: { ...validProvenance, tag: "1.2.3" },
        error: "来源证明 tag 字段格式无效",
      },
      {
        provenance: {
          ...validProvenance,
          commit_sha: "0123456789ABCDEF0123456789ABCDEF01234567",
        },
        error: "来源证明 commit_sha 字段格式无效",
      },
      {
        provenance: { ...validProvenance, assets: {} },
        error: "来源证明 assets 字段必须是数组",
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        verifyReleaseProvenance({
          provenance: testCase.provenance as never,
          ...input,
        }),
      ).toThrow(testCase.error);
    }
  });

  test("拒绝畸形的资产 descriptor", () => {
    const executableName = "MineRadio-Tauri_1.2.3_x64-setup.exe";
    const validAsset = {
      name: executableName,
      size: 1,
      sha256: "a".repeat(64),
    };
    const validProvenance = {
      schema_version: 1,
      repository: "zzstar101/Mineradio-Tauri",
      tag: "v1.2.3",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      assets: [
        validAsset,
        { ...validAsset, name: `${executableName}.sig` },
        { ...validAsset, name: "latest.json" },
      ],
    };
    const input = {
      repository: validProvenance.repository,
      tag: validProvenance.tag,
      commitSha: validProvenance.commit_sha,
      assetPaths: [],
    };
    const cases = [
      {
        asset: null,
        error: "来源证明 assets[0] 必须是 JSON 对象",
      },
      {
        asset: { ...validAsset, digest: `sha256:${validAsset.sha256}` },
        error: "来源证明 assets[0] 字段必须恰好为",
      },
      {
        asset: { name: validAsset.name, size: validAsset.size },
        error: "来源证明 assets[0] 字段必须恰好为",
      },
      {
        asset: { ...validAsset, name: 123 },
        error: "来源证明 assets[0].name 必须是非空字符串",
      },
      {
        asset: { ...validAsset, size: 0 },
        error: "来源证明 assets[0].size 必须是正整数",
      },
      {
        asset: { ...validAsset, size: 1.5 },
        error: "来源证明 assets[0].size 必须是正整数",
      },
      {
        asset: { ...validAsset, size: Number.MAX_SAFE_INTEGER + 1 },
        error: "来源证明 assets[0].size 必须是正整数",
      },
      {
        asset: { ...validAsset, sha256: `sha256:${validAsset.sha256}` },
        error: "来源证明 assets[0].sha256 必须是 64 位小写十六进制",
      },
      {
        asset: { ...validAsset, sha256: "A".repeat(64) },
        error: "来源证明 assets[0].sha256 必须是 64 位小写十六进制",
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        verifyReleaseProvenance({
          provenance: {
            ...validProvenance,
            assets: [testCase.asset, ...validProvenance.assets.slice(1)],
          } as never,
          ...input,
        }),
      ).toThrow(testCase.error);
    }
  });

  test("拒绝来源证明中缺失、额外或重复的资产", () => {
    const executableName = "MineRadio-Tauri_1.2.3_x64-setup.exe";
    const asset = { size: 1, sha256: "a".repeat(64) };
    const validAssets = [
      { name: executableName, ...asset },
      { name: `${executableName}.sig`, ...asset },
      { name: "latest.json", ...asset },
    ];
    const baseProvenance = {
      schema_version: 1,
      repository: "zzstar101/Mineradio-Tauri",
      tag: "v1.2.3",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      assets: validAssets,
    };
    const input = {
      repository: baseProvenance.repository,
      tag: baseProvenance.tag,
      commitSha: baseProvenance.commit_sha,
      assetPaths: [],
    };

    expect(() =>
      verifyReleaseProvenance({
        provenance: { ...baseProvenance, assets: validAssets.slice(0, 2) },
        ...input,
      }),
    ).toThrow("来源证明资产集合缺少: latest.json");

    expect(() =>
      verifyReleaseProvenance({
        provenance: {
          ...baseProvenance,
          assets: [...validAssets, { name: "unexpected.txt", ...asset }],
        },
        ...input,
      }),
    ).toThrow("来源证明资产集合存在额外资产: unexpected.txt");

    expect(() =>
      verifyReleaseProvenance({
        provenance: {
          ...baseProvenance,
          assets: [...validAssets, { ...validAssets[2] }],
        },
        ...input,
      }),
    ).toThrow("来源证明资产名称重复: latest.json");
  });

  test("要求来源证明资产按 name 升序排列", () => {
    const executableName = "MineRadio-Tauri_1.2.3_x64-setup.exe";
    const asset = { size: 1, sha256: "a".repeat(64) };
    const provenance = {
      schema_version: 1,
      repository: "zzstar101/Mineradio-Tauri",
      tag: "v1.2.3",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      assets: [
        { name: "latest.json", ...asset },
        { name: executableName, ...asset },
        { name: `${executableName}.sig`, ...asset },
      ],
    };

    expect(() =>
      verifyReleaseProvenance({
        provenance,
        repository: provenance.repository,
        tag: provenance.tag,
        commitSha: provenance.commit_sha,
        assetPaths: [],
      }),
    ).toThrow("来源证明 assets 必须按 name 升序排列");
  });

  test("拒绝当前资产的 size、SHA-256 或非零约束与证明不符", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-mismatch-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      const input = {
        repository: "zzstar101/Mineradio-Tauri",
        tag: "v1.2.3",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        assetPaths: [executablePath, signaturePath, manifestPath],
      };
      writeFileSync(executablePath, "installer", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, "{}", "utf8");
      const provenance = createReleaseProvenance(input);

      writeFileSync(executablePath, "installer!", "utf8");
      expect(() => verifyReleaseProvenance({ provenance, ...input })).toThrow(
        "资产 MineRadio-Tauri_1.2.3_x64-setup.exe size 不一致: provenance=9, local=10",
      );

      writeFileSync(executablePath, "installer", "utf8");
      writeFileSync(signaturePath, "different", "utf8");
      expect(() => verifyReleaseProvenance({ provenance, ...input })).toThrow(
        "资产 MineRadio-Tauri_1.2.3_x64-setup.exe.sig sha256 不一致",
      );

      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, "", "utf8");
      expect(() => verifyReleaseProvenance({ provenance, ...input })).toThrow(
        `发布资产不能为空: ${manifestPath}`,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("release-provenance CLI", () => {
  test("create 写入确定性的 UTF-8 pretty JSON 与末尾换行", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-cli-create-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      const firstOutputPath = join(temporaryRoot, "provenance-first.json");
      const secondOutputPath = join(temporaryRoot, "provenance-second.json");
      const repository = "zzstar101/Mineradio-Tauri";
      const tag = "v1.2.3";
      const commitSha = "0123456789abcdef0123456789abcdef01234567";
      const assetPaths = [executablePath, signaturePath, manifestPath];
      writeFileSync(executablePath, "installer", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, "{}", "utf8");

      for (const outputPath of [firstOutputPath, secondOutputPath]) {
        const result = spawnSync(
          process.execPath,
          [
            cliPath,
            "create",
            repository,
            tag,
            commitSha,
            outputPath,
            ...assetPaths,
          ],
          { encoding: "utf8" },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
      }

      const firstOutput = readFileSync(firstOutputPath, "utf8");
      const secondOutput = readFileSync(secondOutputPath, "utf8");
      const expected = `${JSON.stringify(
        createReleaseProvenance({
          repository,
          tag,
          commitSha,
          assetPaths,
        }),
        null,
        2,
      )}\n`;

      expect(firstOutput).toBe(expected);
      expect(secondOutput).toBe(firstOutput);
      expect(firstOutput.endsWith("\n")).toBe(true);
      expect(firstOutput).not.toContain("timestamp");
      expect(firstOutput).not.toContain("generated_at");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("create 拒绝输出路径覆盖发布资产输入文件", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-output-alias-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      writeFileSync(executablePath, "installer", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, "manifest", "utf8");

      for (const [outputPath, expectedContent] of [
        [executablePath, "installer"],
        [signaturePath, "signature"],
        [manifestPath, "manifest"],
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            cliPath,
            "create",
            "zzstar101/Mineradio-Tauri",
            "v1.2.3",
            "0123456789abcdef0123456789abcdef01234567",
            outputPath,
            executablePath,
            signaturePath,
            manifestPath,
          ],
          { encoding: "utf8" },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("输出路径不能覆盖发布资产输入文件");
        expect(readFileSync(outputPath, "utf8")).toBe(expectedContent);
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("create 拒绝输出路径通过 hardlink 覆盖发布资产", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-output-hardlink-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      const outputPath = join(temporaryRoot, "release-provenance.json");
      writeFileSync(executablePath, "installer", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, "manifest", "utf8");
      linkSync(manifestPath, outputPath);

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "create",
          "zzstar101/Mineradio-Tauri",
          "v1.2.3",
          "0123456789abcdef0123456789abcdef01234567",
          outputPath,
          executablePath,
          signaturePath,
          manifestPath,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("输出路径不能覆盖发布资产输入文件");
      expect(readFileSync(manifestPath, "utf8")).toBe("manifest");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("verify 成功时输出中文结果，失败时非零退出并输出中文错误", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-cli-verify-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const signaturePath = `${executablePath}.sig`;
      const manifestPath = join(temporaryRoot, "latest.json");
      const provenancePath = join(temporaryRoot, "provenance.json");
      const repository = "zzstar101/Mineradio-Tauri";
      const tag = "v1.2.3";
      const commitSha = "0123456789abcdef0123456789abcdef01234567";
      const assetPaths = [executablePath, signaturePath, manifestPath];
      writeFileSync(executablePath, "installer", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      writeFileSync(manifestPath, "{}", "utf8");
      writeFileSync(
        provenancePath,
        `${JSON.stringify(
          createReleaseProvenance({
            repository,
            tag,
            commitSha,
            assetPaths,
          }),
          null,
          2,
        )}\n`,
        "utf8",
      );
      const arguments_ = [
        cliPath,
        "verify",
        repository,
        tag,
        commitSha,
        provenancePath,
        ...assetPaths,
      ];

      const success = spawnSync(process.execPath, arguments_, { encoding: "utf8" });
      expect(success.status).toBe(0);
      expect(success.stderr).toBe("");
      expect(success.stdout).toContain("发布来源证明验证通过: 3 个资产");

      writeFileSync(signaturePath, "different", "utf8");
      const failure = spawnSync(process.execPath, arguments_, { encoding: "utf8" });
      expect(failure.status).toBe(1);
      expect(failure.stdout).toBe("");
      expect(failure.stderr).toContain("发布来源证明操作失败:");
      expect(failure.stderr).toContain("sha256 不一致");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("verify 拒绝不是有效 UTF-8 的来源证明 JSON", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-release-provenance-invalid-utf8-"),
    );

    try {
      const executablePath = join(
        temporaryRoot,
        "MineRadio-Tauri_1.2.3_x64-setup.exe",
      );
      const provenancePath = join(temporaryRoot, "provenance.json");
      writeFileSync(provenancePath, Uint8Array.of(0xff));

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "verify",
          "zzstar101/Mineradio-Tauri",
          "v1.2.3",
          "0123456789abcdef0123456789abcdef01234567",
          provenancePath,
          executablePath,
          `${executablePath}.sig`,
          join(temporaryRoot, "latest.json"),
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("来源证明 JSON 不是有效的 UTF-8");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createUpdaterManifest } from "./create-updater-manifest.mjs";

const cliPath = fileURLToPath(
  new URL("./create-updater-manifest.mjs", import.meta.url),
);

const validInput = {
  tag: "v0.1.0",
  repository: "zzstar101/Mineradio-Tauri",
  assetName: "MineRadio-Tauri_0.1.0_x64-setup.exe",
  signature: "fixed-signature-text",
  pubDate: "2026-07-10T01:02:03.000Z",
  notes: "Fixed release notes.",
};

describe("createUpdaterManifest", () => {
  test("生成包含 NSIS 与兼容 Windows 平台的 Tauri v2 updater manifest", () => {
    const platform = {
      signature: "fixed-signature-text",
      url: "https://github.com/zzstar101/Mineradio-Tauri/releases/download/v0.1.0/MineRadio-Tauri_0.1.0_x64-setup.exe",
    };
    const manifest = createUpdaterManifest(validInput);

    expect(manifest).toEqual({
      version: "0.1.0",
      notes: "Fixed release notes.",
      pub_date: "2026-07-10T01:02:03.000Z",
      platforms: {
        "windows-x86_64-nsis": platform,
        "windows-x86_64": platform,
      },
    });

    const releaseUrl = new URL(
      manifest.platforms["windows-x86_64-nsis"].url,
    );
    expect(releaseUrl.search).toBe("");
    expect(releaseUrl.hash).toBe("");
  });

  test("未提供 notes 时使用默认发布说明", () => {
    expect(
      createUpdaterManifest({
        ...validInput,
        notes: undefined,
      }).notes,
    ).toBe("See the GitHub release notes.");
  });

  test("接受安全的 GitHub owner/repo 字符及 .github 仓库名", () => {
    const manifest = createUpdaterManifest({
      ...validInput,
      repository: "owner-name/.github",
    });
    const releaseUrl = new URL(
      manifest.platforms["windows-x86_64-nsis"].url,
    );

    expect(releaseUrl.pathname).toBe(
      "/owner-name/.github/releases/download/v0.1.0/MineRadio-Tauri_0.1.0_x64-setup.exe",
    );
    expect(releaseUrl.search).toBe("");
    expect(releaseUrl.hash).toBe("");
  });

  test("原样保留签名中的首尾空白与多行内容", () => {
    const signature = "\nfixed-line-1\r\nfixed-line-2\n";
    const manifest = createUpdaterManifest({
      ...validInput,
      signature,
    });

    expect(manifest.platforms["windows-x86_64-nsis"].signature).toBe(
      signature,
    );
    expect(manifest.platforms["windows-x86_64"].signature).toBe(signature);
  });

  test("拒绝非 owner/name 格式的仓库", () => {
    for (const repository of [
      "zzstar101",
      "zzstar101/Mineradio-Tauri/extra",
      "/Mineradio-Tauri",
      "zzstar101/",
      "zzstar101/Mineradio-Tauri?download=1",
      "zzstar101/Mineradio-Tauri#latest",
      "zzstar101/Mineradio-Tauri\\nested",
      "zzstar101/.",
      "zzstar101/..",
      "owner--name/repository",
      "a".repeat(40) + "/repository",
      "owner/" + "r".repeat(101),
    ]) {
      expect(() =>
        createUpdaterManifest({ ...validInput, repository }),
      ).toThrow("仓库必须使用 owner/name 格式");
    }
  });

  test("拒绝空签名", () => {
    expect(() =>
      createUpdaterManifest({ ...validInput, signature: "   " }),
    ).toThrow("签名不能为空");
  });

  test("拒绝非语义版本发布标签", () => {
    expect(() =>
      createUpdaterManifest({ ...validInput, tag: "0.1.0" }),
    ).toThrow('发布标签 "0.1.0" 格式无效，必须匹配 vX.Y.Z');
  });

  test("拒绝与发布标签版本不一致的 NSIS 安装包文件名", () => {
    expect(() =>
      createUpdaterManifest({
        ...validInput,
        assetName: "MineRadio-Tauri_0.2.0_x64-setup.exe",
      }),
    ).toThrow(
      "安装包文件名必须为 MineRadio-Tauri_0.1.0_x64-setup.exe",
    );
  });
});

describe("create-updater-manifest CLI", () => {
  test("拒绝零字节安装包", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-updater-empty-exe-"),
    );

    try {
      const exePath = join(
        temporaryRoot,
        "MineRadio-Tauri_0.1.0_x64-setup.exe",
      );
      const signaturePath = exePath + ".sig";
      const outputPath = join(temporaryRoot, "latest.json");

      writeFileSync(exePath, "", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "v0.1.0",
          "zzstar101/Mineradio-Tauri",
          exePath,
          signaturePath,
          outputPath,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("安装包文件不能为空");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝不是有效 UTF-8 的签名文件", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-updater-invalid-utf8-"),
    );

    try {
      const exePath = join(
        temporaryRoot,
        "MineRadio-Tauri_0.1.0_x64-setup.exe",
      );
      const signaturePath = exePath + ".sig";
      const outputPath = join(temporaryRoot, "latest.json");

      writeFileSync(exePath, "MZ", "utf8");
      writeFileSync(signaturePath, Uint8Array.of(0xff));

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "v0.1.0",
          "zzstar101/Mineradio-Tauri",
          exePath,
          signaturePath,
          outputPath,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("签名文件不是有效的 UTF-8");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝输出路径覆盖任一输入文件", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-updater-output-alias-"),
    );

    try {
      const exePath = join(
        temporaryRoot,
        "MineRadio-Tauri_0.1.0_x64-setup.exe",
      );
      const signaturePath = exePath + ".sig";
      writeFileSync(exePath, "MZ", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");

      for (const [outputPath, expectedContent] of [
        [exePath, "MZ"],
        [signaturePath, "signature"],
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            cliPath,
            "v0.1.0",
            "zzstar101/Mineradio-Tauri",
            exePath,
            signaturePath,
            outputPath,
          ],
          { encoding: "utf8" },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("输出路径不能覆盖输入文件");
        expect(readFileSync(outputPath, "utf8")).toBe(expectedContent);
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝输出路径通过 hardlink 覆盖输入文件", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-updater-output-hardlink-"),
    );

    try {
      const exePath = join(
        temporaryRoot,
        "MineRadio-Tauri_0.1.0_x64-setup.exe",
      );
      const signaturePath = exePath + ".sig";
      const outputPath = join(temporaryRoot, "latest.json");
      writeFileSync(exePath, "MZ", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");
      linkSync(signaturePath, outputPath);

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "v0.1.0",
          "zzstar101/Mineradio-Tauri",
          exePath,
          signaturePath,
          outputPath,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("输出路径不能覆盖输入文件");
      expect(readFileSync(signaturePath, "utf8")).toBe("signature");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("写入 UTF-8 pretty JSON 并原样保留签名文件内容", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-updater-manifest-"),
    );

    try {
      const exePath = join(
        temporaryRoot,
        "MineRadio-Tauri_0.1.0_x64-setup.exe",
      );
      const signaturePath = exePath + ".sig";
      const outputPath = join(temporaryRoot, "latest.json");
      const signature = "\nfixed-line-1\r\nfixed-line-2\n";

      writeFileSync(exePath, "MZ", "utf8");
      writeFileSync(signaturePath, signature, "utf8");

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "v0.1.0",
          "zzstar101/Mineradio-Tauri",
          exePath,
          signaturePath,
          outputPath,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");

      const rawManifest = readFileSync(outputPath, "utf8");
      const manifest = JSON.parse(rawManifest);

      expect(rawManifest.endsWith("\n")).toBe(true);
      expect(rawManifest.split("\n").length).toBeGreaterThan(2);
      expect(
        manifest.platforms["windows-x86_64-nsis"].signature,
      ).toBe(signature);
      expect(manifest.platforms["windows-x86_64"].signature).toBe(signature);
      expect(manifest.platforms["windows-x86_64-nsis"].url).toBe(
        "https://github.com/zzstar101/Mineradio-Tauri/releases/download/v0.1.0/MineRadio-Tauri_0.1.0_x64-setup.exe",
      );
      expect(Number.isNaN(Date.parse(manifest.pub_date))).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝缺少必需参数", () => {
    const result = spawnSync(process.execPath, [cliPath], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "用法: create-updater-manifest.mjs <tag> <repository> <exePath> <signaturePath> <outputPath>",
    );
  });

  test("拒绝多余参数", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-updater-arguments-"),
    );

    try {
      const exePath = join(
        temporaryRoot,
        "MineRadio-Tauri_0.1.0_x64-setup.exe",
      );
      const signaturePath = exePath + ".sig";
      const outputPath = join(temporaryRoot, "latest.json");
      writeFileSync(exePath, "MZ", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "v0.1.0",
          "zzstar101/Mineradio-Tauri",
          exePath,
          signaturePath,
          outputPath,
          "unexpected-argument",
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "用法: create-updater-manifest.mjs <tag> <repository> <exePath> <signaturePath> <outputPath>",
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("拒绝不存在的安装包或签名文件", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mineradio-updater-files-"),
    );

    try {
      const exePath = join(
        temporaryRoot,
        "MineRadio-Tauri_0.1.0_x64-setup.exe",
      );
      const signaturePath = exePath + ".sig";
      const outputPath = join(temporaryRoot, "latest.json");
      writeFileSync(exePath, "MZ", "utf8");
      writeFileSync(signaturePath, "signature", "utf8");

      const cases = [
        {
          exePath: join(temporaryRoot, "missing.exe"),
          signaturePath,
          error: "安装包文件不存在",
        },
        {
          exePath,
          signaturePath: join(temporaryRoot, "missing.sig"),
          error: "签名文件不存在",
        },
      ];

      for (const testCase of cases) {
        const result = spawnSync(
          process.execPath,
          [
            cliPath,
            "v0.1.0",
            "zzstar101/Mineradio-Tauri",
            testCase.exePath,
            testCase.signaturePath,
            outputPath,
          ],
          { encoding: "utf8" },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(testCase.error);
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

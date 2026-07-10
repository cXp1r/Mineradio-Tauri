import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
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

    expect(createUpdaterManifest(validInput)).toEqual({
      version: "0.1.0",
      notes: "Fixed release notes.",
      pub_date: "2026-07-10T01:02:03.000Z",
      platforms: {
        "windows-x86_64-nsis": platform,
        "windows-x86_64": platform,
      },
    });
  });

  test("未提供 notes 时使用默认发布说明", () => {
    expect(
      createUpdaterManifest({
        ...validInput,
        notes: undefined,
      }).notes,
    ).toBe("See the GitHub release notes.");
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

      writeFileSync(exePath, "", "utf8");
      writeFileSync(signaturePath, signature, "utf8");

      const result = spawnSync(
        "node",
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
    const result = spawnSync("node", [cliPath], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "用法: create-updater-manifest.mjs <tag> <repository> <exePath> <signaturePath> <outputPath>",
    );
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
      writeFileSync(exePath, "", "utf8");
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
          "node",
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

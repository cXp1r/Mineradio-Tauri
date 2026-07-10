import { describe, expect, test } from "bun:test";

import { validateReleaseVersions } from "./verify-release-version.mjs";

const consistentVersions = {
  "package.json": "0.1.0",
  "apps/desktop/package.json": "0.1.0",
  "apps/desktop/src-tauri/tauri.conf.json": "0.1.0",
  "apps/desktop/src-tauri/Cargo.toml": "0.1.0",
};

describe("validateReleaseVersions", () => {
  test("接受合法且一致的 v0.1.0", () => {
    expect(validateReleaseVersions("v0.1.0", consistentVersions)).toEqual({
      tag: "v0.1.0",
      version: "0.1.0",
    });
  });

  test("拒绝不符合 vX.Y.Z 的标签", () => {
    expect(() => validateReleaseVersions("0.1.0", consistentVersions)).toThrow(
      '发布标签 "0.1.0" 格式无效，必须匹配 vX.Y.Z',
    );
  });

  test("拒绝与应用版本不一致的标签", () => {
    expect(() => validateReleaseVersions("v0.2.0", consistentVersions)).toThrow(
      "发布标签版本 0.2.0 与应用版本 0.1.0 不一致",
    );
  });

  test("拒绝四个版本来源互相不一致", () => {
    expect(() =>
      validateReleaseVersions("v0.1.0", {
        "package.json": "0.1.0",
        "apps/desktop/package.json": "0.1.1",
        "apps/desktop/src-tauri/tauri.conf.json": "0.1.2",
        "apps/desktop/src-tauri/Cargo.toml": "0.1.3",
      }),
    ).toThrow(
      [
        "版本来源不一致:",
        "- package.json: 0.1.0",
        "- apps/desktop/package.json: 0.1.1",
        "- apps/desktop/src-tauri/tauri.conf.json: 0.1.2",
        "- apps/desktop/src-tauri/Cargo.toml: 0.1.3",
      ].join("\n"),
    );
  });
});

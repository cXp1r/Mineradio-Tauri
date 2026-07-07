import { expect, test } from "bun:test";
import { providers, buildCapabilityMatrix, PROVIDER_IDS } from "./registry";

test("registry exposes netease and qq adapters", () => {
  expect(providers.netease.id).toBe("netease");
  expect(providers.qq.id).toBe("qq");
  expect(providers.soda.id).toBe("soda");
  expect(PROVIDER_IDS).toEqual(["netease", "qq", "soda"]);
});

test("capability matrix: netease, qq, and soda are registered", () => {
  const m = buildCapabilityMatrix();
  expect(m.providers.length).toBe(3);
  const netease = m.providers.find(e => e.providerId === "netease");
  const qq = m.providers.find(e => e.providerId === "qq");
  const soda = m.providers.find(e => e.providerId === "soda");
  expect(netease).toBeDefined();
  expect(netease?.available).toBe(true);
  expect(netease?.capabilities.length).toBeGreaterThan(0);
  expect(netease?.capabilities).toContain("quality");
  expect(qq).toBeDefined();
  expect(qq?.available).toBe(true);
  expect(qq?.capabilities.length).toBeGreaterThan(0);
  expect(qq?.capabilities).toContain("quality");
  expect(soda).toBeDefined();
  expect(soda?.available).toBe(true);
  expect(soda?.capabilities).toEqual([
    "search",
    "songUrl",
    "lyric",
    "playlistList",
    "playlistDetail",
    "loginStatus",
    "logout",
    "like",
    "quality"
  ]);
});

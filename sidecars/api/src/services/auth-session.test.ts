import { expect, test } from "bun:test";
import {
  clearRuntimeProviderCookie,
  getProviderCookie,
  setRuntimeProviderCookie,
} from "./auth-session";

function withEnv(key: string, value: string | undefined, run: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test("getProviderCookie prefers runtime cookie over env fallback", () => {
  withEnv("MINERADIO_NETEASE_COOKIE", "MUSIC_U=env", () => {
    clearRuntimeProviderCookie("netease");
    expect(getProviderCookie("netease")).toBe("MUSIC_U=env");

    setRuntimeProviderCookie("netease", "MUSIC_U=runtime");
    expect(getProviderCookie("netease")).toBe("MUSIC_U=runtime");

    clearRuntimeProviderCookie("netease");
    expect(getProviderCookie("netease")).toBe("MUSIC_U=env");
  });
});

test("runtime session rejects blank cookie and clear removes provider only", () => {
  clearRuntimeProviderCookie("netease");
  clearRuntimeProviderCookie("qq");
  setRuntimeProviderCookie("qq", "uin=123; qqmusic_key=runtime");

  expect(() => setRuntimeProviderCookie("netease", "   ")).toThrow("EMPTY_COOKIE");
  expect(getProviderCookie("qq")).toBe("uin=123; qqmusic_key=runtime");

  clearRuntimeProviderCookie("qq");
  expect(getProviderCookie("qq")).toBeUndefined();
});

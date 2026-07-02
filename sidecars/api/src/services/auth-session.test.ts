import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("getProviderCookie supports soda env fallback", () => {
  withEnv("MINERADIO_SODA_COOKIE", "soda_session=env", () => {
    clearRuntimeProviderCookie("soda");
    expect(getProviderCookie("soda")).toBe("soda_session=env");
  });
});

test("runtime session rejects blank cookie and clear removes provider only", () => {
  clearRuntimeProviderCookie("netease");
  clearRuntimeProviderCookie("qq");
  clearRuntimeProviderCookie("soda");
  setRuntimeProviderCookie("qq", "uin=123; qqmusic_key=runtime");

  expect(() => setRuntimeProviderCookie("netease", "   ")).toThrow("EMPTY_COOKIE");
  expect(getProviderCookie("qq")).toBe("uin=123; qqmusic_key=runtime");

  clearRuntimeProviderCookie("qq");
  expect(getProviderCookie("qq")).toBe(undefined);
});

test("provider session cookies persist to the configured session file", async () => {
  clearRuntimeProviderCookie("netease");
  const dir = await mkdtemp(join(tmpdir(), "mineradio-auth-session-"));
  const file = join(dir, "provider-sessions.json");
  try {
    await withEnvAsync("MINERADIO_SESSION_FILE", file, async () => {
      setRuntimeProviderCookie("netease", "MUSIC_U=persisted");
      const saved = JSON.parse(await readFile(file, "utf8"));
      expect(saved.providers.netease).toBe("MUSIC_U=persisted");

      clearRuntimeProviderCookie("netease");
      const cleared = JSON.parse(await readFile(file, "utf8"));
      expect(cleared.providers.netease).toBe(undefined);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getProviderCookie reads persisted cookies when no runtime cookie exists", async () => {
  clearRuntimeProviderCookie("netease");
  const dir = await mkdtemp(join(tmpdir(), "mineradio-auth-session-"));
  const file = join(dir, "provider-sessions.json");
  try {
    await writeFile(file, JSON.stringify({
      version: 1,
      providers: { netease: "MUSIC_U=from-disk" },
    }), "utf8");

    await withEnvAsync("MINERADIO_SESSION_FILE", file, async () => {
      expect(getProviderCookie("netease")).toBe("MUSIC_U=from-disk");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withEnvAsync(key: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

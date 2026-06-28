import { expect, test } from "bun:test";
import { clearRuntimeProviderCookie, setRuntimeProviderCookie } from "../../services/auth-session";
import {
  __setQqApiModuleForTest,
  getConfig,
  qqClient
} from "./qq-client";

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

test("getConfig returns empty object when MINERADIO_QQ_COOKIE unset", () => {
  withEnv("MINERADIO_QQ_COOKIE", undefined, () => {
    const cfg = getConfig();
    expect(cfg).toEqual({});
  });
});

test("getConfig returns {cookie} when MINERADIO_QQ_COOKIE set to non-empty string", () => {
  withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=abc", () => {
    const cfg = getConfig();
    expect(cfg.cookie).toBe("uin=123; qqmusic_key=abc");
  });
});

test("getConfig returns empty object when MINERADIO_QQ_COOKIE is whitespace-only", () => {
  withEnv("MINERADIO_QQ_COOKIE", "   ", () => {
    const cfg = getConfig();
    expect(cfg).toEqual({});
  });
});

test("getConfig prefers runtime QQ cookie over env fallback", () => {
  withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=env", () => {
    clearRuntimeProviderCookie("qq");
    expect(getConfig().cookie).toBe("uin=123; qqmusic_key=env");

    setRuntimeProviderCookie("qq", "uin=123; qqmusic_key=runtime");
    expect(getConfig().cookie).toBe("uin=123; qqmusic_key=runtime");

    clearRuntimeProviderCookie("qq");
  });
});

test("qq client resets SDK singleton cookie when runtime cookie is cleared", async () => {
  withEnv("MINERADIO_QQ_COOKIE", undefined, () => {
    clearRuntimeProviderCookie("qq");
  });
  const applied: Array<string | Record<string, string>> = [];
  __setQqApiModuleForTest({
    setCookie(cookie) {
      applied.push(cookie);
    },
    async api() {
      return "https://media.example.test/song.mp3";
    }
  });

  try {
    setRuntimeProviderCookie("qq", "uin=123; qqmusic_key=runtime");
    await qqClient.songUrl({ id: "songmid", type: "128" }, getConfig());

    clearRuntimeProviderCookie("qq");
    await qqClient.songUrl({ id: "songmid", type: "128" }, getConfig());
  } finally {
    __setQqApiModuleForTest(null);
    clearRuntimeProviderCookie("qq");
  }

  expect(applied).toEqual(["uin=123; qqmusic_key=runtime", ""]);
});

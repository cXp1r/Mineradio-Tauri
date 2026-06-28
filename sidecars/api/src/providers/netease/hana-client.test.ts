import { expect, test } from "bun:test";
import { clearRuntimeProviderCookie, setRuntimeProviderCookie } from "../../services/auth-session";
import { getConfig } from "./hana-client";

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

test("getConfig prefers runtime Netease cookie over env fallback", () => {
  withEnv("MINERADIO_NETEASE_COOKIE", "MUSIC_U=env", () => {
    clearRuntimeProviderCookie("netease");
    expect(getConfig().cookie).toBe("MUSIC_U=env");

    setRuntimeProviderCookie("netease", "MUSIC_U=runtime");
    expect(getConfig().cookie).toBe("MUSIC_U=runtime");

    clearRuntimeProviderCookie("netease");
  });
});

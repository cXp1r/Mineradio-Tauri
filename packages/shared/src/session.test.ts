import { expect, test } from "bun:test";
import { ProviderSessionCookieAckSchema } from "./session";

test("ProviderSessionCookieAckSchema accepts provider + stored ack without cookie", () => {
  const parsed = ProviderSessionCookieAckSchema.parse({
    provider: "netease",
    stored: true,
  });

  expect(parsed.provider).toBe("netease");
  expect(parsed.stored).toBe(true);
  expect(JSON.stringify(parsed)).not.toContain("MUSIC_U");
  expect(JSON.stringify(parsed)).not.toContain("cookie");
});

test("ProviderSessionCookieAckSchema rejects cookie-bearing responses", () => {
  const parsed = ProviderSessionCookieAckSchema.safeParse({
    provider: "qq",
    stored: true,
    cookie: "uin=123; qqmusic_key=secret",
  });

  expect(parsed.success).toBe(false);
});

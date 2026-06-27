import { expect, test } from "bun:test";
import { CapabilityMatrixSchema } from "./capabilities";

test("capability matrix parses well-formed payload", () => {
  const parsed = CapabilityMatrixSchema.parse({
    version: "0.1.0",
    providers: [
      {
        providerId: "netease",
        available: true,
        capabilities: ["search", "songUrl", "lyric"]
      }
    ]
  });
  expect(parsed.providers[0].providerId).toBe("netease");
});

test("capability matrix rejects unknown capability value", () => {
  expect(() =>
    CapabilityMatrixSchema.parse({
      version: "0.1.0",
      providers: [
        {
          providerId: "qq",
          available: true,
          capabilities: ["telepathy"]
        }
      ]
    })
  ).toThrow();
});
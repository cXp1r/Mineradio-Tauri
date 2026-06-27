import { expect, test } from "bun:test";
import { ApiFailureSchema, ApiSuccessSchema } from "./envelope";
import { z } from "zod";

test("success envelope parses typed data", () => {
  const parsed = ApiSuccessSchema(z.object({ name: z.string() })).parse({
    ok: true,
    data: { name: "track" }
  });
  expect(parsed.data.name).toBe("track");
});

test("failure envelope requires code, message and retryable", () => {
  const parsed = ApiFailureSchema.parse({
    ok: false,
    error: {
      code: "LOGIN_REQUIRED",
      message: "Login required",
      provider: "netease",
      retryable: true,
      action: "login"
    }
  });
  expect(parsed.error.action).toBe("login");
});
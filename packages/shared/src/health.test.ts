import { expect, test } from "bun:test";
import { HealthResponseSchema } from "./health";

test("health response parses the baseline health payload", () => {
  const parsed = HealthResponseSchema.parse({
    ok: true,
    appVersion: "0.0.0-dev",
    apiVersion: "0.1.0",
    schemaVersion: "0.1.0",
    providers: []
  });
  expect(parsed.providers).toEqual([]);
});

test("health response rejects payload missing apiVersion", () => {
  expect(() =>
    HealthResponseSchema.parse({
      ok: true,
      appVersion: "0.0.0-dev",
      schemaVersion: "0.1.0",
      providers: []
    })
  ).toThrow();
});
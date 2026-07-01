import { expect, test } from "bun:test";
import { getDatabaseStatus } from "./db";

test("getDatabaseStatus returns a non-Tauri placeholder", async () => {
	const result = await getDatabaseStatus();

	expect(result).toEqual({
		path: "",
		migrationVersion: 0,
		startupCount: 0,
	});
});

test("getDatabaseStatus placeholder has the right field types", async () => {
	const result = await getDatabaseStatus();

	expect(typeof result.path).toBe("string");
	expect(typeof result.migrationVersion).toBe("number");
	expect(typeof result.startupCount).toBe("number");
});

import { expect, test } from "bun:test";
import { setFullDesktopModeWithWallpaperFallback } from "./full-desktop-wallpaper-coordinator";

test("passive transition confirms Wallpaper fallback before changing Full Desktop", async () => {
	const calls: string[] = [];
	await setFullDesktopModeWithWallpaperFallback(
		"passive",
		async () => { calls.push("wallpaper-stop"); },
		async () => { calls.push("full-desktop-passive"); },
	);
	expect(calls).toEqual(["wallpaper-stop", "full-desktop-passive"]);
});

test("failed Wallpaper cleanup blocks passive Full Desktop mutation", async () => {
	let fullDesktopCalled = false;
	let failure: unknown;
	try {
		await setFullDesktopModeWithWallpaperFallback(
			"passive",
			async () => { throw new Error("cleanup required"); },
			async () => { fullDesktopCalled = true; },
		);
	} catch (cause) {
		failure = cause;
	}
	expect(String(failure)).toContain("cleanup required");
	expect(fullDesktopCalled).toBe(false);
});

test("interactive and disabled transitions do not stop the selected Scene implicitly", async () => {
	for (const mode of ["interactive", "disabled"] as const) {
		let prepared = false;
		let requested: string | null = null;
		await setFullDesktopModeWithWallpaperFallback(
			mode,
			async () => { prepared = true; },
			async (value) => { requested = value; },
		);
		expect(prepared).toBe(false);
		expect(requested).toBe(mode);
	}
});

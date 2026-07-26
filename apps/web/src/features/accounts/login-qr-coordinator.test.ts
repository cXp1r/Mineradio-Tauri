import { expect, test } from "bun:test";
import {
	LoginQrCoordinator,
	classifyLoginQrCheck,
} from "./login-qr-coordinator";

test("starting a new QR generation invalidates the previous result", () => {
	const coordinator = new LoginQrCoordinator();
	const first = coordinator.beginGeneration();
	const second = coordinator.beginGeneration();

	expect(coordinator.isGenerationCurrent(first)).toBe(false);
	expect(coordinator.isGenerationCurrent(second)).toBe(true);
});

test("a QR poll lease prevents overlapping checks until it is released", () => {
	const coordinator = new LoginQrCoordinator();

	expect(coordinator.claimPoll()).toBe(true);
	expect(coordinator.claimPoll()).toBe(false);
	coordinator.releasePoll();
	expect(coordinator.claimPoll()).toBe(true);
});

test("QR check classification preserves provider success, expiry and scanned compatibility codes", () => {
	const base = {
		provider: "netease" as const,
		key: "key-1",
		loggedIn: false,
	};

	expect(classifyLoginQrCheck({ ...base, code: 801, stored: true })).toBe("success");
	expect(classifyLoginQrCheck({ ...base, code: 0, loggedIn: true })).toBe("success");
	for (const result of [
		{ ...base, code: 801, expired: true },
		{ ...base, code: 800 },
		{ ...base, code: 65 },
	]) {
		expect(classifyLoginQrCheck(result)).toBe("expired");
	}
	for (const result of [
		{ ...base, code: 801, scanned: true },
		{ ...base, code: 802 },
		{ ...base, code: 67 },
	]) {
		expect(classifyLoginQrCheck(result)).toBe("scanned");
	}
	expect(classifyLoginQrCheck({ ...base, code: 801 })).toBe("waiting");
});

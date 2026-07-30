import { expect, test } from "bun:test";
import { createShelfState, type ShelfState } from "./shelf-state";

test("createShelfState seeds centerIdx/centerTarget/centerSmooth at 0", () => {
	const s = createShelfState();
	expect(s.centerIdx).toBe(0);
	expect(s.centerTarget).toBe(0);
	expect(s.centerSmooth).toBe(0);
});

test("createShelfState default mode is side and shelfPane is mine", () => {
	const s = createShelfState();
	expect(s.mode).toBe("side");
	expect(s.presence).toBe("always");
	expect(s.appRevealed).toBe(true);
	expect(s.shelfPane).toBe("mine");
});

test("createShelfState openCardIdx starts at -1 (no open detail)", () => {
	const s = createShelfState();
	expect(s.openCardIdx).toBe(-1);
});

test("createShelfState pinnedOpen defaults false", () => {
	const s = createShelfState();
	expect(s.pinnedOpen).toBe(false);
});

test("createShelfState selectedIdx starts at -1", () => {
	const s = createShelfState();
	expect(s.selectedIdx).toBe(-1);
	expect(s.pointerForegroundEligible).toBe(true);
});

test("createShelfState paneMemory seeds mine:0 fav:0", () => {
	const s = createShelfState();
	expect(s.paneMemory).toEqual({ mine: 0, fav: 0 });
});

test("createShelfState paneSwitchAt default -10 (sentinel pre-kickoff)", () => {
	const s = createShelfState();
	expect(s.paneSwitchAt).toBe(-10);
	expect(s.paneSwitchDir).toBe(1);
});

test("createShelfState collectionReveal/cooldowns start at sentinel 0 and -10", () => {
	const s = createShelfState();
	expect(s.collectionReveal).toBe(0);
	expect(s.lastCardRedrawAt).toBe(-10);
	expect(s.lastCardPulseBucket).toBe(-1);
	expect(s.lastUpdate).toBe(0);
});

test("createShelfState shelfVisibility starts at 0 (hidden)", () => {
	const s: ShelfState = createShelfState();
	expect(s.shelfVisibility).toBe(0);
});

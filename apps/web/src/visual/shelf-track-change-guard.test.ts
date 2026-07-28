import { expect, test } from "bun:test";
import { createShelfTrackChangeGuard } from "./shelf-track-change-guard";

test("shared Shelf track guard advances one generation and blocks the exact 1120ms window", () => {
	let trackKey = "track-a";
	let now = 0;
	let changes = 0;
	const guard = createShelfTrackChangeGuard({
		getTrackKey: () => trackKey,
		nowMs: () => now,
		onChange: () => { changes += 1; },
	});

	expect(guard.sync()).toEqual({ blocking: false, changed: false, generation: 0 });
	trackKey = "track-b";
	expect(guard.sync()).toEqual({ blocking: true, changed: true, generation: 1 });
	expect(changes).toBe(1);
	now = 1119;
	expect(guard.sync()).toEqual({ blocking: true, changed: false, generation: 1 });
	now = 1120;
	expect(guard.sync()).toEqual({ blocking: false, changed: false, generation: 1 });
	expect(changes).toBe(1);
});

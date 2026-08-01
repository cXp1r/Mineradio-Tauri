import { expect, test } from "bun:test";
import { desktopLyricsBeatMapContext } from "./desktop-lyrics-payload";

test("beat map key is committed only after the runtime confirms payload delivery", () => {
	const lastSentKey = { current: "old-key" };
	const map = { kicks: [1.2, 2.4] };
	const context = desktopLyricsBeatMapContext(
		{ key: "new-key", map },
		false,
		lastSentKey,
	);

	expect(context).toEqual({ beatMapKey: "new-key", beatMap: map });
	expect(lastSentKey.current).toBe("old-key");
});

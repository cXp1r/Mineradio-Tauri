import { expect, test } from "bun:test";
import {
	CUSTOM_LYRIC_FONT_STORE_KEY,
	customLyricFontKey,
	MAX_CUSTOM_LYRIC_FONT_BYTES,
	pruneCustomLyricFontRegistrations,
	readCustomLyricFonts,
	registerCustomLyricFont,
	releaseCustomLyricFont,
	removeCustomLyricFont,
	validateCustomLyricFontFile,
	writeCustomLyricFonts,
} from "./custom-lyric-font";

function storage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

test("custom lyric font validation enforces supported formats and the 3.6 MiB budget", () => {
	expect(validateCustomLyricFontFile({ name: "中文.woff2", size: 1024 })).toBeNull();
	expect(validateCustomLyricFontFile({ name: "font.exe", size: 1024 })).toContain("TTF");
	expect(validateCustomLyricFontFile({ name: "font.ttf", size: MAX_CUSTOM_LYRIC_FONT_BYTES + 1 })).toContain("3.6");
});

test("registered custom fonts are removed from the current WebView font set", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const target = storage();
	const record = {
		id: "release1",
		name: "可释放字体",
		family: "MineRadio Custom release1",
		dataUrl: "data:font/woff2;base64,AAAA",
		size: 4,
		savedAt: 43,
	};
	writeCustomLyricFonts([record], target);
	const previousFontFace = globalThis.FontFace;
	const previousFontSet = Object.getOwnPropertyDescriptor(document, "fonts");
	const faces = new Set<FontFace>();
	class TestFontFace {
		constructor(
			public family: string,
			public source: string,
		) {}
		async load() {
			return this;
		}
	}
	Object.defineProperty(globalThis, "FontFace", {
		configurable: true,
		value: TestFontFace,
		writable: true,
	});
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: {
			add: (face: FontFace) => faces.add(face),
			delete: (face: FontFace) => faces.delete(face),
		},
	});

	try {
		expect(await registerCustomLyricFont("custom:release1", target)).toBe(true);
		expect(releaseCustomLyricFont("release1")).toBe(true);
		expect(releaseCustomLyricFont("release1")).toBe(false);
	} finally {
		Object.defineProperty(globalThis, "FontFace", {
			configurable: true,
			value: previousFontFace,
			writable: true,
		});
		if (previousFontSet) Object.defineProperty(document, "fonts", previousFontSet);
		else Reflect.deleteProperty(document, "fonts");
	}
});

test("pending custom font registration is cancelled when another WebView removes the record", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const target = storage();
	const record = {
		id: "pending1",
		name: "加载中字体",
		family: "MineRadio Custom pending1",
		dataUrl: "data:font/woff2;base64,BBBB",
		size: 4,
		savedAt: 44,
	};
	writeCustomLyricFonts([record], target);
	const previousFontFace = globalThis.FontFace;
	const previousFontSet = Object.getOwnPropertyDescriptor(document, "fonts");
	const faces = new Set<FontFace>();
	let finishLoad: () => void = () => {
		throw new Error("字体加载尚未开始");
	};
	class PendingFontFace {
		constructor(
			public family: string,
			public source: string,
		) {}
		load() {
			return new Promise<PendingFontFace>((resolve) => {
				finishLoad = () => resolve(this);
			});
		}
	}
	Object.defineProperty(globalThis, "FontFace", {
		configurable: true,
		value: PendingFontFace,
		writable: true,
	});
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: {
			add: (face: FontFace) => faces.add(face),
			delete: (face: FontFace) => faces.delete(face),
		},
	});

	try {
		const registration = registerCustomLyricFont("custom:pending1", target);
		writeCustomLyricFonts([], target);
		expect(pruneCustomLyricFontRegistrations(target)).toBe(0);
		finishLoad();
		expect(await registration).toBe(false);
		expect(faces.size).toBe(0);
	} finally {
		releaseCustomLyricFont(record.id);
		Object.defineProperty(globalThis, "FontFace", {
			configurable: true,
			value: previousFontFace,
			writable: true,
		});
		if (previousFontSet) Object.defineProperty(document, "fonts", previousFontSet);
		else Reflect.deleteProperty(document, "fonts");
	}
});

test("custom lyric font storage is versioned bounded and removable", () => {
	const target = storage();
	const record = {
		id: "abc1234",
		name: "中文字体",
		family: "MineRadio Custom abc1234",
		dataUrl: "data:font/woff2;base64,AAAA",
		size: 4,
		savedAt: 42,
	};
	writeCustomLyricFonts([record], target);
	expect(target.values.has(CUSTOM_LYRIC_FONT_STORE_KEY)).toBe(true);
	expect(readCustomLyricFonts(target)).toEqual([record]);
	expect(customLyricFontKey(record)).toBe("custom:abc1234");
	expect(removeCustomLyricFont(record.id, target)).toEqual([]);
});

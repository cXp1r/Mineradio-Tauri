import {
	customLyricFontFamily,
	customLyricFontId,
} from "@mineradio/visual-engine";

export const CUSTOM_LYRIC_FONT_STORE_KEY = "mineradio-custom-lyric-fonts-v1";
export const MAX_CUSTOM_LYRIC_FONT_BYTES = Math.floor(3.6 * 1024 * 1024);
export const MAX_CUSTOM_LYRIC_FONT_RECORDS = 3;
export const MAX_CUSTOM_LYRIC_FONT_DATA_CHARS = 4_900_000;

const FONT_EXTENSION = /\.(ttf|otf|woff2?)$/i;
const registrationCache = new Map<string, Promise<boolean>>();
const registrationTokens = new Map<string, object>();
const registeredFaces = new Map<string, FontFace>();

export interface CustomLyricFontRecord {
	id: string;
	name: string;
	family: string;
	dataUrl: string;
	size: number;
	savedAt: number;
}

interface CustomLyricFontDocument {
	version: 1;
	records: CustomLyricFontRecord[];
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export function validateCustomLyricFontFile(file: Pick<File, "name" | "size">): string | null {
	if (!FONT_EXTENSION.test(file.name)) return "仅支持 TTF、OTF、WOFF 和 WOFF2 字体";
	if (!Number.isFinite(file.size) || file.size <= 0) return "字体文件为空";
	if (file.size > MAX_CUSTOM_LYRIC_FONT_BYTES) return "字体文件不能超过 3.6 MiB";
	return null;
}

export function readCustomLyricFonts(
	storage: StorageLike | null | undefined = defaultStorage(),
): CustomLyricFontRecord[] {
	if (!storage) return [];
	try {
		const raw = storage.getItem(CUSTOM_LYRIC_FONT_STORE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as Partial<CustomLyricFontDocument>;
		if (parsed.version !== 1 || !Array.isArray(parsed.records)) return [];
		return parsed.records.filter(isCustomLyricFontRecord).slice(0, MAX_CUSTOM_LYRIC_FONT_RECORDS);
	} catch {
		return [];
	}
}

export function writeCustomLyricFonts(
	records: CustomLyricFontRecord[],
	storage: StorageLike | null | undefined = defaultStorage(),
): CustomLyricFontRecord[] {
	if (!storage) return [];
	const bounded: CustomLyricFontRecord[] = [];
	let chars = 0;
	for (const record of [...records].sort((left, right) => right.savedAt - left.savedAt)) {
		if (!isCustomLyricFontRecord(record)) continue;
		if (bounded.length >= MAX_CUSTOM_LYRIC_FONT_RECORDS) break;
		if (chars + record.dataUrl.length > MAX_CUSTOM_LYRIC_FONT_DATA_CHARS) continue;
		bounded.push(record);
		chars += record.dataUrl.length;
	}
	storage.setItem(CUSTOM_LYRIC_FONT_STORE_KEY, JSON.stringify({ version: 1, records: bounded }));
	return bounded;
}

export async function saveCustomLyricFont(
	file: File,
	storage: StorageLike | null | undefined = defaultStorage(),
): Promise<CustomLyricFontRecord> {
	const validationError = validateCustomLyricFontFile(file);
	if (validationError) throw new Error(validationError);
	const id = fontId(file.name, file.size, file.lastModified);
	const key = `custom:${id}`;
	const family = customLyricFontFamily(key);
	if (!family) throw new Error("无法生成自定义字体标识");
	const record: CustomLyricFontRecord = {
		id,
		name: file.name.replace(FONT_EXTENSION, ""),
		family,
		dataUrl: await readFileAsDataUrl(file),
		size: file.size,
		savedAt: Date.now(),
	};
	const previous = readCustomLyricFonts(storage).filter((item) => item.id !== id);
	const saved = writeCustomLyricFonts([record, ...previous], storage);
	if (!saved.some((item) => item.id === id)) throw new Error("字体存储空间不足");
	return record;
}

export function removeCustomLyricFont(
	id: string,
	storage: StorageLike | null | undefined = defaultStorage(),
): CustomLyricFontRecord[] {
	const next = writeCustomLyricFonts(
		readCustomLyricFonts(storage).filter((record) => record.id !== id),
		storage,
	);
	releaseCustomLyricFont(id);
	return next;
}

export function releaseCustomLyricFont(id: string): boolean {
	registrationCache.delete(id);
	registrationTokens.delete(id);
	const face = registeredFaces.get(id);
	registeredFaces.delete(id);
	if (!face || typeof document === "undefined" || !document.fonts) return false;
	return document.fonts.delete(face);
}

export function pruneCustomLyricFontRegistrations(
	storage: StorageLike | null | undefined = defaultStorage(),
): number {
	const retained = new Set(readCustomLyricFonts(storage).map((record) => record.id));
	let released = 0;
	const activeIds = new Set([...registeredFaces.keys(), ...registrationCache.keys()]);
	for (const id of activeIds) {
		if (!retained.has(id) && releaseCustomLyricFont(id)) released += 1;
	}
	return released;
}

export function customLyricFontKey(record: Pick<CustomLyricFontRecord, "id">): string {
	return `custom:${record.id}`;
}

export async function registerCustomLyricFont(
	key: string,
	storage: StorageLike | null | undefined = defaultStorage(),
): Promise<boolean> {
	const id = customLyricFontId(key);
	if (!id) return false;
	const record = readCustomLyricFonts(storage).find((item) => item.id === id);
	if (!record || typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return false;
	const cached = registrationCache.get(id);
	if (cached) return cached;
	const registrationToken = {};
	const registration = (async () => {
		try {
			const face = new FontFace(record.family, `url(${JSON.stringify(record.dataUrl)})`);
			await face.load();
			const retained = readCustomLyricFonts(storage).find((item) => item.id === id);
			if (registrationTokens.get(id) !== registrationToken || !sameCustomLyricFontRecord(retained, record)) {
				return false;
			}
			const previous = registeredFaces.get(id);
			if (previous) document.fonts.delete(previous);
			document.fonts.add(face);
			registeredFaces.set(id, face);
			return true;
		} catch {
			return false;
		}
	})();
	registrationCache.set(id, registration);
	registrationTokens.set(id, registrationToken);
	void registration.then((registered) => {
		if (!registered && registrationTokens.get(id) === registrationToken) {
			registrationCache.delete(id);
			registrationTokens.delete(id);
		}
	});
	return registration;
}

export async function registerCustomLyricFontForFamily(
	family: string,
	storage: StorageLike | null | undefined = defaultStorage(),
): Promise<boolean> {
	const record = readCustomLyricFonts(storage).find((item) => family.includes(item.family));
	return record ? registerCustomLyricFont(customLyricFontKey(record), storage) : false;
}

function isCustomLyricFontRecord(value: unknown): value is CustomLyricFontRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<CustomLyricFontRecord>;
	return typeof record.id === "string"
		&& /^[a-z0-9_-]{6,64}$/.test(record.id)
		&& typeof record.name === "string"
		&& typeof record.family === "string"
		&& typeof record.dataUrl === "string"
		&& record.dataUrl.startsWith("data:")
		&& typeof record.size === "number"
		&& record.size > 0
		&& record.size <= MAX_CUSTOM_LYRIC_FONT_BYTES
		&& typeof record.savedAt === "number";
}

function sameCustomLyricFontRecord(
	left: CustomLyricFontRecord | undefined,
	right: CustomLyricFontRecord,
): boolean {
	return left?.id === right.id
		&& left.family === right.family
		&& left.dataUrl === right.dataUrl
		&& left.size === right.size
		&& left.savedAt === right.savedAt;
}

function fontId(name: string, size: number, lastModified: number): string {
	let hash = 2166136261;
	for (const char of `${name.toLowerCase()}|${size}|${lastModified}`) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36).padStart(7, "0");
}

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("读取字体文件失败"));
		reader.onload = () => typeof reader.result === "string"
			? resolve(reader.result)
			: reject(new Error("读取字体文件失败"));
		reader.readAsDataURL(file);
	});
}

function defaultStorage(): StorageLike | null {
	return typeof localStorage === "undefined" ? null : localStorage;
}

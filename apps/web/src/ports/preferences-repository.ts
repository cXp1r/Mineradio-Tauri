export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface PreferenceKey<T> {
	readonly name: string;
	readonly schemaVersion: number;
	defaultValue(): T;
	parse(value: unknown): T | undefined;
}

export interface JsonPreferenceKeyDefinition<T> {
	name: string;
	schemaVersion: number;
	defaultValue: T | (() => T);
	parse(value: unknown): T | undefined;
}

function clonePreferenceValue<T>(value: T): T {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 创建一个带 schema 的偏好 key。Adapter 只能通过 key 读写，调用方不会接触任意 KV。
 */
export function createJsonPreferenceKey<T>(
	definition: JsonPreferenceKeyDefinition<T>,
): PreferenceKey<T> {
	if (!definition.name.trim()) throw new Error("PREFERENCE_KEY_EMPTY");
	if (!Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
		throw new Error("PREFERENCE_SCHEMA_VERSION_INVALID");
	}
	const defaultFactory =
		typeof definition.defaultValue === "function"
			? (definition.defaultValue as () => T)
			: () => clonePreferenceValue(definition.defaultValue as T);
	let normalizedDefault: T;
	try {
		const parsed = definition.parse(defaultFactory());
		if (parsed === undefined) throw new Error("schema rejected default");
		normalizedDefault = clonePreferenceValue(parsed);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`PREFERENCE_DEFAULT_INVALID:${definition.name}:${detail}`);
	}
	return Object.freeze({
		name: definition.name,
		schemaVersion: definition.schemaVersion,
		defaultValue: () => clonePreferenceValue(normalizedDefault),
		parse: definition.parse,
	});
}

export interface PreferencesTransaction {
	get<T>(key: PreferenceKey<T>): Promise<T>;
	set<T>(key: PreferenceKey<T>, value: T): Promise<void>;
	remove<T>(key: PreferenceKey<T>): Promise<void>;
}

export interface PreferencesRepository extends PreferencesTransaction {
	transaction<T>(work: (tx: PreferencesTransaction) => Promise<T>): Promise<T>;
}

export function parsePreferenceValue<T>(key: PreferenceKey<T>, value: unknown): T {
	const parsed = key.parse(value);
	if (parsed === undefined) {
		throw new Error(`PREFERENCE_SCHEMA_INVALID:${key.name}`);
	}
	return clonePreferenceValue(parsed);
}

export function defaultPreferenceValue<T>(key: PreferenceKey<T>): T {
	return clonePreferenceValue(key.defaultValue());
}

export function cloneJsonValue<T>(value: T): T {
	return clonePreferenceValue(value);
}

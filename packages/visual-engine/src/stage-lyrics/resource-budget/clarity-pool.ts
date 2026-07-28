export const MIB = 1024 * 1024;

export type StageClarityQuality = "low" | "eco" | "balanced" | "high" | "ultra";
export type StageClarityTier = 1 | 2 | 3 | 4;
export type StageClarityPriority = "essential" | "normal" | "optional" | "background";
export type StageClarityPressure = "normal" | "soft" | "hard";

export interface StageClarityBudget {
	readonly budgetBytes: number;
	readonly residentRows: number;
	readonly singleItemCapBytes: number;
}

export interface StageClarityPoolItem<Value> {
	readonly key: string;
	readonly value: Value;
	readonly bytes: number;
	readonly priority: StageClarityPriority;
	readonly release: () => void;
	readonly replacement?: boolean;
}

export interface StageClarityResidentLease<Value> {
	readonly value: Value;
	readonly released: boolean;
	release(): void;
}

export interface StageClarityReservation<Value> {
	readonly key: string;
	readonly active: boolean;
	commit(value: Value, release: () => void): boolean;
	cancel(): void;
}

export interface StageClarityPoolDiagnostics {
	readonly quality: StageClarityQuality;
	readonly tier: StageClarityTier;
	readonly admissionEnabled: boolean;
	readonly entries: number;
	readonly bytes: number;
	readonly budgetBytes: number;
	readonly residentRows: number;
	readonly pressure: StageClarityPressure;
	readonly hits: number;
	readonly misses: number;
	readonly evictions: number;
	readonly rejected: number;
	readonly pinned: number;
	readonly reserved: number;
}

export interface StageClarityPoolReconfigureOptions extends StageClarityPoolOptions {
	readonly protectedKeys?: readonly string[];
}

export interface StageClarityPool<Value> {
	reconfigure(options: StageClarityPoolReconfigureOptions): void;
	canAdmit(): boolean;
	put(item: StageClarityPoolItem<Value>): boolean;
	reserve(item: Omit<StageClarityPoolItem<Value>, "value" | "release">): StageClarityReservation<Value> | null;
	acquire(key: string): StageClarityResidentLease<Value> | undefined;
	delete(key: string): boolean;
	setPriority(key: string, priority: StageClarityPriority): boolean;
	/** outgoing 释放后调用；若尚不能恢复稳定预算则返回 false 并保留过渡槽。 */
	finalizeReplacement(key: string): boolean;
	setPressure(pressure: StageClarityPressure): void;
	getDiagnostics(): StageClarityPoolDiagnostics;
	dispose(): void;
}

export interface StageClarityPoolOptions {
	readonly quality: StageClarityQuality;
	readonly tier: StageClarityTier;
	readonly budgetBytesOverride?: number;
	readonly singleItemCapBytesOverride?: number;
}

interface PoolEntry<Value> {
	readonly key: string;
	readonly bytes: number;
	value: Value | undefined;
	release: () => void;
	priority: StageClarityPriority;
	lastUsed: number;
	released: boolean;
	reserved: boolean;
	pinCount: number;
	replacement: boolean;
}

const TIER_BUDGET_MIB: Readonly<Record<"low" | "balanced" | "high", Readonly<Record<StageClarityTier, number>>>> = {
	low: { 1: 0, 2: 32, 3: 64, 4: 96 },
	balanced: { 1: 0, 2: 48, 3: 96, 4: 144 },
	high: { 1: 0, 2: 64, 3: 128, 4: 192 },
};

function qualityGroup(quality: StageClarityQuality): "low" | "balanced" | "high" {
	if (quality === "low" || quality === "eco") return "low";
	if (quality === "balanced") return "balanced";
	return "high";
}

function residentRows(quality: StageClarityQuality): number {
	if (quality === "low" || quality === "eco") return 4;
	if (quality === "balanced") return 6;
	return 8;
}

export function getStageClarityBudget(
	quality: StageClarityQuality,
	tier: StageClarityTier,
): StageClarityBudget {
	const budgetBytes = TIER_BUDGET_MIB[qualityGroup(quality)][tier] * MIB;
	return {
		budgetBytes,
		residentRows: residentRows(quality),
		singleItemCapBytes: budgetBytes === 0 ? 0 : Math.floor(Math.min(64 * MIB, budgetBytes * 0.55)),
	};
}

function assertBytes(bytes: number): void {
	if (!Number.isFinite(bytes) || bytes < 0) {
		throw new RangeError("Stage clarity item bytes must be finite and non-negative.");
	}
}

export function createStageClarityPool<Value>(
	options: StageClarityPoolOptions,
): StageClarityPool<Value> {
	let quality = options.quality;
	let tier = options.tier;
	let defaults = getStageClarityBudget(quality, tier);
	let budgetBytes = options.budgetBytesOverride ?? defaults.budgetBytes;
	let singleItemCapBytes = options.singleItemCapBytesOverride ?? defaults.singleItemCapBytes;
	assertBytes(budgetBytes);
	assertBytes(singleItemCapBytes);
	const entries = new Map<string, PoolEntry<Value>>();
	let pressure: StageClarityPressure = "normal";
	let bytes = 0;
	let clock = 0;
	let hits = 0;
	let misses = 0;
	let evictions = 0;
	let rejected = 0;
	let disposed = false;

	const releaseEntry = (entry: PoolEntry<Value>, eviction: boolean) => {
		if (entry.released) return;
		entry.released = true;
		entries.delete(entry.key);
		bytes = Math.max(0, bytes - entry.bytes);
		if (eviction) evictions += 1;
		try {
			entry.release();
		} catch {
			// 一个缓存条目释放失败不能阻断其余 LRU 收口。
		}
	};
	const oldestEvictable = (excludedKey?: string, protectedKeys?: ReadonlySet<string>) => {
		let candidate: PoolEntry<Value> | null = null;
		for (const entry of entries.values()) {
			if (
				entry.key === excludedKey ||
				protectedKeys?.has(entry.key) ||
				entry.priority === "essential" ||
				entry.pinCount > 0 ||
				entry.reserved
			) continue;
			if (!candidate || entry.lastUsed < candidate.lastUsed) candidate = entry;
		}
		return candidate;
	};
	const trimPressure = (protectedKeys?: ReadonlySet<string>) => {
		for (const entry of [...entries.values()]) {
			if (!protectedKeys?.has(entry.key) && !entry.reserved && entry.pinCount === 0 && (
				(pressure === "soft" && entry.priority === "background") ||
				(pressure === "hard" && (entry.priority === "background" || entry.priority === "optional"))
			)) {
				releaseEntry(entry, true);
			}
		}
	};
	const trimStableBudget = (protectedKey?: string, protectedKeys?: ReadonlySet<string>) => {
		while (entries.size > defaults.residentRows || bytes > budgetBytes) {
			const candidate = oldestEvictable(protectedKey, protectedKeys);
			if (!candidate) return false;
			releaseEntry(candidate, true);
		}
		return true;
	};
	const reserveItem = (
		item: Omit<StageClarityPoolItem<Value>, "value" | "release">,
	): StageClarityReservation<Value> | null => {
		if (disposed) return null;
		if (!item.key) throw new TypeError("Stage clarity item key is required.");
		assertBytes(item.bytes);
		if (
			entries.has(item.key) ||
			budgetBytes === 0 ||
			item.bytes > singleItemCapBytes ||
			(pressure === "soft" && item.priority === "background") ||
			(pressure === "hard" && (item.priority === "optional" || item.priority === "background"))
		) {
			rejected += 1;
			return null;
		}
		const replacement = item.replacement === true;
		if (replacement && [...entries.values()].some((entry) => entry.replacement)) {
			rejected += 1;
			return null;
		}
		const rowLimit = defaults.residentRows + (replacement ? 1 : 0);
		const byteLimit = budgetBytes + (replacement ? singleItemCapBytes : 0);
		while (bytes + item.bytes > byteLimit || entries.size + 1 > rowLimit) {
			const candidate = oldestEvictable();
			if (!candidate) {
				rejected += 1;
				return null;
			}
			releaseEntry(candidate, true);
		}
		clock += 1;
		const entry: PoolEntry<Value> = {
			key: item.key,
			bytes: item.bytes,
			value: undefined,
			release: () => {},
			priority: item.priority,
			lastUsed: clock,
			released: false,
			reserved: true,
			pinCount: 0,
			replacement,
		};
		entries.set(item.key, entry);
		bytes += item.bytes;
		let active = true;
		const isActive = () => active && entries.get(item.key) === entry && entry.reserved;
		return {
			key: item.key,
			get active() {
				return isActive();
			},
			commit(value, release) {
				if (!isActive()) return false;
				active = false;
				entry.value = value;
				entry.release = release;
				entry.reserved = false;
				return true;
			},
			cancel() {
				if (!active) return;
				active = false;
				if (entries.get(item.key) === entry) releaseEntry(entry, false);
			},
		};
	};

	return {
		reconfigure(nextOptions) {
			if (disposed) return;
			quality = nextOptions.quality;
			tier = nextOptions.tier;
			defaults = getStageClarityBudget(quality, tier);
			budgetBytes = nextOptions.budgetBytesOverride ?? defaults.budgetBytes;
			singleItemCapBytes = nextOptions.singleItemCapBytesOverride ?? defaults.singleItemCapBytes;
			assertBytes(budgetBytes);
			assertBytes(singleItemCapBytes);
			const protectedKeys = new Set(nextOptions.protectedKeys ?? []);
			for (const entry of [...entries.values()]) {
				if (!protectedKeys.has(entry.key) && entry.bytes > singleItemCapBytes) {
					releaseEntry(entry, true);
				}
			}
			trimPressure(protectedKeys);
			trimStableBudget(undefined, protectedKeys);
		},
		canAdmit() {
			return !disposed && tier > 1 && budgetBytes > 0 && singleItemCapBytes > 0;
		},
		put(item) {
			const reservation = reserveItem(item);
			return reservation?.commit(item.value, item.release) ?? false;
		},
		reserve(item) {
			return reserveItem(item);
		},
		acquire(key) {
			const entry = entries.get(key);
			if (!entry || entry.reserved || entry.value === undefined) {
				misses += 1;
				return undefined;
			}
			clock += 1;
			entry.lastUsed = clock;
			entry.pinCount += 1;
			hits += 1;
			let releasedLease = false;
			return {
				value: entry.value,
				get released() {
					return releasedLease;
				},
				release() {
					if (releasedLease) return;
					releasedLease = true;
					entry.pinCount = Math.max(0, entry.pinCount - 1);
					trimPressure();
				},
			};
		},
		delete(key) {
			const entry = entries.get(key);
			if (!entry || entry.pinCount > 0) return false;
			releaseEntry(entry, false);
			return true;
		},
		setPriority(key, priority) {
			const entry = entries.get(key);
			if (!entry) return false;
			entry.priority = priority;
			clock += 1;
			entry.lastUsed = clock;
			trimPressure();
			return entries.has(key);
		},
		finalizeReplacement(key) {
			const entry = entries.get(key);
			if (!entry || entry.reserved || !entry.replacement) return false;
			if (!trimStableBudget(key)) return false;
			entry.replacement = false;
			return entries.has(key);
		},
		setPressure(nextPressure) {
			pressure = nextPressure;
			trimPressure();
		},
		getDiagnostics() {
			return {
				quality,
				tier,
				admissionEnabled: !disposed && tier > 1 && budgetBytes > 0 && singleItemCapBytes > 0,
				entries: entries.size,
				bytes,
				budgetBytes,
				residentRows: defaults.residentRows,
				pressure,
				hits,
				misses,
				evictions,
				rejected,
				pinned: [...entries.values()].reduce((total, entry) => total + entry.pinCount, 0),
				reserved: [...entries.values()].filter((entry) => entry.reserved).length,
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const entry of [...entries.values()]) releaseEntry(entry, false);
		},
	};
}

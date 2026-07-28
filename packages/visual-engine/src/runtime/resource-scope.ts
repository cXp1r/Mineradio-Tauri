export type VisualResourceKind =
	| "texture"
	| "geometry"
	| "material"
	| "mesh"
	| "listener"
	| "timer"
	| "subscription"
	| "async-task"
	| "cache";

export type VisualResourceRetention =
	| "persistent"
	| "rebuildable"
	| "ephemeral";

export type VisualReleasableResourceRetention = Exclude<
	VisualResourceRetention,
	"persistent"
>;

export class VisualResourceScopeClosedError extends Error {
	readonly scopeName: string;

	constructor(scopeName: string) {
		super(`Visual resource scope "${scopeName}" is closed.`);
		this.name = "VisualResourceScopeClosedError";
		this.scopeName = scopeName;
	}
}

export interface VisualResourceRegistration {
	readonly owner: string;
	readonly kind: VisualResourceKind;
	readonly retention: VisualResourceRetention;
	readonly estimatedBytes?: number;
	dispose(): void;
}

export interface VisualResourceDisposalError {
	readonly scope: string;
	readonly scopePath: string;
	readonly owner: string;
	readonly kind: VisualResourceKind;
	readonly retention: VisualResourceRetention;
	readonly cause: unknown;
}

export interface VisualResourceDisposalReport {
	readonly disposed: number;
	readonly errors: readonly VisualResourceDisposalError[];
}

export interface VisualResourceHandle {
	readonly owner: string;
	readonly kind: VisualResourceKind;
	readonly retention: VisualResourceRetention;
	readonly estimatedBytes?: number;
	readonly disposed: boolean;
	dispose(): VisualResourceDisposalReport;
}

export interface VisualResourceScope {
	readonly name: string;
	readonly closed: boolean;
	isOpen(): boolean;
	register(registration: VisualResourceRegistration): VisualResourceHandle;
	createChild(name: string): VisualResourceScope;
	releaseRetention(
		retention:
			| VisualReleasableResourceRetention
			| readonly VisualReleasableResourceRetention[],
	): VisualResourceDisposalReport;
	dispose(): VisualResourceDisposalReport;
}

interface ResourceEntry {
	readonly type: "resource";
	readonly owner: string;
	readonly kind: VisualResourceKind;
	readonly retention: VisualResourceRetention;
	readonly estimatedBytes?: number;
	disposer: (() => void) | null;
	disposed: boolean;
}

interface ChildEntry {
	readonly type: "child";
	readonly scope: VisualResourceScope;
}

type ScopeEntry = ResourceEntry | ChildEntry;

export interface VisualResourceScopeTestDiagnostics {
	readonly entryCount: number;
	readonly resourceEntryCount: number;
	readonly childEntryCount: number;
	readonly activeResourceEntryCount: number;
	readonly retainedDisposerCount: number;
}

export interface VisualResourceHandleTestDiagnostics {
	readonly disposed: boolean;
	readonly retainsDisposer: boolean;
}

const scopeEntriesForTests = new WeakMap<VisualResourceScope, ScopeEntry[]>();
const handleEntriesForTests = new WeakMap<VisualResourceHandle, ResourceEntry>();

// 仅供本模块测试确定性检查引用释放，不从包入口导出。
export function __inspectVisualResourceScopeForTests(
	scope: VisualResourceScope,
): VisualResourceScopeTestDiagnostics {
	const entries = scopeEntriesForTests.get(scope);
	if (!entries) throw new Error("Unknown visual resource scope.");
	const resources = entries.filter(
		(entry): entry is ResourceEntry => entry.type === "resource",
	);
	return {
		entryCount: entries.length,
		resourceEntryCount: resources.length,
		childEntryCount: entries.length - resources.length,
		activeResourceEntryCount: resources.filter((entry) => !entry.disposed)
			.length,
		retainedDisposerCount: resources.filter(
			(entry) => typeof entry.disposer === "function",
		).length,
	};
}

// 句柄可继续持有已移出 scope 的 entry，因此单独检查 disposer 是否仍被保留。
export function __inspectVisualResourceHandleForTests(
	handle: VisualResourceHandle,
): VisualResourceHandleTestDiagnostics {
	const entry = handleEntriesForTests.get(handle);
	if (!entry) throw new Error("Unknown visual resource handle.");
	return {
		disposed: entry.disposed,
		retainsDisposer: typeof entry.disposer === "function",
	};
}

function emptyReport(): VisualResourceDisposalReport {
	return { disposed: 0, errors: [] };
}

function mergeReports(
	target: { disposed: number; errors: VisualResourceDisposalError[] },
	source: VisualResourceDisposalReport,
): void {
	target.disposed += source.disposed;
	target.errors.push(...source.errors);
}

function createVisualResourceScopeAtPath(
	name: string,
	scopePath: string,
): VisualResourceScope {
	const entries: ScopeEntry[] = [];
	let closed = false;
	const assertOpen = () => {
		if (closed) throw new VisualResourceScopeClosedError(name);
	};

	const disposeResource = (
		entry: ResourceEntry,
	): VisualResourceDisposalReport => {
		if (entry.disposed) return emptyReport();
		entry.disposed = true;
		const disposer = entry.disposer;
		entry.disposer = null;
		try {
			disposer?.();
			return { disposed: 1, errors: [] };
		} catch (error) {
			return {
				disposed: 1,
				errors: [
					{
						scope: name,
						scopePath,
						owner: entry.owner,
						kind: entry.kind,
						retention: entry.retention,
						cause: error,
					},
				],
			};
		}
	};

	const scope: VisualResourceScope = {
		name,
		get closed() {
			return closed;
		},
		isOpen: () => !closed,
		register(registration) {
			assertOpen();
			const entry: ResourceEntry = {
				type: "resource",
				owner: registration.owner,
				kind: registration.kind,
				retention: registration.retention,
				estimatedBytes: registration.estimatedBytes,
				disposer: registration.dispose.bind(registration),
				disposed: false,
			};
			entries.push(entry);
			const handle: VisualResourceHandle = {
				owner: entry.owner,
				kind: entry.kind,
				retention: entry.retention,
				estimatedBytes: entry.estimatedBytes,
				get disposed() {
					return entry.disposed;
				},
				dispose: () => disposeResource(entry),
			};
			handleEntriesForTests.set(handle, entry);
			return handle;
		},
		createChild(childName) {
			assertOpen();
			const child = createVisualResourceScopeAtPath(
				childName,
				`${scopePath}/${childName}`,
			);
			entries.push({ type: "child", scope: child });
			return child;
		},
		releaseRetention(retention) {
			if (closed) return emptyReport();
			const retentions = new Set<VisualReleasableResourceRetention>(
				typeof retention === "string" ? [retention] : retention,
			);
			const report = {
				disposed: 0,
				errors: [] as VisualResourceDisposalError[],
			};
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry.type === "child") {
					mergeReports(report, entry.scope.releaseRetention(retention));
					continue;
				}
				if (retentions.has(entry.retention as VisualReleasableResourceRetention)) {
					mergeReports(report, disposeResource(entry));
				}
			}
			let nextEntryIndex = 0;
			for (const entry of entries) {
				if (entry.type === "resource" && entry.disposed) continue;
				entries[nextEntryIndex] = entry;
				nextEntryIndex += 1;
			}
			entries.length = nextEntryIndex;
			return report;
		},
		dispose() {
			if (closed) return emptyReport();
			closed = true;
			const report = {
				disposed: 0,
				errors: [] as VisualResourceDisposalError[],
			};
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				mergeReports(
					report,
					entry.type === "resource"
						? disposeResource(entry)
						: entry.scope.dispose(),
				);
			}
			entries.length = 0;
			return report;
		},
	};
	scopeEntriesForTests.set(scope, entries);

	return scope;
}

export function createVisualResourceScope(name: string): VisualResourceScope {
	return createVisualResourceScopeAtPath(name, name);
}

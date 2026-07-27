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
	readonly disposer: () => void;
	disposed: boolean;
}

interface ChildEntry {
	readonly type: "child";
	readonly scope: VisualResourceScope;
}

type ScopeEntry = ResourceEntry | ChildEntry;

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
		try {
			entry.disposer();
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
				disposer: registration.dispose,
				disposed: false,
			};
			entries.push(entry);
			return {
				owner: entry.owner,
				kind: entry.kind,
				retention: entry.retention,
				estimatedBytes: entry.estimatedBytes,
				get disposed() {
					return entry.disposed;
				},
				dispose: () => disposeResource(entry),
			};
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
			return report;
		},
	};

	return scope;
}

export function createVisualResourceScope(name: string): VisualResourceScope {
	return createVisualResourceScopeAtPath(name, name);
}

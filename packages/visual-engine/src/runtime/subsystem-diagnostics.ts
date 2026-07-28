export type VisualDiagnosticValue =
	| null
	| boolean
	| number
	| string
	| readonly VisualDiagnosticValue[]
	| VisualDiagnosticObject;

export interface VisualDiagnosticObject {
	readonly [key: string]: VisualDiagnosticValue;
}

export type VisualSubsystemDiagnosticsSnapshot = Readonly<
	Record<string, VisualDiagnosticObject>
>;

export type VisualSubsystemDiagnosticsSupplier = () => VisualDiagnosticObject;

export interface VisualSubsystemDiagnosticsPublisher {
	register(name: string, supplier: VisualSubsystemDiagnosticsSupplier): () => void;
}

export interface VisualSubsystemDiagnosticsRegistry extends VisualSubsystemDiagnosticsPublisher {
	snapshot(): VisualSubsystemDiagnosticsSnapshot;
	clear(): void;
}

function cloneDiagnosticValue(value: VisualDiagnosticValue): VisualDiagnosticValue {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((entry) => cloneDiagnosticValue(entry)));
	}
	if (value !== null && typeof value === "object") {
		return cloneDiagnosticObject(value as VisualDiagnosticObject);
	}
	return value;
}

function cloneDiagnosticObject(value: VisualDiagnosticObject): VisualDiagnosticObject {
	const copy: Record<string, VisualDiagnosticValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		copy[key] = cloneDiagnosticValue(entry);
	}
	return Object.freeze(copy);
}

export function cloneVisualSubsystemDiagnosticsSnapshot(
	value: VisualSubsystemDiagnosticsSnapshot,
): VisualSubsystemDiagnosticsSnapshot {
	const copy: Record<string, VisualDiagnosticObject> = {};
	for (const [name, diagnostics] of Object.entries(value)) {
		copy[name] = cloneDiagnosticObject(diagnostics);
	}
	return Object.freeze(copy);
}

export function createVisualSubsystemDiagnosticsRegistry(): VisualSubsystemDiagnosticsRegistry {
	const suppliers = new Map<string, VisualSubsystemDiagnosticsSupplier>();

	return {
		register(name, supplier) {
			const key = name.trim();
			if (!key) throw new TypeError("Subsystem diagnostics name must not be empty.");
			if (suppliers.has(key)) {
				throw new Error(`Subsystem diagnostics supplier already registered: ${key}`);
			}
			suppliers.set(key, supplier);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (suppliers.get(key) === supplier) suppliers.delete(key);
			};
		},
		snapshot() {
			const snapshot: Record<string, VisualDiagnosticObject> = {};
			for (const [name, supplier] of suppliers) {
				try {
					snapshot[name] = cloneDiagnosticObject(supplier());
				} catch {
					snapshot[name] = Object.freeze({ status: "unavailable" });
				}
			}
			return Object.freeze(snapshot);
		},
		clear() {
			suppliers.clear();
		},
	};
}

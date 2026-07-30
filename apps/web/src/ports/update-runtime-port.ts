export type UpdatePhase =
	| "disabled"
	| "idle"
	| "recovering-cache"
	| "checking"
	| "current"
	| "available"
	| "downloading"
	| "verifying"
	| "ready-to-install"
	| "preparing-install"
	| "installing";

export interface UpdateCandidateView {
	readonly id: string;
	readonly version: string;
	readonly notes: readonly string[];
	readonly publishedAt: string | null;
}

export interface UpdateOperationView {
	readonly id: string;
	readonly kind: "cache-revalidation" | "check" | "download" | "verify" | "install";
	readonly receivedBytes: number;
	readonly totalBytes: number | null;
	readonly cancellable: boolean;
}

export interface UpdateFaultView {
	readonly stage: "check" | "download" | "verify" | "cache" | "quiesce" | "install";
	readonly code: string;
	readonly retryable: boolean;
	readonly message: string;
}

export interface UpdateSnapshot {
	readonly revision: number;
	readonly phase: UpdatePhase;
	readonly currentVersion: string;
	readonly candidate: UpdateCandidateView | null;
	readonly operation: UpdateOperationView | null;
	readonly fault: UpdateFaultView | null;
	readonly checkedAt: number | null;
	readonly remindAfter: number | null;
	readonly skippedVersion: string | null;
}

export type UpdateIntent =
	| { readonly kind: "check-now" }
	| { readonly kind: "download"; readonly candidateId: string }
	| { readonly kind: "cancel-download"; readonly operationId: string }
	| { readonly kind: "remind-later"; readonly candidateId: string }
	| { readonly kind: "skip-version"; readonly candidateId: string }
	| { readonly kind: "install-and-restart"; readonly candidateId: string }
	| { readonly kind: "open-release"; readonly candidateId: string };

export type UpdateReceipt =
	| "accepted"
	| "stale-candidate"
	| "stale-operation"
	| "invalid-order"
	| "policy-blocked"
	| "runtime-unavailable";

export interface UpdateRuntimePort {
	getSnapshot(): UpdateSnapshot;
	subscribe(listener: () => void): () => void;
	dispatch(intent: UpdateIntent): Promise<UpdateReceipt>;
}

import { migrateHomeListenLedger, type HomeListenLedgerV2 } from "./home-listen-ledger";

export interface HomeListenRepository {
	read(): unknown;
	save(ledger: HomeListenLedgerV2): void | Promise<void>;
}

export function createMemoryHomeListenRepository(
	initial: unknown = null,
): HomeListenRepository & { snapshot(): HomeListenLedgerV2 } {
	let current = migrateHomeListenLedger(initial);
	return {
		read: () => current,
		save: (ledger) => {
			current = migrateHomeListenLedger(ledger);
		},
		snapshot: () => current,
	};
}

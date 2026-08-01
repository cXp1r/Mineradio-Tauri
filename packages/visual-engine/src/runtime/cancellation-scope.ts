export interface CancellationTicket {
	readonly owner: string;
	readonly key: string;
	readonly generation: number;
	readonly signal: AbortSignal;
	isCurrent(): boolean;
}

export class CancellationScopeClosedError extends Error {
	constructor(scopeName: string) {
		super(`Cancellation scope "${scopeName}" is closed.`);
		this.name = "CancellationScopeClosedError";
	}
}

export interface CancellationScope {
	readonly name: string;
	readonly closed: boolean;
	isOpen(): boolean;
	issue(owner: string, key: string): CancellationTicket;
	createChild(name: string): CancellationScope;
	dispose(): void;
}

interface TicketEntry {
	readonly controller: AbortController;
	readonly ticket: CancellationTicket;
}

function ticketId(owner: string, key: string): string {
	return `${owner}\u0000${key}`;
}

export function createCancellationScope(name: string): CancellationScope {
	let closed = false;
	const tickets = new Map<string, TicketEntry>();
	const generations = new Map<string, number>();
	const children = new Set<CancellationScope>();
	const assertOpen = () => {
		if (closed) throw new CancellationScopeClosedError(name);
	};

	return {
		name,
		get closed() {
			return closed;
		},
		isOpen() {
			return !closed;
		},
		issue(owner, key) {
			assertOpen();
			const id = ticketId(owner, key);
			const previous = tickets.get(id);
			const controller = new AbortController();
			const generation = (generations.get(id) ?? 0) + 1;
			generations.set(id, generation);
			let entry: TicketEntry;
			const ticket: CancellationTicket = {
				owner,
				key,
				generation,
				signal: controller.signal,
				isCurrent: () => !closed && tickets.get(id) === entry && !controller.signal.aborted,
			};
			entry = { controller, ticket };
			tickets.set(id, entry);
			previous?.controller.abort();
			return ticket;
		},
		createChild(childName) {
			assertOpen();
			const child = createCancellationScope(childName);
			children.add(child);
			return child;
		},
		dispose() {
			if (closed) return;
			closed = true;
			for (const child of children) child.dispose();
			for (const entry of tickets.values()) entry.controller.abort();
			tickets.clear();
		},
	};
}

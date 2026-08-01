export interface DesktopRequestGuard {
	begin(): number;
	isCurrent(generation: number): boolean;
	dispose(): void;
}

export function createDesktopRequestGuard(): DesktopRequestGuard {
	let active = true;
	let generation = 0;
	return {
		begin() {
			generation += 1;
			return generation;
		},
		isCurrent(candidate) {
			return active && candidate === generation;
		},
		dispose() {
			active = false;
			generation += 1;
		},
	};
}

export async function runLatestDesktopRequest<T>(
	guard: DesktopRequestGuard,
	load: () => Promise<T>,
	onSuccess: (value: T) => void,
	onError: (error: unknown) => void = () => undefined,
): Promise<void> {
	const generation = guard.begin();
	try {
		const value = await load();
		if (guard.isCurrent(generation)) onSuccess(value);
	} catch (error) {
		if (guard.isCurrent(generation)) onError(error);
	}
}

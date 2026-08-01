import type { ProviderLoginQrCheck } from "@mineradio/shared";

export type LoginQrCheckState = "success" | "expired" | "scanned" | "waiting";

export function classifyLoginQrCheck(result: ProviderLoginQrCheck): LoginQrCheckState {
	if (result.stored || result.loggedIn) return "success";
	if (result.expired || result.code === 800 || result.code === 65) return "expired";
	if (result.scanned || result.code === 802 || result.code === 67) return "scanned";
	return "waiting";
}

export class LoginQrCoordinator {
	private generationToken = 0;
	private pollInFlight = false;

	beginGeneration(): number {
		this.generationToken += 1;
		this.pollInFlight = false;
		return this.generationToken;
	}

	invalidateGeneration(): void {
		this.generationToken += 1;
		this.pollInFlight = false;
	}

	isGenerationCurrent(token: number): boolean {
		return token === this.generationToken;
	}

	claimPoll(): boolean {
		if (this.pollInFlight) return false;
		this.pollInFlight = true;
		return true;
	}

	releasePoll(): void {
		this.pollInFlight = false;
	}
}

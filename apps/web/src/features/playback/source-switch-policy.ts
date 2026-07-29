import type { Track } from "@mineradio/shared";

const NON_PLAYABLE_STATES = new Set([
	"login_required",
	"vip_required",
	"paid_required",
	"copyright_unavailable",
	"unavailable",
]);

function normalizeIdentityText(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizedArtists(track: Track): string[] {
	return track.artists
		.map(normalizeIdentityText)
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right));
}

export function isStrictSourceCandidate(original: Track, candidate: Track): boolean {
	if (!candidate.id || candidate.provider === original.provider) return false;
	if (NON_PLAYABLE_STATES.has(candidate.playableState)) return false;
	if (normalizeIdentityText(candidate.title) !== normalizeIdentityText(original.title)) {
		return false;
	}
	const expectedArtists = normalizedArtists(original);
	const candidateArtists = normalizedArtists(candidate);
	if (!expectedArtists.length || expectedArtists.length !== candidateArtists.length) {
		return false;
	}
	return expectedArtists.every((artist, index) => artist === candidateArtists[index]);
}

export function selectStrictSourceCandidate(
	original: Track,
	candidates: readonly Track[],
): Track | null {
	return candidates.find((candidate) => isStrictSourceCandidate(original, candidate)) ?? null;
}

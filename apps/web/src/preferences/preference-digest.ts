function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => [key, canonicalize(item)]),
	);
}

export function canonicalPreferenceJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export async function canonicalPreferenceDigest(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalPreferenceJson(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

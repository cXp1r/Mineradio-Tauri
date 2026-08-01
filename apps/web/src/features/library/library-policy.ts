import type { PlaylistSummary, ProviderId, Track } from "@mineradio/shared";
import { isImportOnlyTrack } from "../../shared-playlist/import-only-track";

export function mergeProviderPlaylists(
	current: PlaylistSummary[],
	provider: ProviderId,
	next: PlaylistSummary[],
): PlaylistSummary[] {
	const merged = current.filter((playlist) => playlist.provider !== provider);
	const seen = new Set(
		merged.map((playlist) => `${playlist.provider}:${playlist.id}`),
	);
	for (const playlist of next) {
		if (playlist.provider !== provider) continue;
		const key = `${playlist.provider}:${playlist.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(playlist);
	}
	return merged;
}

export function isCollectSupportedTrack(
	track: Track | null | undefined,
): track is Track {
	if (!track?.id) return false;
	const record = track as unknown as Record<string, unknown>;
	if (isImportOnlyTrack(track)) return false;
	if (track.id.startsWith("local:")) return false;
	if (record.type === "local" || record.source === "local") return false;
	if (record.type === "podcast" || record.source === "podcast") return false;
	return track.provider === "netease" || track.provider === "qq";
}

export function collectUnsupportedMessage(
	track: Track | null | undefined,
): string {
	if (isImportOnlyTrack(track)) return "导入曲目暂不支持收藏到歌单";
	return "当前来源暂不支持收藏到歌单";
}

export function isLibraryLoginRequiredError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "LOGIN_REQUIRED"
	);
}

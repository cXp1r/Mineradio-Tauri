import type { ProviderId, Track } from "@mineradio/shared";
import { isImportOnlyTrack } from "../../shared-playlist/import-only-track";

export function providerLikeLabel(provider: ProviderId): string {
	if (provider === "netease") return "网易云";
	if (provider === "qq") return "QQ 音乐";
	return "汽水音乐";
}

export function trackLikeKey(track: Track | null | undefined): string {
	const id = track?.sourceId || track?.id || "";
	return track?.provider && id ? `${track.provider}:${id}` : "";
}

export function trackProviderLikeId(track: Track | null | undefined): string {
	return String(track?.sourceId || track?.id || "").trim();
}

export function isProviderLikeSupported(
	track: Track | null | undefined,
): track is Track {
	if (!track || !trackProviderLikeId(track)) return false;
	const record = track as unknown as Record<string, unknown>;
	if (isImportOnlyTrack(track)) return false;
	if (track.id.startsWith("local:")) return false;
	if (record.type === "local" || record.source === "local") return false;
	if (record.type === "podcast" || record.source === "podcast") return false;
	return track.provider === "netease" || track.provider === "soda";
}

export function isNeteaseLikeSupported(
	track: Track | null | undefined,
): track is Track {
	return isProviderLikeSupported(track) && track.provider === "netease";
}

export function likeUnsupportedMessage(
	track: Track | null | undefined,
): string {
	const record = track as unknown as Record<string, unknown> | null | undefined;
	if (isImportOnlyTrack(track)) return "导入曲目暂不支持红心同步";
	if (
		track?.provider === "qq" ||
		record?.provider === "qq" ||
		record?.source === "qq" ||
		record?.type === "qq"
	) {
		return "QQ 音乐红心同步待登录接口接入";
	}
	if (track?.provider === "soda") return "汽水音乐红心同步暂不可用";
	return "本地文件暂不支持红心同步";
}

export function isLoginRequiredError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "LOGIN_REQUIRED"
	);
}

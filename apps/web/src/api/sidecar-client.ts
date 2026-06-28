import {
	ApiFailureSchema,
	ApiSuccessSchema,
	CapabilityMatrixSchema,
	CapabilityMatrix,
	HealthResponse,
	HealthResponseSchema,
	LyricPayloadSchema,
	PlaylistDetailSchema,
	ProviderId,
	ProviderSessionCookieAck,
	ProviderSessionCookieAckSchema,
	ProviderLoginStatus,
	ProviderLoginStatusSchema,
	ProviderLogoutAck,
	ProviderLogoutAckSchema,
	SongUrlResultSchema,
	type PlaybackQuality,
	TrackArraySchema,
	Track,
	LyricPayload,
	PlaylistDetail,
	SongUrlResult,
	type ZodTypeLike,
} from "@mineradio/shared";

export interface SidecarClientErrorInit {
	code: string;
	message: string;
	provider?: string;
	retryable: boolean;
	action?: string;
}

export class SidecarClientError extends Error {
	readonly code: string;
	readonly provider?: string;
	readonly retryable: boolean;
	readonly action?: string;

	constructor(init: SidecarClientErrorInit) {
		super(init.message);
		this.name = "SidecarClientError";
		this.code = init.code;
		this.provider = init.provider;
		this.retryable = init.retryable;
		this.action = init.action;
	}
}

const CapabilitySuccessEnvelopeSchema = ApiSuccessSchema(CapabilityMatrixSchema);

type FetchImpl = typeof fetch;

async function readJsonSafely(res: Response): Promise<unknown | null> {
	try {
		return await res.json() as unknown;
	} catch {
		return null;
	}
}

function throwFailureEnvelope(json: unknown): never | void {
	const failure = ApiFailureSchema.safeParse(json);
	if (!failure.success) return;
	throw new SidecarClientError({
		code: failure.data.error.code,
		message: failure.data.error.message,
		provider: failure.data.error.provider,
		retryable: failure.data.error.retryable,
		action: failure.data.error.action,
	});
}

export class SidecarClient {
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchImpl;

	constructor(baseUrl: string, fetchImpl: FetchImpl = fetch) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.fetchImpl = fetchImpl;
	}

	async health(): Promise<HealthResponse> {
		const res = await this.fetchImpl(`${this.baseUrl}/health`);
		const json = await readJsonSafely(res);
		throwFailureEnvelope(json);
		if (!res.ok) {
			throw new SidecarClientError({
				code: `HTTP_${res.status}`,
				message: `health request failed with status ${res.status}`,
				retryable: res.status >= 500 || res.status === 429,
			});
		}
		const parsed = HealthResponseSchema.safeParse(json);
		if (!parsed.success) {
			throw new SidecarClientError({
				code: "SCHEMA",
				message: "health response failed schema validation",
				retryable: false,
			});
		}
		return parsed.data;
	}

	async capabilities(): Promise<CapabilityMatrix> {
		const res = await this.fetchImpl(`${this.baseUrl}/providers/capabilities`);
		const json = await readJsonSafely(res);
		throwFailureEnvelope(json);
		if (!res.ok) {
			throw new SidecarClientError({
				code: `HTTP_${res.status}`,
				message: `capabilities request failed with status ${res.status}`,
				retryable: res.status >= 500 || res.status === 429,
			});
		}
		const envelope = CapabilitySuccessEnvelopeSchema.safeParse(json);
		if (!envelope.success) {
			throw new SidecarClientError({
				code: "SCHEMA",
				message: "capabilities response failed schema validation",
				retryable: false,
			});
		}
		return envelope.data.data;
	}

	private async request<T>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		schema: ZodTypeLike,
		body?: unknown,
	): Promise<T> {
		const init: RequestInit = method === "POST"
			? {
					method,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body ?? {}),
				}
			: { method };
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
		const json = await readJsonSafely(res);
		throwFailureEnvelope(json);
		if (!res.ok) {
			throw new SidecarClientError({
				code: `HTTP_${res.status}`,
				message: `${method} ${path} failed with status ${res.status}`,
				retryable: res.status >= 500 || res.status === 429,
			});
		}
		const envelope = ApiSuccessSchema(schema).safeParse(json);
		if (!envelope.success) {
			throw new SidecarClientError({
				code: "SCHEMA",
				message: `${method} ${path} response failed schema validation`,
				retryable: false,
			});
		}
		return envelope.data.data as T;
	}

	async search(provider: ProviderId, keyword: string, limit: number): Promise<Track[]> {
		const params = new URLSearchParams({ keyword, limit: String(limit) });
		return this.request(
			"GET",
			`/providers/${provider}/search?${params.toString()}`,
			TrackArraySchema,
		);
	}

	async searchAll(keyword: string, limit: number, provider?: ProviderId): Promise<Track[]> {
		const params = new URLSearchParams({ keyword, limit: String(limit) });
		if (provider) params.set("provider", provider);
		return this.request(
			"GET",
			`/search?${params.toString()}`,
			TrackArraySchema,
		);
	}

	async songUrl(track: Track, quality?: PlaybackQuality): Promise<SongUrlResult> {
		return this.request(
			"POST",
			`/providers/${track.provider}/song-url`,
			SongUrlResultSchema,
			quality ? { track, quality } : track,
		);
	}

	async resolveSongUrl(track: Track, quality?: PlaybackQuality): Promise<SongUrlResult> {
		return this.request(
			"POST",
			"/song-url",
			SongUrlResultSchema,
			quality ? { track, quality } : track,
		);
	}

	audioProxyUrl(url: string): string {
		const params = new URLSearchParams({ url });
		return `${this.baseUrl}/audio-proxy?${params.toString()}`;
	}

	imageProxyUrl(url: string, cacheBust = false, now = Date.now()): string {
		if (!url) return "";
		if (/^data:image\//i.test(url) || /^blob:/i.test(url)) return url;
		if (!/^https?:\/\//i.test(url)) return "";
		const params = new URLSearchParams({ url });
		if (cacheBust) params.set("v", String(now));
		return `${this.baseUrl}/image-proxy?${params.toString()}`;
	}

	async lyric(track: Track): Promise<LyricPayload> {
		return this.request(
			"POST",
			`/providers/${track.provider}/lyric`,
			LyricPayloadSchema,
			track,
		);
	}

	async playlistDetail(provider: ProviderId, id: string): Promise<PlaylistDetail> {
		return this.request(
			"GET",
			`/providers/${provider}/playlists/${encodeURIComponent(id)}`,
			PlaylistDetailSchema,
		);
	}

	async setProviderSessionCookie(
		provider: ProviderId,
		cookie: string,
	): Promise<ProviderSessionCookieAck> {
		return this.request(
			"POST",
			`/providers/${provider}/session-cookie`,
			ProviderSessionCookieAckSchema,
			{ cookie },
		);
	}

	async clearProviderSessionCookie(provider: ProviderId): Promise<ProviderSessionCookieAck> {
		return this.request(
			"DELETE",
			`/providers/${provider}/session-cookie`,
			ProviderSessionCookieAckSchema,
		);
	}

	async loginStatus(provider: ProviderId): Promise<ProviderLoginStatus> {
		return this.request(
			"GET",
			`/providers/${provider}/login-status`,
			ProviderLoginStatusSchema,
		);
	}

	async logout(provider: ProviderId): Promise<ProviderLogoutAck> {
		return this.request(
			"POST",
			`/providers/${provider}/logout`,
			ProviderLogoutAckSchema,
		);
	}
}

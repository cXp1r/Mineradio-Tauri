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
	SongUrlResultSchema,
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
}

export class SidecarClientError extends Error {
	readonly code: string;
	readonly provider?: string;
	readonly retryable: boolean;

	constructor(init: SidecarClientErrorInit) {
		super(init.message);
		this.name = "SidecarClientError";
		this.code = init.code;
		this.provider = init.provider;
		this.retryable = init.retryable;
	}
}

const CapabilitySuccessEnvelopeSchema = ApiSuccessSchema(CapabilityMatrixSchema);

type FetchImpl = typeof fetch;

export class SidecarClient {
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchImpl;

	constructor(baseUrl: string, fetchImpl: FetchImpl = fetch) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.fetchImpl = fetchImpl;
	}

	async health(): Promise<HealthResponse> {
		const res = await this.fetchImpl(`${this.baseUrl}/health`);
		if (!res.ok) {
			throw new SidecarClientError({
				code: `HTTP_${res.status}`,
				message: `health request failed with status ${res.status}`,
				retryable: res.status >= 500 || res.status === 429,
			});
		}
		const json = (await res.json()) as unknown;
		const failure = ApiFailureSchema.safeParse(json);
		if (failure.success) {
			throw new SidecarClientError({
				code: failure.data.error.code,
				message: failure.data.error.message,
				provider: failure.data.error.provider,
				retryable: failure.data.error.retryable,
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
		if (!res.ok) {
			throw new SidecarClientError({
				code: `HTTP_${res.status}`,
				message: `capabilities request failed with status ${res.status}`,
				retryable: res.status >= 500 || res.status === 429,
			});
		}
		const json = (await res.json()) as unknown;
		const failure = ApiFailureSchema.safeParse(json);
		if (failure.success) {
			throw new SidecarClientError({
				code: failure.data.error.code,
				message: failure.data.error.message,
				provider: failure.data.error.provider,
				retryable: failure.data.error.retryable,
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
		method: "GET" | "POST",
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
		if (!res.ok) {
			throw new SidecarClientError({
				code: `HTTP_${res.status}`,
				message: `${method} ${path} failed with status ${res.status}`,
				retryable: res.status >= 500 || res.status === 429,
			});
		}
		const json = (await res.json()) as unknown;
		const failure = ApiFailureSchema.safeParse(json);
		if (failure.success) {
			throw new SidecarClientError({
				code: failure.data.error.code,
				message: failure.data.error.message,
				provider: failure.data.error.provider,
				retryable: failure.data.error.retryable,
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

	async songUrl(track: Track): Promise<SongUrlResult> {
		return this.request(
			"POST",
			`/providers/${track.provider}/song-url`,
			SongUrlResultSchema,
			track,
		);
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
}
import type {
  Track,
  PlaylistSummary,
  PlaylistDetail,
  LyricPayload,
  ProviderId,
  PlaybackQuality
} from "@mineradio/shared";

export type ProviderLoginStatus = {
  provider: ProviderId;
  loggedIn: boolean;
  nickname?: string;
  avatarUrl?: string;
  userId?: string;
};

export type SongUrlOptions = { quality?: PlaybackQuality };
export type SongUrlResult = {
  url: string;
  proxied: boolean;
  level?: PlaybackQuality;
  quality?: string;
  br?: number;
  requestedQuality?: PlaybackQuality | null;
};

export interface ProviderAdapter {
  readonly id: ProviderId;
  search(query: { keyword: string; limit: number }): Promise<Track[]>;
  songUrl(track: Track, opts?: SongUrlOptions): Promise<SongUrlResult>;
  lyric(track: Track): Promise<LyricPayload>;
  playlistList(): Promise<PlaylistSummary[]>;
  playlistDetail(id: string): Promise<PlaylistDetail>;
  loginStatus(): Promise<ProviderLoginStatus>;
  logout(): Promise<void>;
}

export class ProviderNotImplementedError extends Error {
  readonly code: "NOT_IMPLEMENTED" = "NOT_IMPLEMENTED";
  readonly provider: ProviderId;
  readonly retryable: false = false;
  readonly action: string;
  constructor(provider: ProviderId, action: string, message?: string) {
    super(message ?? `provider ${provider} not implemented (action: ${action})`);
    this.name = "ProviderNotImplementedError";
    this.provider = provider;
    this.action = action;
  }
}

export class ProviderError extends Error {
  readonly code: string;
  readonly provider: ProviderId;
  readonly retryable: boolean;
  readonly action?: string;
  constructor(
    provider: ProviderId,
    code: string,
    message: string,
    opts?: { retryable?: boolean; action?: string }
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.action = opts?.action;
  }
}

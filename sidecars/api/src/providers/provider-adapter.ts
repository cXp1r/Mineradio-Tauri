import type {
  Track,
  PlaylistSummary,
  PlaylistDetail,
  LyricPayload,
  ProviderId,
  ProviderVipIcon,
  PlaybackRestriction,
  PlaybackRestrictionCategory,
  SongUrlResult,
  TrackQualityAvailability,
  SongLikeAck,
  SongLikeCheckAck,
  PlaylistAddSongAck
} from "@mineradio/shared";

export type ProviderLoginStatus = {
  provider: ProviderId;
  loggedIn: boolean;
  nickname?: string;
  avatarUrl?: string;
  userId?: string;
  vipType?: number;
  vipLevel?: "none" | "vip" | "svip";
  isVip?: boolean;
  isSvip?: boolean;
  vipLabel?: string;
  vipIcon?: ProviderVipIcon;
  vipIconUrl?: string;
  vipTier?: number;
  vipLevelName?: string;
};

export type SongUrlOptions = { quality?: string };
export type { SongUrlResult };

export interface ProviderAdapter {
  readonly id: ProviderId;
  search(query: { keyword: string; limit: number }): Promise<Track[]>;
  songUrl(track: Track, opts?: SongUrlOptions): Promise<SongUrlResult>;
  trackQualities(track: Track): Promise<TrackQualityAvailability>;
  lyric(track: Track): Promise<LyricPayload>;
  playlistList(): Promise<PlaylistSummary[]>;
  playlistDetail(id: string): Promise<PlaylistDetail>;
  likeSong?(id: string, liked: boolean): Promise<SongLikeAck>;
  checkSongLikes?(ids: string[]): Promise<SongLikeCheckAck>;
  addSongToPlaylist?(playlistId: string, trackId: string): Promise<PlaylistAddSongAck>;
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
  readonly playbackKeyReady?: boolean;
  readonly restriction?: PlaybackRestriction;
  readonly reason?: PlaybackRestrictionCategory;
  readonly qqCode?: number;
  readonly rawMessage?: string;
  readonly tried?: string[];
  constructor(
    provider: ProviderId,
    code: string,
    message: string,
    opts?: {
      retryable?: boolean;
      action?: string;
      playbackKeyReady?: boolean;
      restriction?: PlaybackRestriction;
      reason?: PlaybackRestrictionCategory;
      qqCode?: number;
      rawMessage?: string;
      tried?: string[];
    }
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.action = opts?.action;
    this.playbackKeyReady = opts?.playbackKeyReady;
    this.restriction = opts?.restriction;
    this.reason = opts?.reason;
    this.qqCode = opts?.qqCode;
    this.rawMessage = opts?.rawMessage;
    this.tried = opts?.tried;
  }
}

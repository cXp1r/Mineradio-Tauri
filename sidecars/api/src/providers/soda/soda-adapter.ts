import type {
  LyricPayload,
  PlaylistDetail,
  PlaylistSummary,
  SongLikeAck,
  SongLikeCheckAck,
  Track
} from "@mineradio/shared";
import {
  ProviderNotImplementedError,
  type ProviderAdapter,
  type ProviderLoginStatus,
  type SongUrlOptions,
  type SongUrlResult
} from "../provider-adapter";
import { createSodaClient, type SodaClient, type SodaClientDeps } from "./soda-client";
import { mapSodaLyricToPayload, mapSodaPlaylistToDetail, mapSodaPlaylistToSummary, mapSodaSongToTrack, type SodaSong } from "./map";

const SODA_PROVIDER_ID = "soda";

export interface SodaAdapterDeps extends SodaClientDeps {
  client?: SodaClient;
}

function fail(action: string): never {
  throw new ProviderNotImplementedError(SODA_PROVIDER_ID, action, `soda provider scaffold is not wired for ${action}`);
}

export function createSodaAdapter(deps: SodaAdapterDeps): ProviderAdapter {
  const client = deps.client ?? createSodaClient(deps);
  void client;
  void mapSodaSongToTrack;
  void mapSodaLyricToPayload;
  void mapSodaPlaylistToSummary;
  void mapSodaPlaylistToDetail;

  return {
    id: SODA_PROVIDER_ID,
    async search(_: { keyword: string; limit: number }): Promise<Track[]> {
      return fail("search");
    },
    async songUrl(_: Track, __?: SongUrlOptions): Promise<SongUrlResult> {
      return fail("songUrl");
    },
    async lyric(_: Track): Promise<LyricPayload> {
      return fail("lyric");
    },
    async playlistList(): Promise<PlaylistSummary[]> {
      return fail("playlistList");
    },
    async playlistDetail(_: string): Promise<PlaylistDetail> {
      return fail("playlistDetail");
    },
    async likeSong(_: string, __: boolean): Promise<SongLikeAck> {
      return fail("likeSong");
    },
    async checkSongLikes(_: string[]): Promise<SongLikeCheckAck> {
      return fail("checkSongLikes");
    },
    async loginStatus(): Promise<ProviderLoginStatus> {
      return fail("loginStatus");
    },
    async logout(): Promise<void> {
      fail("logout");
    }
  };
}

export const sodaAdapter: ProviderAdapter = createSodaAdapter({
  getConfig() {
    return {};
  }
});

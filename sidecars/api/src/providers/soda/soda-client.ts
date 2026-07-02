import { ProviderNotImplementedError } from "../provider-adapter";

const SODA_PROVIDER_ID = "soda";

export interface SodaClientConfig {
  cookie?: string;
}

export interface SodaClientDeps {
  getConfig(): SodaClientConfig;
}

export interface SodaClient {
  search(query: { keyword: string; limit: number }): Promise<{ body: unknown }>;
  songUrl(trackId: string): Promise<{ body: unknown }>;
  lyric(trackId: string): Promise<{ body: unknown }>;
  playlistList(): Promise<{ body: unknown }>;
  playlistDetail(id: string): Promise<{ body: unknown }>;
  loginStatus(): Promise<{ body: unknown }>;
  logout(): Promise<{ body: unknown }>;
}

function notImplemented(action: string): never {
  throw new ProviderNotImplementedError(SODA_PROVIDER_ID, action, `soda provider scaffold is not wired for ${action}`);
}

export function createSodaClient(_: SodaClientDeps): SodaClient {
  return {
    async search() { return notImplemented("search"); },
    async songUrl() { return notImplemented("songUrl"); },
    async lyric() { return notImplemented("lyric"); },
    async playlistList() { return notImplemented("playlistList"); },
    async playlistDetail() { return notImplemented("playlistDetail"); },
    async loginStatus() { return notImplemented("loginStatus"); },
    async logout() { return notImplemented("logout"); }
  };
}

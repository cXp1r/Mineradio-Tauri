import type {
  CapabilityMatrix,
  ProviderStatusEntry,
  ProviderCapability,
  ProviderId
} from "@mineradio/shared";
import { neteaseAdapter } from "./netease/netease-adapter";
import { qqAdapter } from "./qq/qq-adapter";
import type { ProviderAdapter } from "./provider-adapter";

export const providers: Record<ProviderId, ProviderAdapter> = {
  netease: neteaseAdapter,
  qq: qqAdapter
};

export const PROVIDER_IDS: ProviderId[] = ["netease", "qq"];

const NETEASE_CAPABILITIES: ProviderCapability[] = [
  "search",
  "songUrl",
  "lyric",
  "playlistList",
  "playlistDetail",
  "loginStatus",
  "logout",
  "like",
  "quality"
];

const QQ_CAPABILITIES: ProviderCapability[] = [
  "search",
  "songUrl",
  "lyric",
  "playlistList",
  "playlistDetail",
  "loginStatus",
  "logout",
  "quality"
];

export function buildCapabilityMatrix(): CapabilityMatrix {
  const entries: ProviderStatusEntry[] = [
    {
      providerId: "netease",
      available: true,
      capabilities: NETEASE_CAPABILITIES,
      message: "online"
    },
    {
      providerId: "qq",
      available: true,
      capabilities: QQ_CAPABILITIES,
      message: "online"
    }
  ];
  return { version: "0.1.0", providers: entries };
}

import type { LegacyPreferenceStorage } from "../../preferences/legacy-preferences";

/** localStorage 只在 legacy storage adapter 内解析，领域和 composition 不直接访问。 */
export function getLegacyBrowserPreferenceStorage(): LegacyPreferenceStorage | null {
	return typeof localStorage === "undefined" ? null : localStorage;
}

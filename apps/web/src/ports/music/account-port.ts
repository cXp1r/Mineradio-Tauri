import type {
	ProviderId,
	ProviderLoginQrCheck,
	ProviderLoginQrImage,
	ProviderLoginQrKey,
	ProviderLoginStatus,
	ProviderLogoutAck,
	ProviderSessionCookieAck,
} from "@mineradio/shared";

export interface AccountPort {
	loginStatus(provider: ProviderId): Promise<ProviderLoginStatus>;
	createLoginQrKey(provider: ProviderId): Promise<ProviderLoginQrKey>;
	createLoginQrImage(provider: ProviderId, key: string): Promise<ProviderLoginQrImage>;
	checkLoginQr(provider: ProviderId, key: string): Promise<ProviderLoginQrCheck>;
	setSessionCookie(provider: ProviderId, cookie: string): Promise<ProviderSessionCookieAck>;
	clearSessionCookie(provider: ProviderId): Promise<ProviderSessionCookieAck>;
	logout(provider: ProviderId): Promise<ProviderLogoutAck>;
}

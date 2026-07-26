export interface MediaUrlOptions {
	cacheBust?: boolean;
	now?: number;
}

export interface MediaUrlPort {
	audioProxyUrl(url: string): string;
	playableUrl(url: string): string;
	imageUrl(url: string, options?: MediaUrlOptions): string;
}

import type {
	PodcastHotResponse,
	PodcastProgramsResponse,
	PodcastSearchResponse,
	ProviderId,
	Track,
} from "@mineradio/shared";

export interface SearchPort {
	search(provider: ProviderId, keyword: string, limit?: number): Promise<Track[]>;
	searchAll(keyword: string, limit?: number, provider?: ProviderId): Promise<Track[]>;
}

export interface SearchExperiencePort extends SearchPort {
	podcastSearch(keywords: string, limit?: number): Promise<PodcastSearchResponse>;
	podcastHot(limit?: number, offset?: number): Promise<PodcastHotResponse>;
	podcastPrograms(id: string, limit?: number, offset?: number): Promise<PodcastProgramsResponse>;
}

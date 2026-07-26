import { expect, test } from "bun:test";
import { SidecarClient } from "../../api/sidecar-client";
import { createLegacyMediaUrl } from "./legacy-media-url";

test("legacy media adapter returns byte-for-byte current SidecarClient URLs", () => {
	const client = new SidecarClient("http://127.0.0.1:39999/");
	const media = createLegacyMediaUrl(client);
	const remoteAudio = "https://example.com/audio.mp3?token=测试";
	const relativeAudio = "/providers/soda/audio-proxy?id=track-1";
	const image = "https://example.com/cover.jpg?size=640";

	expect(media.audioProxyUrl(remoteAudio)).toBe(client.audioProxyUrl(remoteAudio));
	expect(media.playableUrl(relativeAudio)).toBe(client.proxiedUrl(relativeAudio));
	expect(media.playableUrl(remoteAudio)).toBe(client.proxiedUrl(remoteAudio));
	expect(media.imageUrl(image)).toBe(client.imageProxyUrl(image));
	expect(media.imageUrl(image, { cacheBust: true, now: 1234 }))
		.toBe(client.imageProxyUrl(image, true, 1234));
});

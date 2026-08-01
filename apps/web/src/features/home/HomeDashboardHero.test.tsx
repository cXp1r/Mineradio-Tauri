import { expect, test } from "bun:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { HomeDashboardHero } from "./HomeDashboardHero";
import { createMemoryHomeHeroVideoRepository } from "./home-hero-video-repository";

test("Hero releases its owned Object URL on pagehide and does not revoke it twice on unmount", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	const created: string[] = [];
	const revoked: string[] = [];
	URL.createObjectURL = () => {
		const url = `blob:home-${created.length + 1}`;
		created.push(url);
		return url;
	};
	URL.revokeObjectURL = (url) => revoked.push(url);

	try {
		const blob = new File([new Uint8Array([1, 2, 3])], "hero.mp4", {
			type: "video/mp4",
		});
		const repository = createMemoryHomeHeroVideoRepository({
			blob,
			meta: {
				version: 1,
				name: "hero.mp4",
				type: "video/mp4",
				size: blob.size,
				savedAt: 1,
			},
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		flushSync(() =>
			root.render(
				<React.StrictMode>
					<HomeDashboardHero active repository={repository} />
				</React.StrictMode>,
			),
		);
		for (let tick = 0; tick < 12 && created.length === 0; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(created).toEqual(["blob:home-1"]);
		expect(host.querySelector("video")?.getAttribute("src")).toBe(
			"blob:home-1",
		);
		window.dispatchEvent(new Event("pagehide"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(revoked).toEqual(["blob:home-1"]);

		root.unmount();
		host.remove();
		expect(revoked).toEqual(["blob:home-1"]);
	} finally {
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
	}
});

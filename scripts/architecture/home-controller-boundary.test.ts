import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(
	resolve(import.meta.dir, "../../apps/web/src/app/App.tsx"),
	"utf8",
);

test("App delegates Home requests, playlist detail and listen sessions", () => {
	expect(appSource).toContain("useHomeController");
	expect(appSource).not.toContain(".discoverHome(");
	expect(appSource).not.toContain(".weatherRadio(");
	expect(appSource).not.toContain(".playlistDetail(");
	expect(appSource).not.toContain(".podcastPrograms(");
	expect(appSource).not.toContain("homeDiscoverRequestSeqRef");
	expect(appSource).not.toContain("homeWeatherRadioRequestSeqRef");
	expect(appSource).not.toContain("homeListenSessionRef");
	expect(appSource).not.toContain("mineradio-listen-stats");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(
	resolve(import.meta.dir, "../../apps/web/src/app/App.tsx"),
	"utf8",
);

test("App delegates library refresh, import and collect mutations", () => {
	expect(appSource).toContain("useLibraryController");
	expect(appSource).not.toContain(".playlistList(");
	expect(appSource).not.toContain(".addSongToPlaylist(");
	expect(appSource).not.toContain(".importSharedPlaylist(");
	expect(appSource).not.toContain(".podcastMy(");
	expect(appSource).not.toContain(".podcastMyItems(");
	expect(appSource).not.toContain("setImportedPlaylists");
	expect(appSource).not.toContain("setCollectTarget");
	expect(appSource).not.toContain("setCollectBusyPlaylistId");
});

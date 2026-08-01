import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(
	resolve(import.meta.dir, "../../apps/web/src/app/App.tsx"),
	"utf8",
);

test("App delegates like queries and mutations to the likes controller", () => {
	expect(appSource).toContain("useLikesController");
	expect(appSource).not.toContain(".checkSongLikes(");
	expect(appSource).not.toContain(".likeSong(");
	expect(appSource).not.toContain("likedSongMap");
	expect(appSource).not.toContain("likeBusyMap");
	expect(appSource).not.toContain("likeStatusRequestSeqRef");
});

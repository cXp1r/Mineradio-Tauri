import { expect, test } from "bun:test";
import { wallpaperEngineMediaUrl } from "./wallpaper-engine-media-url";

test("wallpaper media only accepts the registered Tauri protocol origin", () => {
	expect(wallpaperEngineMediaUrl("mineradio-wallpaper://project/preview?r=1")).toBe("mineradio-wallpaper://project/preview?r=1");
	expect(wallpaperEngineMediaUrl("http://mineradio-wallpaper.localhost/project/preview?r=1")).toBe("http://mineradio-wallpaper.localhost/project/preview?r=1");
	expect(wallpaperEngineMediaUrl("http://127.0.0.1:3000/audio")).toBe(undefined);
	expect(wallpaperEngineMediaUrl("https://example.com/cover")).toBe(undefined);
});

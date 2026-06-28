import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { EmptyHomeHost } from "./EmptyHomeHost";

test("EmptyHomeHost renders the baseline empty-home music landing structure", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost));
	expect(html).toContain('id="empty-home"');
	expect(html).toContain("🚧此处施工，敬请期待🚧");
	expect(html).toContain("展开播放器控制台");
	expect(html).toContain('class="home-grid"');
	expect(html).toContain("我的歌单");
	expect(html).toContain("每日推荐");
	expect(html).toContain("私人电台");
	expect(html).toContain('id="home-tile-row"');
});

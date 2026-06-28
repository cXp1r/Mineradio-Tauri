import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { App } from "./App";

test("App keeps the empty-home music page mounted behind the splash gate", () => {
	const html = renderToStaticMarkup(React.createElement(App));
	expect(html).toContain('class="visual-splash-root"');
	expect(html).toContain('id="visual-host"');
	expect(html).toContain('id="empty-home"');
	expect(html).toContain('id="search-area"');
	expect(html).toContain('id="top-right"');
	expect(html).toContain('id="bottom-handle"');
	expect(html).toContain('id="bottom-bar"');
	expect(html).toContain("🚧此处施工，敬请期待🚧");
	expect(html).toContain("展开播放器控制台");
	expect(html).toContain("每日推荐");
});

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceSwitcher } from "./SourceSwitcher";

test("音源切换器只展示当前 capability 可用且非当前的 provider", () => {
	const html = renderToStaticMarkup(
		<SourceSwitcher
			currentProvider="netease"
			availableProviders={["netease", "qq", "soda"]}
			busyProvider={null}
			onSwitch={() => {}}
		/>,
	);

	expect(html).not.toContain('data-source-provider="netease"');
	expect(html).toContain('data-source-provider="qq"');
	expect(html).toContain('data-source-provider="soda"');
	expect(html).not.toContain("酷狗");
	expect(html).not.toContain("Spotify");
});

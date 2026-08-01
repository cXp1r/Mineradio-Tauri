import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsWorkbench } from "./SettingsWorkbench";

test("设置工作台渲染六个分类、搜索、低配入口和可回滚历史", () => {
	const html = renderToStaticMarkup(
		<SettingsWorkbench
			activeTab="common"
			query=""
			history={{
				busy: false,
				error: null,
				entries: [
					{
						id: "one",
						label: "调整律动强度",
						changedPaths: ["intensity"],
						before: { intensity: 0.8 },
						after: { intensity: 1.1 },
						committedAt: 1,
					},
				],
			}}
			onTabChange={() => {}}
			onQueryChange={() => {}}
			onUndo={() => {}}
			onRollbackTo={() => {}}
			onEnableLowSpec={() => {}}
			onResetPreferences={() => {}}
		/>,
	);

	expect(html.match(/data-settings-tab=/g)?.length).toBe(6);
	expect(html).toContain('aria-label="搜索设置"');
	expect(html).toContain("低配模式");
	expect(html).toContain("调整律动强度");
	expect(html).toContain('data-settings-rollback="one"');
});

test("设置工作台在滚动历史中展示全部四十条 rollback-to 入口", () => {
	const entries = Array.from({ length: 40 }, (_, index) => ({
		id: `entry-${index}`,
		label: `设置 ${index}`,
		changedPaths: ["intensity"],
		before: { intensity: index },
		after: { intensity: index + 1 },
		committedAt: index,
	}));
	const html = renderToStaticMarkup(
		<SettingsWorkbench
			activeTab="common"
			query=""
			history={{ busy: false, error: null, entries }}
			onTabChange={() => {}}
			onQueryChange={() => {}}
			onUndo={() => {}}
			onRollbackTo={() => {}}
			onEnableLowSpec={() => {}}
			onResetPreferences={() => {}}
		/>,
	);

	expect(html.match(/data-settings-rollback=/g)?.length).toBe(40);
	expect(html.indexOf('data-settings-rollback="entry-39"')).toBeLessThan(
		html.indexOf('data-settings-rollback="entry-0"'),
	);
});

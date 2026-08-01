import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function rustFilesUnder(path: string): string[] {
	const files: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
			} else if (entry.isFile() && entry.name.endsWith(".rs")) {
				files.push(entryPath);
			}
		}
	};
	visit(resolve(root, path));
	return files;
}

test("official distribution 的四象限决策由 build.rs 与生产代码共享", () => {
	const build = read("apps/desktop/src-tauri/build.rs");
	const distribution = read(
		"apps/desktop/src-tauri/src/app/update_distribution.rs",
	);

	expect(build).toContain('#[path = "src/app/update_distribution.rs"]');
	expect(build).toContain("classify_build_request(requested.as_deref(), &target)");
	expect(build).toContain('std::env::var("TARGET")');
	expect(build).toContain('"cargo:rustc-env={}={}"');
	expect(distribution).toContain(
		'pub(crate) const OFFICIAL_DISTRIBUTION_REQUEST: &str = "github-release-v1";',
	);
	expect(distribution).toContain(
		'pub(crate) const OFFICIAL_DISTRIBUTION_TARGET: &str = "x86_64-pc-windows-msvc";',
	);
	expect(distribution).toContain(
		'requested == Some(OFFICIAL_DISTRIBUTION_REQUEST)',
	);
	expect(distribution).toContain("target == OFFICIAL_DISTRIBUTION_TARGET");

	for (const behavior of [
		"absent_or_empty_release_request_stays_disabled",
		"near_match_release_request_stays_disabled",
		"official_request_on_any_other_target_stays_disabled",
		"exact_release_request_on_windows_x64_msvc_enables_official_distribution",
	]) {
		expect(distribution).toContain(`fn ${behavior}()`);
	}
});

test("只有 protected release 的 NSIS 构建显式请求 official distribution", () => {
	const workflow = read(".github/workflows/protected-release.yml");
	const nsisStep = workflow.match(
		/      - name: Build unsigned NSIS bundle[\s\S]*?(?=\n      - name:)/,
	)?.[0];

	expect(nsisStep).toBeDefined();
	expect(nsisStep).toContain(
		"MINERADIO_OFFICIAL_DISTRIBUTION: github-release-v1",
	);
	expect(workflow.match(/MINERADIO_OFFICIAL_DISTRIBUTION:/g)).toHaveLength(1);
});

test("运行时代码不能读取可由用户修改的 official distribution 环境变量", () => {
	const distributionPath = resolve(
		root,
		"apps/desktop/src-tauri/src/app/update_distribution.rs",
	);
	const offenders = rustFilesUnder("apps/desktop/src-tauri/src")
		.filter((file) => file !== distributionPath)
		.filter((file) =>
			readFileSync(file, "utf8").includes("MINERADIO_OFFICIAL_DISTRIBUTION"),
		)
		.map((file) => relative(root, file).replaceAll("\\", "/"));

	expect(offenders).toEqual([]);
	const distribution = read(
		"apps/desktop/src-tauri/src/app/update_distribution.rs",
	);
	expect(distribution).not.toContain("std::env::var");
	expect(distribution).toContain(
		'option_env!("MINERADIO_COMPILED_UPDATE_DISTRIBUTION")',
	);
});

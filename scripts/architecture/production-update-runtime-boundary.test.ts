import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("Rust ApplicationUpdateRuntime is the only production updater authority", () => {
	const desktop = read("apps/desktop/src-tauri/src/lib.rs");
	const owner = read("apps/desktop/src-tauri/src/app/updater_runtime.rs");
	const commands = read("apps/desktop/src-tauri/src/commands/updater.rs");
	const cargo = read("apps/desktop/src-tauri/Cargo.toml");

	for (const command of [
		"get_update_runtime_snapshot",
		"dispatch_update_runtime_intent",
		"updater_web_quiescence_acknowledge",
		"updater_web_quiescence_reconcile",
	]) expect(desktop).toContain(`commands::${command}`);
	for (const legacy of [
		"get_updater_status",
		"check_for_update",
		"install_update",
		"tauri_plugin_updater",
		"download_and_install",
	]) {
		expect(desktop).not.toContain(legacy);
		expect(commands).not.toContain(legacy);
	}
	expect(cargo).not.toContain("tauri-plugin-updater");
	expect(existsSync(resolve(root, "apps/desktop/src-tauri/src/updater.rs"))).toBe(false);

	for (const dependency of [
		"GitHubReleaseSource::new",
		"StreamingInstallerDownloader::new",
		"InstallAttemptStartupRecovery::new",
		"UpdateInstallCoordinator::new",
		"UpdateRuntime::with_production_dependencies",
	]) expect(owner).toContain(dependency);
	expect(commands).toContain("tauri::State<'_, ApplicationUpdateRuntime>");
	expect(commands).not.toContain("GitHubReleaseSource");
	expect(commands).not.toContain("StreamingInstallerDownloader");
});

test("non-official builds return disabled before constructing network dependencies", () => {
	const owner = read("apps/desktop/src-tauri/src/app/updater_runtime.rs");
	const capability = owner.indexOf("let Some(_distribution) = distribution else");
	const disabled = owner.indexOf("Self::disabled(current_version, sink)", capability);
	const source = owner.indexOf("GitHubReleaseSource::new(public_key)");

	expect(capability).toBeGreaterThan(0);
	expect(disabled).toBeGreaterThan(capability);
	expect(source).toBeGreaterThan(disabled);
	expect(owner).toContain("UpdateRuntime::disabled_without_network");
});

test("updater bootstrap failure disables only updates and cannot abort desktop setup", () => {
	const desktop = read("apps/desktop/src-tauri/src/lib.rs");
	expect(desktop).toContain("ApplicationUpdateRuntime::disabled_after_bootstrap_failure");
	expect(desktop).toContain("updater bootstrap failed; continuing with updates disabled");
	expect(desktop).not.toContain(")\n            .map_err(std::io::Error::other)?;");
});

test("production Update Runtime stays independent from Sidecar application ports", () => {
	const port = read("apps/web/src/ports/update-runtime-port.ts");
	const adapter = read("apps/web/src/adapters/tauri/tauri-update-runtime.ts");
	const owner = read("apps/desktop/src-tauri/src/app/updater_runtime.rs");

	expect(port).not.toContain("ApplicationRuntimePort");
	expect(port).not.toContain("Sidecar");
	expect(adapter).not.toContain("ApplicationRuntimePort");
	expect(adapter).not.toContain("Sidecar");
	expect(owner).not.toContain("sidecar_base_url");
	expect(owner).not.toContain("SidecarRuntime");
});

test("every update command is scoped to the main WebView", () => {
	const commands = read("apps/desktop/src-tauri/src/commands/updater.rs");
	for (const command of [
		"get_update_runtime_snapshot",
		"dispatch_update_runtime_intent",
		"updater_web_quiescence_acknowledge",
		"updater_web_quiescence_reconcile",
	]) {
		const start = commands.indexOf(`pub fn ${command}(`);
		const nextCommand = commands.indexOf("#[tauri::command]", start + 1);
		const body = commands.slice(start, nextCommand > start ? nextCommand : undefined);
		expect(start).toBeGreaterThan(0);
		expect(body).toContain("caller: tauri::WebviewWindow");
		expect(body).toContain("is_main_update_caller(caller.label())");
	}
	expect(commands).toContain("return runtime.restricted_snapshot();");
	expect(commands).toContain("return UpdateReceipt::RuntimeUnavailable;");
});

test("generation-based reconciliation closes claimed install and cache reload races", () => {
	const owner = read("apps/desktop/src-tauri/src/app/updater_runtime.rs");
	const runtime = read("apps/desktop/src-tauri/src/runtime/updater/mod.rs");

	expect(owner).toContain("struct WebReconciliationGeneration");
	expect(owner).toContain("self.web_reconciliation.request();");
	expect(owner).toContain("pending_generation()");
	expect(owner).toContain("settle_requested_web_reconciliation");
	expect(owner).toContain("UpdatePhase::RecoveringCache =>");
	expect(owner).toContain("runtime.rearm_web_reconciliation_recovery()");
	expect(owner).toContain("runtime.run_pending_cache_recovery()");
	expect(owner).toContain("runtime.run_pending_install_transaction()");
	expect(runtime).toContain("pub(crate) async fn run_pending_install_transaction");
	expect(runtime).toContain("self.snapshot().phase == UpdatePhase::PreparingInstall");
});

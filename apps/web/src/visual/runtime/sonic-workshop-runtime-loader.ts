import type { FrameContext } from "../../../../../packages/visual-engine/src/runtime/frame-context";
import {
	areSonicWorkshopSettingsEqual,
	type SonicWorkshopSettings,
} from "../../../../../packages/visual-engine/src/sonic-workshop/sonic-workshop-settings";

export interface SonicWorkshopRuntimePort {
	activate(settings: SonicWorkshopSettings): void;
	configure(settings: SonicWorkshopSettings): void;
	update(frame: FrameContext): void;
	deactivate(): void;
	dispose(): void;
	getDiagnostics(): unknown;
}

export interface SonicWorkshopModulePort {
	createSonicWorkshopRuntime(context: unknown): SonicWorkshopRuntimePort;
}

export interface SonicWorkshopRuntimeLoaderOptions {
	/** 动态 import 由 composition root 注入，未选中 Workshop 时不会调用。 */
	readonly load: () => Promise<SonicWorkshopModulePort>;
	readonly createContext: () => unknown;
	readonly registerStep: (run: (frame: FrameContext) => void) => () => void;
	readonly onError?: (error: unknown) => void;
}

export interface SonicWorkshopRuntimeLoaderState {
	readonly requested: boolean;
	readonly loading: boolean;
	readonly active: boolean;
	readonly failed: boolean;
}

export interface SonicWorkshopRuntimeLoader {
	sync(active: boolean, settings: SonicWorkshopSettings): void;
	getState(): SonicWorkshopRuntimeLoaderState;
	dispose(): void;
}

/**
 * 管理 Workshop 唯一的动态加载与生产 render lane 所有权。
 * generation 检查保证“选中后立即切走”时，迟到的 import 不会执行 factory。
 */
export function createSonicWorkshopRuntimeLoader(
	options: SonicWorkshopRuntimeLoaderOptions,
): SonicWorkshopRuntimeLoader {
	let disposed = false;
	let requested = false;
	let failed = false;
	let generation = 0;
	let desiredSettings: SonicWorkshopSettings | null = null;
	let configuredSettings: SonicWorkshopSettings | null = null;
	let runtime: SonicWorkshopRuntimePort | null = null;
	let unregisterStep: (() => void) | null = null;
	let loadPromise: Promise<void> | null = null;

	const releaseRuntime = () => {
		const off = unregisterStep;
		unregisterStep = null;
		off?.();
		const owned = runtime;
		runtime = null;
		configuredSettings = null;
		owned?.dispose();
	};

	const beginLoad = () => {
		const requestGeneration = generation;
		let currentPromise!: Promise<void>;
		currentPromise = options.load()
			.then((module) => {
				if (
					disposed ||
					!requested ||
					generation !== requestGeneration ||
					!desiredSettings
				) return;

				let created: SonicWorkshopRuntimePort | null = null;
				let off: (() => void) | null = null;
				try {
					created = module.createSonicWorkshopRuntime(options.createContext());
					if (
						disposed ||
						!requested ||
						generation !== requestGeneration ||
						!desiredSettings
					) {
						created.dispose();
						return;
					}
					off = options.registerStep((frame) => created?.update(frame));
					created.activate(desiredSettings);
					runtime = created;
					unregisterStep = off;
					configuredSettings = desiredSettings;
					failed = false;
				} catch (error) {
					off?.();
					created?.dispose();
					failed = true;
					options.onError?.(error);
				}
			})
			.catch((error) => {
				if (generation !== requestGeneration || disposed || !requested) return;
				failed = true;
				options.onError?.(error);
			})
			.finally(() => {
				if (loadPromise === currentPromise) loadPromise = null;
			});
		loadPromise = currentPromise;
	};

	return {
		sync(active, settings) {
			if (disposed) return;
			desiredSettings = settings;
			if (!active) {
				if (!requested && !runtime && !loadPromise) return;
				requested = false;
				generation += 1;
				loadPromise = null;
				failed = false;
				releaseRuntime();
				return;
			}

			if (!requested) {
				requested = true;
				generation += 1;
				failed = false;
			}
			if (runtime) {
				if (
					!configuredSettings
					|| !areSonicWorkshopSettingsEqual(configuredSettings, settings)
				) {
					runtime.configure(settings);
					configuredSettings = settings;
				}
				return;
			}
			if (!loadPromise && !failed) beginLoad();
		},
		getState() {
			return Object.freeze({
				requested,
				loading: loadPromise !== null,
				active: runtime !== null,
				failed,
			});
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			requested = false;
			generation += 1;
			loadPromise = null;
			releaseRuntime();
		},
	};
}

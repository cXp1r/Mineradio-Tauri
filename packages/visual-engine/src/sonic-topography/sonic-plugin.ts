import type { SonicTopographyPluginContext, SonicTopographyRuntime } from "./sonic-topography";
import { createSonicTopographyRuntime } from "./sonic-topography";

export const SONIC_TOPOGRAPHY_PRESET_ID = 7 as const;

export interface SonicTopographyPlugin {
	readonly id: typeof SONIC_TOPOGRAPHY_PRESET_ID;
	create(context: SonicTopographyPluginContext): SonicTopographyRuntime;
}

export function createSonicTopographyPlugin(): SonicTopographyPlugin {
	return Object.freeze({
		id: SONIC_TOPOGRAPHY_PRESET_ID,
		create: createSonicTopographyRuntime,
	});
}

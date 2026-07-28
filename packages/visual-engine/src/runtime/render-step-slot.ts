export const RenderStepSlot = {
	Beatmap: "beatmap",
	Maintenance: "maintenance",
	Ripples: "ripples",
	FloatLayer: "float-layer",
	Shelf: "shelf",
	LyricParticles: "lyric-particles",
	HomeVisual: "home-visual",
	CameraCinematic: "camera-cinematic",
	GestureRotation: "gesture-rotation",
	SkullLayer: "skull-layer",
	SonicTopography: "sonic-topography",
	StageLyrics: "stage-lyrics",
	DesktopOverlaySync: "desktop-overlay-sync",
	ThumbnailPulse: "thumbnail-pulse",
} as const;

export type RenderStepSlot = (typeof RenderStepSlot)[keyof typeof RenderStepSlot];

export const RENDER_STEP_ORDER: readonly RenderStepSlot[] = [
	RenderStepSlot.Beatmap,
	RenderStepSlot.Maintenance,
	RenderStepSlot.Ripples,
	RenderStepSlot.FloatLayer,
	RenderStepSlot.Shelf,
	RenderStepSlot.LyricParticles,
	RenderStepSlot.HomeVisual,
	RenderStepSlot.CameraCinematic,
	RenderStepSlot.GestureRotation,
	RenderStepSlot.SkullLayer,
	RenderStepSlot.SonicTopography,
	RenderStepSlot.StageLyrics,
	RenderStepSlot.DesktopOverlaySync,
	RenderStepSlot.ThumbnailPulse,
];

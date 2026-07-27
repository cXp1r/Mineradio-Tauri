export const RenderStepSlot = {
	Beatmap: "beatmap",
	Ripples: "ripples",
	FloatLayer: "float-layer",
	Shelf: "shelf",
	LyricParticles: "lyric-particles",
	HomeVisual: "home-visual",
	CameraCinematic: "camera-cinematic",
	GestureRotation: "gesture-rotation",
	SkullLayer: "skull-layer",
	StageLyrics: "stage-lyrics",
	DesktopOverlaySync: "desktop-overlay-sync",
	ThumbnailPulse: "thumbnail-pulse",
} as const;

export type RenderStepSlot = (typeof RenderStepSlot)[keyof typeof RenderStepSlot];

export const RENDER_STEP_ORDER: readonly RenderStepSlot[] = [
	RenderStepSlot.Beatmap,
	RenderStepSlot.Ripples,
	RenderStepSlot.FloatLayer,
	RenderStepSlot.Shelf,
	RenderStepSlot.LyricParticles,
	RenderStepSlot.HomeVisual,
	RenderStepSlot.CameraCinematic,
	RenderStepSlot.GestureRotation,
	RenderStepSlot.SkullLayer,
	RenderStepSlot.StageLyrics,
	RenderStepSlot.DesktopOverlaySync,
	RenderStepSlot.ThumbnailPulse,
];

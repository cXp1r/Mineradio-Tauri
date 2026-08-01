export type ShelfMode = "side" | "stage" | "off";

export type ShelfPresence = "always" | "auto";

export type ShelfPane = "mine" | "fav";

export interface ShelfState {
	centerIdx: number;
	centerTarget: number;
	centerSmooth: number;
	openCardIdx: number;
	shelfHoverCue: ShelfHoverCueState;
	pinnedOpen: boolean;
	paneMemory: { mine: number; fav: number };
	paneSwitchAt: number;
	paneSwitchDir: number;
	mode: ShelfMode;
	presence: ShelfPresence;
	appRevealed: boolean;
	lastSig: string;
	selectedIdx: number;
	pointerForegroundEligible: boolean;
	shelfPane: ShelfPane;
	collectionReveal: number;
	lastUpdate: number;
	lastCardRedrawAt: number;
	lastCardPulseBucket: number;
	shelfVisibility: number;
	shelfOpenAnimAt: number;
}

export interface ShelfHoverCueState {
	target: number;
	value: number;
	x: number;
	y: number;
	lastAt: number;
	enteredAt: number;
	zoneActive: boolean;
	guide: boolean;
}

export function createShelfState(): ShelfState {
	return {
		centerIdx: 0,
		centerTarget: 0,
		centerSmooth: 0,
		openCardIdx: -1,
		shelfHoverCue: {
			target: 0,
			value: 0,
			x: 0,
			y: 0,
			lastAt: 0,
			enteredAt: 0,
			zoneActive: false,
			guide: false,
		},
		pinnedOpen: false,
		paneMemory: { mine: 0, fav: 0 },
		paneSwitchAt: -10,
		paneSwitchDir: 1,
		mode: "side",
		presence: "always",
		appRevealed: true,
		lastSig: "",
		selectedIdx: -1,
		pointerForegroundEligible: true,
		shelfPane: "mine",
		collectionReveal: 0,
		lastUpdate: 0,
		lastCardRedrawAt: -10,
		lastCardPulseBucket: -1,
		shelfVisibility: 0,
		shelfOpenAnimAt: -10,
	};
}

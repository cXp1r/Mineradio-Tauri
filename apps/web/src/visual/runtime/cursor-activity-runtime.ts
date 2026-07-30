const CURSOR_IDLE_HIDE_DELAY_MS = 2500;
const CURSOR_HIDDEN_CLASS = "cursor-hidden";
const CURSOR_ACTIVITY_EVENTS = [
	"mousemove",
	"pointermove",
	"mousedown",
	"wheel",
	"touchstart",
] as const;

type CursorActivityEventType = (typeof CURSOR_ACTIVITY_EVENTS)[number];

export interface CursorActivitySnapshot {
	readonly hidden: boolean;
	readonly revision: number;
}

export interface CursorActivityWindow {
	addEventListener(
		type: CursorActivityEventType,
		listener: EventListener,
		options: AddEventListenerOptions,
	): void;
	removeEventListener(
		type: CursorActivityEventType,
		listener: EventListener,
		options: EventListenerOptions,
	): void;
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
}

export interface CursorActivityDocument {
	readonly hidden: boolean;
	readonly body: Pick<HTMLElement, "classList"> | null;
	addEventListener(type: "visibilitychange", listener: EventListener): void;
	removeEventListener(type: "visibilitychange", listener: EventListener): void;
}

export interface CursorActivityRuntime {
	getSnapshot(): CursorActivitySnapshot;
	subscribe(listener: () => void): () => void;
	dispose(): void;
}

export interface CreateCursorActivityRuntimeOptions {
	readonly window?: CursorActivityWindow;
	readonly document?: CursorActivityDocument;
}

export function createCursorActivityRuntime(
	options: CreateCursorActivityRuntimeOptions = {},
): CursorActivityRuntime {
	const windowTarget = options.window ?? (
		typeof window !== "undefined" ? window : undefined
	);
	const documentTarget = options.document ?? (
		typeof document !== "undefined" ? document : undefined
	);
	if (!windowTarget || !documentTarget) {
		throw new Error("Cursor activity runtime requires browser Window and Document targets.");
	}

	const activityListenerOptions: AddEventListenerOptions = {
		passive: true,
		capture: true,
	};
	const listeners = new Set<() => void>();
	let disposed = false;
	let timer: number | null = null;
	let snapshot: CursorActivitySnapshot = Object.freeze({ hidden: false, revision: 0 });

	const applyCursorClass = (hidden: boolean): void => {
		if (hidden) documentTarget.body?.classList.add(CURSOR_HIDDEN_CLASS);
		else documentTarget.body?.classList.remove(CURSOR_HIDDEN_CLASS);
	};
	const publishHidden = (hidden: boolean): void => {
		if (snapshot.hidden === hidden) {
			applyCursorClass(hidden);
			return;
		}
		snapshot = Object.freeze({ hidden, revision: snapshot.revision + 1 });
		applyCursorClass(hidden);
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// 一个消费者失败不能阻断其他视觉消费者接收边沿变化。
			}
		}
	};
	const clearHideTimer = (): void => {
		if (timer === null) return;
		windowTarget.clearTimeout(timer);
		timer = null;
	};
	const scheduleHide = (): void => {
		clearHideTimer();
		if (disposed || documentTarget.hidden) return;
		timer = windowTarget.setTimeout(() => {
			timer = null;
			if (disposed || documentTarget.hidden) return;
			publishHidden(true);
		}, CURSOR_IDLE_HIDE_DELAY_MS);
	};
	const revealAndReschedule = (): void => {
		if (disposed) return;
		publishHidden(false);
		scheduleHide();
	};
	const onActivity: EventListener = () => {
		revealAndReschedule();
	};
	const onVisibilityChange: EventListener = () => {
		if (disposed) return;
		if (documentTarget.hidden) {
			clearHideTimer();
			publishHidden(false);
			return;
		}
		revealAndReschedule();
	};

	for (const eventType of CURSOR_ACTIVITY_EVENTS) {
		windowTarget.addEventListener(eventType, onActivity, activityListenerOptions);
	}
	documentTarget.addEventListener("visibilitychange", onVisibilityChange);
	applyCursorClass(false);
	scheduleHide();

	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			if (disposed) return () => {};
			listeners.add(listener);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				listeners.delete(listener);
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearHideTimer();
			for (const eventType of CURSOR_ACTIVITY_EVENTS) {
				windowTarget.removeEventListener(eventType, onActivity, activityListenerOptions);
			}
			documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
			listeners.clear();
			if (snapshot.hidden) {
				snapshot = Object.freeze({ hidden: false, revision: snapshot.revision + 1 });
			}
			applyCursorClass(false);
		},
	};
}

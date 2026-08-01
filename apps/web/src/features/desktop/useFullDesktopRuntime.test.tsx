import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type {
	FullDesktopRuntimePort,
	FullDesktopRuntimeState,
} from "../../ports/full-desktop-runtime-port";
import {
	type FullDesktopRuntimeController,
	useFullDesktopRuntime,
} from "./useFullDesktopRuntime";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function runtimeState(
	phase: FullDesktopRuntimeState["phase"] = "disabled",
): FullDesktopRuntimeState {
	const mode = phase === "passive" || phase === "interactive" ? phase : "disabled";
	return {
		phase,
		requestedMode: mode,
		effectiveMode: mode,
		iconsVisible: true,
		interactionLocked: false,
		recoveryRequired: phase === "recoveryRequired",
		autoResumeSuppressed: false,
		explorerGeneration: 0,
	};
}

test("full desktop controller blocks conflicting mutations while native work is busy", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const mutation = deferred<FullDesktopRuntimeState>();
	const calls: string[] = [];
	const port: FullDesktopRuntimePort = {
		getRuntimeState: async () => {
			calls.push("get");
			return runtimeState();
		},
		setMode: (mode) => {
			calls.push(`mode:${mode}`);
			return mutation.promise;
		},
		setIconsVisible: async (visible) => {
			calls.push(`icons:${visible}`);
			return runtimeState();
		},
		setInteractionLocked: async () => runtimeState(),
		recover: async () => runtimeState(),
	};
	const controllerRef: { current: FullDesktopRuntimeController | null } = { current: null };

	function Harness() {
		controllerRef.current = useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});

	let modeRequest!: Promise<void>;
	await act(async () => {
		modeRequest = controllerRef.current!.setMode("passive");
		await Promise.resolve();
	});
	expect(controllerRef.current?.busy).toBe(true);
	await act(async () => {
		await controllerRef.current!.setIconsVisible(false);
		await controllerRef.current!.refresh();
	});
	expect(calls).toEqual(["get", "mode:passive"]);

	mutation.resolve(runtimeState("passive"));
	await act(async () => {
		await modeRequest;
	});
	expect(controllerRef.current?.busy).toBe(false);
	expect(controllerRef.current?.state?.effectiveMode).toBe("passive");

	await act(async () => root.unmount());
	host.remove();
});

test("full desktop controller drops a stale bootstrap response after a newer mutation", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const bootstrap = deferred<FullDesktopRuntimeState>();
	const port: FullDesktopRuntimePort = {
		getRuntimeState: () => bootstrap.promise,
		setMode: async () => runtimeState("interactive"),
		setIconsVisible: async () => runtimeState("interactive"),
		setInteractionLocked: async () => runtimeState("interactive"),
		recover: async () => runtimeState(),
	};
	const controllerRef: { current: FullDesktopRuntimeController | null } = { current: null };

	function Harness() {
		controllerRef.current = useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	await act(async () => {
		await controllerRef.current!.setMode("interactive");
	});
	expect(controllerRef.current?.state?.effectiveMode).toBe("interactive");

	bootstrap.resolve(runtimeState());
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
	expect(controllerRef.current?.state?.effectiveMode).toBe("interactive");

	await act(async () => root.unmount());
	host.remove();
});

test("full desktop controller does not commit a pending response after unmount", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const bootstrap = deferred<FullDesktopRuntimeState>();
	const port: FullDesktopRuntimePort = {
		getRuntimeState: () => bootstrap.promise,
		setMode: async () => runtimeState(),
		setIconsVisible: async () => runtimeState(),
		setInteractionLocked: async () => runtimeState(),
		recover: async () => runtimeState(),
	};
	const states: Array<FullDesktopRuntimeState | null> = [];

	function Harness() {
		states.push(useFullDesktopRuntime(port).state);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	await act(async () => root.unmount());
	const commitsBeforeResolution = states.length;

	bootstrap.resolve(runtimeState("passive"));
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(states.length).toBe(commitsBeforeResolution);
	expect(states.at(-1)).toBeNull();
	host.remove();
});

test("full desktop controller keeps the last native snapshot and surfaces mutation errors", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const port: FullDesktopRuntimePort = {
		getRuntimeState: async () => runtimeState(),
		setMode: async () => {
			throw new Error("Explorer attach denied");
		},
		setIconsVisible: async () => runtimeState(),
		setInteractionLocked: async () => runtimeState(),
		recover: async () => runtimeState(),
	};
	const controllerRef: { current: FullDesktopRuntimeController | null } = { current: null };

	function Harness() {
		controllerRef.current = useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	await act(async () => {
		await controllerRef.current!.setMode("passive");
	});

	expect(controllerRef.current?.busy).toBe(false);
	expect(controllerRef.current?.state?.effectiveMode).toBe("disabled");
	expect(controllerRef.current?.error).toBe("Explorer attach denied");

	await act(async () => root.unmount());
	host.remove();
});

test("Escape exits an active full desktop mode and owns the key event", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const calls: string[] = [];
	const port: FullDesktopRuntimePort = {
		getRuntimeState: async () => runtimeState("passive"),
		setMode: async (mode) => {
			calls.push(`mode:${mode}`);
			return runtimeState();
		},
		setIconsVisible: async () => runtimeState("passive"),
		setInteractionLocked: async () => runtimeState("passive"),
		recover: async () => runtimeState(),
	};

	function Harness() {
		useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});
	let bubbled = 0;
	const onBubble = () => {
		bubbled += 1;
	};
	document.addEventListener("keydown", onBubble);
	const event = new window.KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	await act(async () => {
		host.dispatchEvent(event);
		await Promise.resolve();
	});

	expect(calls).toEqual(["mode:disabled"]);
	expect(event.defaultPrevented).toBe(true);
	expect(bubbled).toBe(0);

	document.removeEventListener("keydown", onBubble);
	await act(async () => root.unmount());
	host.remove();
});

test("Escape runs explicit recovery when native state requires recovery", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const calls: string[] = [];
	const port: FullDesktopRuntimePort = {
		getRuntimeState: async () => runtimeState("recoveryRequired"),
		setMode: async (mode) => {
			calls.push(`mode:${mode}`);
			return runtimeState();
		},
		setIconsVisible: async () => runtimeState("recoveryRequired"),
		setInteractionLocked: async () => runtimeState("recoveryRequired"),
		recover: async () => {
			calls.push("recover");
			return runtimeState();
		},
	};

	function Harness() {
		useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});
	const event = new window.KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	await act(async () => {
		host.dispatchEvent(event);
		await Promise.resolve();
	});

	expect(calls).toEqual(["recover"]);
	expect(event.defaultPrevented).toBe(true);

	await act(async () => root.unmount());
	host.remove();
});

test("Escape inside editable controls is left to the editor", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const calls: string[] = [];
	const port: FullDesktopRuntimePort = {
		getRuntimeState: async () => runtimeState("interactive"),
		setMode: async (mode) => {
			calls.push(`mode:${mode}`);
			return runtimeState();
		},
		setIconsVisible: async () => runtimeState("interactive"),
		setInteractionLocked: async () => runtimeState("interactive"),
		recover: async () => runtimeState(),
	};

	function Harness() {
		useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});
	const input = document.createElement("input");
	const textarea = document.createElement("textarea");
	const select = document.createElement("select");
	const editable = document.createElement("div");
	const editableChild = document.createElement("span");
	editable.setAttribute("contenteditable", "true");
	editable.appendChild(editableChild);
	host.append(input, textarea, select, editable);
	for (const target of [input, textarea, select, editableChild]) {
		const event = new window.KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			target.dispatchEvent(event);
			await Promise.resolve();
		});
		expect(event.defaultPrevented).toBe(false);
	}

	expect(calls).toEqual([]);

	await act(async () => root.unmount());
	host.remove();
});

test("repeated and composing Escape events are not intercepted", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const calls: string[] = [];
	const port: FullDesktopRuntimePort = {
		getRuntimeState: async () => runtimeState("passive"),
		setMode: async (mode) => {
			calls.push(`mode:${mode}`);
			return runtimeState();
		},
		setIconsVisible: async () => runtimeState("passive"),
		setInteractionLocked: async () => runtimeState("passive"),
		recover: async () => runtimeState(),
	};

	function Harness() {
		useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});
	const repeated = new window.KeyboardEvent("keydown", {
		key: "Escape",
		repeat: true,
		bubbles: true,
		cancelable: true,
	});
	const composing = new window.KeyboardEvent("keydown", {
		key: "Escape",
		isComposing: true,
		bubbles: true,
		cancelable: true,
	});
	for (const event of [repeated, composing]) {
		await act(async () => {
			host.dispatchEvent(event);
			await Promise.resolve();
		});
		expect(event.defaultPrevented).toBe(false);
	}

	expect(calls).toEqual([]);

	await act(async () => root.unmount());
	host.remove();
});

test("Escape is untouched while full desktop is disabled", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const calls: string[] = [];
	const port: FullDesktopRuntimePort = {
		getRuntimeState: async () => runtimeState(),
		setMode: async (mode) => {
			calls.push(`mode:${mode}`);
			return runtimeState();
		},
		setIconsVisible: async () => runtimeState(),
		setInteractionLocked: async () => runtimeState(),
		recover: async () => {
			calls.push("recover");
			return runtimeState();
		},
	};

	function Harness() {
		useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});
	let bubbled = 0;
	const onBubble = () => {
		bubbled += 1;
	};
	document.addEventListener("keydown", onBubble);
	const event = new window.KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	host.dispatchEvent(event);

	expect(calls).toEqual([]);
	expect(event.defaultPrevented).toBe(false);
	expect(bubbled).toBe(1);

	document.removeEventListener("keydown", onBubble);
	await act(async () => root.unmount());
	host.remove();
});

test("full desktop Escape listener is removed on unmount", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const calls: string[] = [];
	const port: FullDesktopRuntimePort = {
		getRuntimeState: async () => runtimeState("passive"),
		setMode: async (mode) => {
			calls.push(`mode:${mode}`);
			return runtimeState();
		},
		setIconsVisible: async () => runtimeState("passive"),
		setInteractionLocked: async () => runtimeState("passive"),
		recover: async () => runtimeState(),
	};

	function Harness() {
		useFullDesktopRuntime(port);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});
	await act(async () => root.unmount());
	const event = new window.KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	host.dispatchEvent(event);

	expect(calls).toEqual([]);
	expect(event.defaultPrevented).toBe(false);
	host.remove();
});

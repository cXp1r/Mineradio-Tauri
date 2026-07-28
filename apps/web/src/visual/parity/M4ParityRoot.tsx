import { useEffect, useRef, useState } from "react";
import { createM4ParityRuntime, type M4ParityMode, type M4ParityRuntime, type M4ParityRuntimeSnapshot, type M4ParityScene } from "./m4-parity-runtime";

declare global {
	interface Window {
		__MINERADIO_M4_PARITY__?: {
			readonly buildCommit: string;
			ready: Promise<void>;
			setScene(scene: M4ParityScene): void;
			seek(positionMs: number): void;
			step(frameCount?: number, frameMs?: number): Promise<void>;
			soakShelf(): Promise<void>;
			snapshot(): M4ParityRuntimeSnapshot | null;
		};
	}
}

function readParams(): { scene: M4ParityScene; mode: M4ParityMode; seed: number } {
	const params = new URLSearchParams(window.location.search);
	const sceneValue = params.get("scene");
	const modeValue = params.get("mode");
	const seedValue = Number(params.get("seed"));
	return {
		scene: sceneValue === "sonic" || sceneValue === "shelf" ? sceneValue : "stage",
		mode: modeValue === "realtime" ? "realtime" : "deterministic",
		seed: Number.isFinite(seedValue) ? Math.round(seedValue) : 2_024_0728,
	};
}

export function M4ParityRoot() {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const runtimeRef = useRef<M4ParityRuntime | null>(null);
	const paramsRef = useRef(readParams());
	const [status, setStatus] = useState("mounting");

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let active = true;
		let resolveReady = () => {};
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		window.__MINERADIO_M4_PARITY__ = {
			buildCommit: __MINERADIO_BUILD_COMMIT__,
			ready,
			setScene(scene) { runtimeRef.current?.setScene(scene); },
			seek(positionMs) { runtimeRef.current?.seek(positionMs); },
			async step(frameCount, frameMs) { await runtimeRef.current?.step(frameCount, frameMs); },
			async soakShelf() { await runtimeRef.current?.soakShelf(); },
			snapshot() { return runtimeRef.current?.getSnapshot() ?? null; },
		};
		void createM4ParityRuntime({ host, ...paramsRef.current }).then((runtime) => {
			if (!active) {
				runtime.dispose();
				return;
			}
			runtimeRef.current = runtime;
			setStatus("ready");
			resolveReady();
		}).catch((error) => {
			setStatus(error instanceof Error ? error.message : String(error));
			resolveReady();
		});
		return () => {
			active = false;
			runtimeRef.current?.dispose();
			runtimeRef.current = null;
			delete window.__MINERADIO_M4_PARITY__;
		};
	}, []);

	return (
		<main className="m4-parity-root" data-m4-parity-status={status}>
			<div ref={hostRef} className="m4-parity-stage" aria-label="M4 visual parity stage" />
			<div className="m4-parity-badge">M4 · {paramsRef.current.scene} · {status}</div>
		</main>
	);
}

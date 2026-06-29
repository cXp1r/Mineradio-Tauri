import { expect, test } from "bun:test";
import "./happy-dom-preload";
import * as THREE from "three";
import { createCinemaCamera } from "./cinema-camera";
import { FOCUS_ZONE_ACTIVATE_DELAY_MS, FOCUS_ZONE_QUEUE_EXIT_DELAY_MS } from "./focus-zone";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import type { RuntimeUniforms } from "./uniforms";
import type { FrameContext } from "./frame-context";

function makeSnapshot(over: Partial<AudioSnapshot> = {}): AudioSnapshot {
	return {
		bass: 0,
		mid: 0,
		treble: 0,
		energy: 0,
		rb: 0,
		rm: 0,
		rt: 0,
		re: 0,
		beatPulse: 0,
		scheduledBeatPulse: 0,
		beatOnsetFlag: false,
		...over,
	};
}

function makeFakeCamera() {
	return {
		fov: 45,
		aspect: 1,
		near: 0.1,
		far: 100,
		position: {
			x: 0,
			y: 0,
			z: 6.6,
			set: function (x: number, y: number, z: number) { (this as { x: number; y: number; z: number }).x = x; (this as { x: number; y: number; z: number }).y = y; (this as { x: number; y: number; z: number }).z = z; },
		},
		rotation: { x: 0, y: 0, z: 0, order: "YXZ" },
		lookAt: () => {},
		updateProjectionMatrix: () => {},
	};
}

function makeUniforms(): RuntimeUniforms {
	return {
		uTime: { value: 0 },
		uBass: { value: 0 },
		uMid: { value: 0 },
		uTreble: { value: 0 },
		uBeat: { value: 0 },
		uEnergy: { value: 0 },
		uMouseXY: { value: { x: 0, y: 0, set: () => {} } as never },
		uMouseActive: { value: 0 },
		uVinylSpin: { value: 0 },
		uParticleDim: { value: 0 },
		uBurstAmt: { value: 0 },
	} as unknown as RuntimeUniforms;
}

function makeContext(snapshot: AudioSnapshot, dt: number, now = 0): FrameContext {
	const camera = makeFakeCamera() as never;
	const scene = { add: () => {} } as never;
	const uniforms = makeUniforms();
	return {
		dt,
		now,
		snapshot,
		uniforms,
		scene,
		camera,
		pointerParallax: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
	} as FrameContext;
}

test("updateCinemaDynamics converges cinemaDynamics.scale toward baseline non-DJ target formula", () => {
	const camera = makeFakeCamera();
	let now = 0;
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
		getCurrentTime: () => now,
	});
	const ctx = makeContext(makeSnapshot({ energy: 0.5, rb: 0.5 }), 1 / 60);
	for (let i = 0; i < 600; i++) {
		cinema.update(ctx);
		now += 1 / 60;
	}
	const state = cinema.getState();
	expect(state.cinemaDynamics.avg).toBeGreaterThan(0.20);
	expect(state.cinemaDynamics.scale).toBeGreaterThan(0.45);
	expect(state.cinemaDynamics.scale).toBeLessThan(1.20);
	cinema.dispose();
});

test("applyBeat schedules an event that produces a positive punch and reduces camera fov within tolerance", () => {
	const camera = makeFakeCamera();
	let now = 0;
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
		getCurrentTime: () => now,
	});
	cinema.applyBeat(0.85, true);
	const ctx = makeContext(makeSnapshot({ energy: 0.6, rb: 0.6 }), 1 / 60);
	now = 0.001;
	cinema.update(ctx);
	const beatCam = cinema.getState().beatCam;
	expect(beatCam.punch).toBeGreaterThan(0);
	cinema.update(ctx);
	cinema.update(ctx);
	cinema.update(ctx);
	expect(camera.fov).toBeLessThan(45);
	cinema.dispose();
});

test("paused snapshot decays beatCam kicks and punch toward zero", () => {
	const camera = makeFakeCamera();
	let now = 0;
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
		getCurrentTime: () => now,
	});
	cinema.applyBeat(0.9, true);
	now = 0.001;
	const silent = makeContext(makeSnapshot(), 1 / 60);
	for (let i = 0; i < 200; i++) {
		cinema.update(silent);
		now += 1 / 60;
	}
	const beatCam = cinema.getState().beatCam;
	expect(beatCam.punch).toBeLessThan(0.001);
	expect(beatCam.thetaKick).toBeLessThan(0.001);
	expect(beatCam.phiKick).toBeLessThan(0.001);
	expect(beatCam.radiusKick).toBeLessThan(0.001);
	expect(beatCam.rollKick).toBeLessThan(0.001);
	cinema.dispose();
});

test("camera cinematic sine drift produces a non-zero cine offset (no beat) within baseline amplitude", () => {
	const camera = makeFakeCamera();
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
	});
	const ctx = makeContext(makeSnapshot({ energy: 0.3, rb: 0.3 }), 1 / 60);
	for (let i = 0; i < 240; i++) cinema.update(ctx);
	const cine = cinema.getState().cineOffset;
	expect(Math.abs(cine.theta)).toBeLessThan(0.02);
	expect(Math.abs(cine.phi)).toBeLessThan(0.02);
	expect(Math.abs(cine.radius)).toBeLessThan(0.20);
	cinema.dispose();
});

test("setProfile toggling cinema=false freezes sine drift (cinePhi/Theta decay toward zero)", () => {
	const camera = makeFakeCamera();
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
	});
	cinema.setProfile({ cinema: false, cinemaShake: 1.0, isDj: false, trackScaleAuto: true });
	const ctx = makeContext(makeSnapshot({ energy: 0.5, rb: 0.5 }), 1 / 60);
	for (let i = 0; i < 120; i++) cinema.update(ctx);
	const cine = cinema.getState().cineOffset;
	expect(Math.abs(cine.theta)).toBeLessThan(0.0005);
	expect(Math.abs(cine.phi)).toBeLessThan(0.0005);
	expect(Math.abs(cine.radius)).toBeLessThan(0.0005);
	cinema.dispose();
});

test("setFocusZone(immediate) applies baseline shelf-side focus target and cam punch", () => {
	const camera = makeFakeCamera();
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
	});
	cinema.setFocusZone("shelf-side", { immediate: true, portrait: false });
	const state = cinema.getState();
	expect(state.orbit.focus.active).toBe(true);
	expect(state.orbit.focus.type).toBe("shelf-side");
	expect(state.orbit.focus.theta).toBe(0.42);
	expect(state.orbit.focus.phi).toBe(-0.12);
	expect(state.orbit.focus.radius).toBe(4.20);
	expect(state.orbit.focus.lookAt).toEqual({ x: 2.32, y: -0.10, z: 0.72 });
	expect(state.cameraPunch).toBe(0.82);
	cinema.dispose();
});

test("setPresetCameraBaseline applies baseline wallpaper pulse camera numbers", () => {
	const camera = makeFakeCamera();
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
	});
	cinema.setPresetCameraBaseline(5);
	const orbit = cinema.getState().orbit;
	expect(orbit.userRadius).toBe(9.4);
	expect(orbit.userPhi).toBe(0.34);
	expect(orbit.userTheta).toBe(-0.52);
	expect(orbit.baselineRadius).toBe(9.4);
	expect(orbit.baselinePhi).toBe(0.34);
	expect(orbit.baselineTheta).toBe(-0.52);
	cinema.dispose();
});

test("applySkullCameraPose moves camera toward baseline skull target vectors", () => {
	const camera = makeFakeCamera();
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
	});
	const ctx = makeContext(makeSnapshot({ energy: 0.2, rb: 0.2 }), 1);
	cinema.applySkullCameraPose(ctx, { active: true, portrait: false, shelfComposition: false, zoom: 0 });
	expect(camera.position.x).toBeCloseTo(0, 4);
	expect(camera.position.y).toBeCloseTo(-2.52, 4);
	expect(camera.position.z).toBeCloseTo(4.98, 4);
	expect(cinema.getState().skullCamera.lookAt).toEqual({ x: 0, y: -0.20, z: 0.02 });

	cinema.applySkullCameraPose(ctx, { active: true, portrait: false, shelfComposition: true, zoom: 0 });
	expect(camera.position.x).toBeCloseTo(0, 4);
	expect(camera.position.y).toBeCloseTo(-2.50, 4);
	expect(camera.position.z).toBeCloseTo(4.96, 4);
	expect(cinema.getState().skullCamera.lookAt).toEqual({ x: 0, y: -0.20, z: 0.03 });
	cinema.dispose();
});

test("setFocusZone delayed activation and queue exit timing match baseline timers", () => {
	const camera = makeFakeCamera();
	let timerNow = 0;
	const scheduled: Array<{ id: number; at: number; fn: () => void; cleared: boolean }> = [];
	const timers = {
		setTimeout(fn: () => void, delayMs: number) {
			const item = { id: scheduled.length + 1, at: timerNow + delayMs, fn, cleared: false };
			scheduled.push(item);
			return item.id;
		},
		clearTimeout(id: number) {
			const item = scheduled.find((entry) => entry.id === id);
			if (item) item.cleared = true;
		},
	};
	function advance(ms: number) {
		timerNow += ms;
		for (const item of scheduled) {
			if (!item.cleared && item.at <= timerNow) {
				item.cleared = true;
				item.fn();
			}
		}
	}
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
		focusTimers: timers,
	});
	cinema.setFocusZone("shelf-stage");
	expect(cinema.getState().orbit.focus.active).toBe(false);
	advance(FOCUS_ZONE_ACTIVATE_DELAY_MS - 1);
	expect(cinema.getState().orbit.focus.active).toBe(false);
	advance(1);
	expect(cinema.getState().orbit.focus.active).toBe(true);
	expect(cinema.getState().orbit.focus.type).toBe("shelf-stage");

	cinema.setFocusZone("queue", { immediate: true });
	expect(cinema.getState().orbit.focus.type).toBe("queue");
	cinema.setFocusZone(null);
	advance(FOCUS_ZONE_QUEUE_EXIT_DELAY_MS - 1);
	expect(cinema.getState().orbit.focus.active).toBe(true);
	advance(1);
	expect(cinema.getState().orbit.focus.active).toBe(false);
	cinema.dispose();
});

test("setFocusZone same-type immediate and layout option changes replace pending focus target", () => {
	const camera = makeFakeCamera();
	let timerNow = 0;
	const scheduled: Array<{ id: number; at: number; fn: () => void; cleared: boolean }> = [];
	const timers = {
		setTimeout(fn: () => void, delayMs: number) {
			const item = { id: scheduled.length + 1, at: timerNow + delayMs, fn, cleared: false };
			scheduled.push(item);
			return item.id;
		},
		clearTimeout(id: number) {
			const item = scheduled.find((entry) => entry.id === id);
			if (item) item.cleared = true;
		},
	};
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
		focusTimers: timers,
	});
	cinema.setFocusZone("shelf-side", { portrait: false });
	cinema.setFocusZone("shelf-side", { immediate: true, portrait: true });
	expect(cinema.getState().orbit.focus.active).toBe(true);
	expect(cinema.getState().orbit.focus.radius).toBe(5.28);
	expect(cinema.getState().orbit.focus.lookAt).toEqual({ x: 1.08, y: -0.18, z: 0.72 });
	timerNow = FOCUS_ZONE_ACTIVATE_DELAY_MS;
	for (const item of scheduled) {
		if (!item.cleared && item.at <= timerNow) {
			item.cleared = true;
			item.fn();
		}
	}
	expect(cinema.getState().orbit.focus.radius).toBe(5.28);

	cinema.setFocusZone("shelf-side", { immediate: true, portrait: true, wallpaperSafe: true });
	expect(cinema.getState().orbit.focus.radius).toBe(5.74);
	expect(cinema.getState().orbit.focus.lookAt).toEqual({ x: 1.04, y: -0.08, z: 0.78 });
	cinema.dispose();
});

test("setFocusZone is ignored after dispose and does not schedule timers", () => {
	const camera = makeFakeCamera();
	let scheduledCount = 0;
	const timers = {
		setTimeout(fn: () => void, delayMs: number) {
			void fn;
			void delayMs;
			scheduledCount += 1;
			return scheduledCount;
		},
		clearTimeout() {},
	};
	const cinema = createCinemaCamera({
		camera: camera as never,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
		focusTimers: timers,
	});
	cinema.dispose();
	cinema.setFocusZone("shelf-stage");
	expect(scheduledCount).toBe(0);
	expect(cinema.getState().orbit.focus.active).toBe(false);
});

test("focused real Three camera keeps finite position and quaternion after lookAt update", () => {
	const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
	const cinema = createCinemaCamera({
		camera,
		defaultProfile: { cinema: true, cinemaShake: 1.0, isDj: false, trackScaleAuto: true },
	});
	cinema.setFocusZone("shelf-detail", { immediate: true, portrait: false });
	const ctx = makeContext(makeSnapshot({ energy: 0.3, rb: 0.2 }), 1 / 60) as FrameContext;
	cinema.update({ ...ctx, camera: camera as never });
	expect(Number.isFinite(camera.position.x)).toBe(true);
	expect(Number.isFinite(camera.position.y)).toBe(true);
	expect(Number.isFinite(camera.position.z)).toBe(true);
	expect(Number.isFinite(camera.quaternion.x)).toBe(true);
	expect(Number.isFinite(camera.quaternion.y)).toBe(true);
	expect(Number.isFinite(camera.quaternion.z)).toBe(true);
	expect(Number.isFinite(camera.quaternion.w)).toBe(true);
	cinema.dispose();
});

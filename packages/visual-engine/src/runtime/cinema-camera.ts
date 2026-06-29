import type * as THREE from "three";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import type { FrameContext } from "./frame-context";
import {
	FOCUS_ZONE_ACTIVATE_DELAY_MS,
	FOCUS_ZONE_EXIT_DELAY_MS,
	FOCUS_ZONE_QUEUE_EXIT_DELAY_MS,
	focusTargetForZone,
	type FocusZoneOptions,
	type FocusZoneType,
} from "./focus-zone";

export interface CinemaProfile {
	cinema: boolean;
	cinemaShake: number;
	isDj: boolean;
	trackScaleAuto: boolean;
}

export interface CinemaCameraOptions {
	camera: THREE.PerspectiveCamera;
	getCurrentTime?: () => number;
	defaultProfile?: CinemaProfile;
	focusTimers?: FocusTimers;
}

export interface CinemaState {
	readonly cinemaDynamics: { avg: number; lowAvg: number; peak: number; scale: number };
	readonly cinemaTrackProfile: CinemaTrackProfile;
	readonly beatCam: BeatCamState;
	readonly orbit: OrbitState;
	readonly skullCamera: SkullCameraState;
	readonly cineOffset: { theta: number; phi: number; radius: number };
	readonly cameraPunch: number;
}

export interface CinemaTrackProfile {
	scale: number;
	target: number;
	nameHint: number;
	frames: number;
	energyAvg: number;
	lowAvg: number;
	vocalAvg: number;
	melodyAvg: number;
	punchPeak: number;
	density: number;
}

export interface BeatCamState {
	punch: number;
	thetaKick: number;
	phiKick: number;
	radiusKick: number;
	rollKick: number;
	attack: number;
	hold: number;
	release: number;
	events: BeatCameraEvent[];
}

export interface BeatCameraEvent {
	start: number;
	amp: number;
	attack: number;
	hold: number;
	release: number;
	zoomAmp: number;
	phiAmp: number;
	thetaAmp: number;
	rollAmp: number;
	combo: string;
	phase: number;
	mode: string;
	strength: number;
	mass: number;
	body: number;
	snap: number;
	dj: boolean;
}

export interface OrbitState {
	userTheta: number;
	userPhi: number;
	userRadius: number;
	cineTheta: number;
	cinePhi: number;
	cineRadius: number;
	theta: number;
	phi: number;
	radius: number;
	minPhi: number;
	maxPhi: number;
	minRadius: number;
	maxRadius: number;
	baselineTheta: number;
	baselinePhi: number;
	baselineRadius: number;
	rotating: boolean;
	centerLocked: boolean;
	focus: {
		active: boolean;
		type: FocusZoneType | null;
		theta: number;
		phi: number;
		radius: number;
		lookAt: { x: number; y: number; z: number };
	};
	lookAt: { x: number; y: number; z: number };
}

export interface SkullCameraState {
	blend: number;
	shelfMix: number;
	targetPosition: { x: number; y: number; z: number };
	lookAt: { x: number; y: number; z: number };
}

export interface SkullCameraPoseOptions {
	active: boolean;
	portrait: boolean;
	shelfComposition: boolean;
	zoom?: number;
}

export interface CinemaCamera {
	update(ctx: FrameContext): void;
	applyBeat(burst: number, isScheduled: boolean): void;
	applySkullCameraPose(ctx: FrameContext, opts: SkullCameraPoseOptions): void;
	setFocusZone(type: FocusZoneType | null, opts?: SetFocusZoneOptions): void;
	setPresetCameraBaseline(preset: number): void;
	setProfile(profile: CinemaProfile): void;
	getProfile(): CinemaProfile;
	getState(): CinemaState;
	dispose(): void;
}

export interface FocusTimers {
	setTimeout(fn: () => void, delayMs: number): unknown;
	clearTimeout(id: unknown): void;
}

export interface SetFocusZoneOptions extends FocusZoneOptions {
	immediate?: boolean;
}

const BASE_FOV = 45;
const DEFAULT_PROFILE: CinemaProfile = {
	cinema: true,
	cinemaShake: 1.0,
	isDj: false,
	trackScaleAuto: true,
};

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRange(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

function easeBeatCamera(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
}

export function createCinemaCamera(opts: CinemaCameraOptions): CinemaCamera {
	const camera = opts.camera;
	const profile: CinemaProfile = { ...(opts.defaultProfile ?? DEFAULT_PROFILE) };
	const orbit: OrbitState = {
		userTheta: 0.0,
		userPhi: 0.08,
		userRadius: 6.6,
		cineTheta: 0.0,
		cinePhi: 0.0,
		cineRadius: 0.0,
		theta: 0.0,
		phi: 0.08,
		radius: 6.6,
		minPhi: -Math.PI * 0.45,
		maxPhi: Math.PI * 0.45,
		minRadius: 2.4,
		maxRadius: 14.0,
		baselineTheta: 0.0,
		baselinePhi: 0.08,
		baselineRadius: 6.6,
		rotating: false,
		centerLocked: false,
		focus: {
			active: false,
			type: null,
			theta: 0.0,
			phi: 0.08,
			radius: 6.6,
			lookAt: { x: 0, y: 0, z: 0 },
		},
		lookAt: { x: 0, y: 0, z: 0 },
	};
	const cinemaDynamics = { avg: 0, lowAvg: 0, peak: 0.30, scale: 0.82 };
	const cinemaTrackProfile: CinemaTrackProfile = {
		scale: 1.0,
		target: 1.0,
		nameHint: 1.0,
		frames: 0,
		energyAvg: 0,
		lowAvg: 0,
		vocalAvg: 0,
		melodyAvg: 0,
		punchPeak: 0.10,
		density: 0,
	};
	const beatCam: BeatCamState = {
		punch: 0,
		thetaKick: 0,
		phiKick: 0,
		radiusKick: 0,
		rollKick: 0,
		attack: 0.028,
		hold: 0.030,
		release: 0.185,
		events: [],
	};
	const skullCamera: SkullCameraState = {
		blend: 0,
		shelfMix: 0,
		targetPosition: { x: 0, y: -2.52, z: 4.98 },
		lookAt: { x: 0, y: -0.20, z: 0.02 },
	};
	let cinemaT = 0;
	let camPunch = 0;
	let lastCamPunchAt = -10;
	const CAM_PUNCH_MIN_INTERVAL = 0.45;
	const CAM_PUNCH_BEAT_THRESHOLD = 0.55;
	let disposed = false;
	const focusTimers: FocusTimers = opts.focusTimers ?? {
		setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
		clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
	};
	let focusWantType: FocusZoneType | null = null;
	let focusWantKey = "";
	let focusPendingTimer: unknown = null;
	let focusExitTimer: unknown = null;

	function getNow(ctx: FrameContext): number {
		return opts.getCurrentTime ? opts.getCurrentTime() : ctx.now / 1000;
	}

	function updateCinemaDynamics(rawEnergy: number, rawLow: number): void {
		const e = clamp01(rawEnergy || 0);
		const l = clamp01(rawLow || 0);
		const isDj = profile.isDj;
		const composite = clamp01(e * (isDj ? 0.52 : 0.62) + l * (isDj ? 0.48 : 0.38));
		cinemaDynamics.avg += (composite - cinemaDynamics.avg) * (composite > cinemaDynamics.avg ? (isDj ? 0.018 : 0.010) : (isDj ? 0.006 : 0.004));
		cinemaDynamics.lowAvg += (l - cinemaDynamics.lowAvg) * (l > cinemaDynamics.lowAvg ? (isDj ? 0.022 : 0.012) : (isDj ? 0.007 : 0.005));
		cinemaDynamics.peak = Math.max(isDj ? 0.36 : 0.30, cinemaDynamics.peak * (isDj ? 0.9980 : 0.9988), composite);
		const floor = Math.max(0.10, cinemaDynamics.avg * 0.82);
		const span = Math.max(0.18, cinemaDynamics.peak - floor);
		let lift = clamp01((composite - floor) / span);
		lift = lift * lift * (3 - 2 * lift);
		let target = isDj
			? 0.50 + lift * 0.66 + clamp01((l - cinemaDynamics.lowAvg) / 0.30) * 0.18
			: 0.42 + lift * 0.56 + clamp01((l - cinemaDynamics.lowAvg) / 0.36) * 0.12;
		if (cinemaDynamics.avg < 0.18 && l < 0.32) target *= isDj ? 0.88 : 0.78;
		if (e > 0.48 && l > 0.46) target = Math.max(target, isDj ? 1.02 : 0.92);
		target = clampRange(target, isDj ? 0.42 : 0.34, isDj ? 1.24 : 1.08);
		cinemaDynamics.scale += (target - cinemaDynamics.scale) * (target > cinemaDynamics.scale ? (isDj ? 0.070 : 0.045) : (isDj ? 0.030 : 0.022));
	}

	function cameraDynamicsScale(extra: number): number {
		const isDj = profile.isDj;
		const djBoost = 1;
		return clampRange(
			(cinemaDynamics.scale || 0.82) * (cinemaTrackProfile.scale || 1) * (extra == null ? 1 : extra) * djBoost,
			isDj ? 0.24 : 0.18,
			isDj ? 1.42 : 1.18,
		);
	}

	function updateBeatCamera(ctx: FrameContext): void {
		const t = getNow(ctx);
		const paused = ctx.snapshot.beatPulse <= 0 && ctx.snapshot.scheduledBeatPulse <= 0 && ctx.snapshot.energy <= 0.001;
		if (paused) {
			beatCam.punch *= Math.pow(0.08, ctx.dt);
			beatCam.thetaKick *= Math.pow(0.05, ctx.dt);
			beatCam.phiKick *= Math.pow(0.05, ctx.dt);
			beatCam.radiusKick *= Math.pow(0.05, ctx.dt);
			beatCam.rollKick *= Math.pow(0.05, ctx.dt);
			beatCam.events.length = 0;
			return;
		}
		let punch = 0;
		let thetaKick = 0;
		let phiKick = 0;
		let radiusKick = 0;
		let rollKick = 0;
		let leadEvent: BeatCameraEvent | null = null;
		let leadPunch = 0;
		let leadVal = 0;
		for (let i = beatCam.events.length - 1; i >= 0; i--) {
			const ev = beatCam.events[i];
			const attack = ev.attack || beatCam.attack;
			const hold = ev.hold || beatCam.hold;
			const release = ev.release || beatCam.release;
			const local = t - ev.start;
			let val = 0;
			if (local < 0) {
				val = 0;
			} else if (local < attack) {
				val = easeBeatCamera(local / attack);
			} else if (local < attack + hold) {
				val = 1;
			} else if (local < attack + hold + release) {
				const r = (local - attack - hold) / release;
				val = 1 - easeBeatCamera(r);
			} else {
				beatCam.events.splice(i, 1);
				continue;
			}
			const evPunch = val * ev.amp;
			punch = Math.max(punch, evPunch);
			if (evPunch > leadPunch) {
				leadEvent = ev;
				leadPunch = evPunch;
				leadVal = val;
			}
		}
		if (leadEvent) {
			const sign = Math.sin(leadEvent.phase) >= 0 ? 1 : -1;
			const snapFlick = 1.0 - Math.min(1, Math.max(0, leadVal - 0.25) / 0.75);
			const combo = leadEvent.combo || "downbeat";
			if (combo === "downbeat") {
				radiusKick = leadPunch * leadEvent.zoomAmp;
				phiKick = -leadPunch * 0.0032;
			} else if (combo === "push") {
				radiusKick = leadPunch * leadEvent.zoomAmp * 0.72;
				phiKick = -leadPunch * 0.0014;
			} else if (combo === "drop") {
				radiusKick = leadPunch * leadEvent.zoomAmp * 0.46;
				phiKick = leadPunch * leadEvent.phiAmp * 0.92;
			} else if (combo === "rebound") {
				radiusKick = leadPunch * leadEvent.zoomAmp * 0.30;
				phiKick = -leadPunch * leadEvent.phiAmp * 0.22;
			} else if (leadEvent.mode === "deep") {
				radiusKick = leadPunch * leadEvent.zoomAmp;
				phiKick = -leadPunch * 0.003;
			}
			void sign;
			void snapFlick;
		}
		const djEase = profile.isDj;
		beatCam.punch += (punch - beatCam.punch) * (punch > beatCam.punch ? (djEase ? 0.82 : 0.72) : (djEase ? 0.44 : 0.38));
		beatCam.thetaKick += (thetaKick - beatCam.thetaKick) * (Math.abs(thetaKick) > Math.abs(beatCam.thetaKick) ? (djEase ? 0.80 : 0.70) : (djEase ? 0.42 : 0.36));
		beatCam.phiKick += (phiKick - beatCam.phiKick) * (Math.abs(phiKick) > Math.abs(beatCam.phiKick) ? (djEase ? 0.80 : 0.70) : (djEase ? 0.42 : 0.36));
		beatCam.radiusKick += (radiusKick - beatCam.radiusKick) * (radiusKick > beatCam.radiusKick ? (djEase ? 0.82 : 0.72) : (djEase ? 0.40 : 0.34));
		beatCam.rollKick += (rollKick - beatCam.rollKick) * (Math.abs(rollKick) > Math.abs(beatCam.rollKick) ? (djEase ? 0.82 : 0.72) : (djEase ? 0.44 : 0.38));
	}

	function updateCinema(dt: number): void {
		cinemaT += dt;
		if (!profile.cinema) {
			orbit.cineTheta *= 0.95;
			orbit.cinePhi *= 0.95;
			orbit.cineRadius *= 0.95;
			return;
		}
		const damp = orbit.rotating ? 0.25 : 1.0;
		const dj = profile.isDj;
		const shake = clampRange(Number(profile.cinemaShake) || 0, 0, 1.8);
		const beatDamp = (orbit.focus.active ? (dj ? 0.66 : 0.55) : (dj ? 1.12 : 1.0)) * shake;
		const idleDamp = damp * (dj ? 0.72 : 1.0) * shake;
		orbit.cineTheta = Math.sin(cinemaT * 0.08) * 0.012 * idleDamp + beatCam.thetaKick * beatDamp;
		orbit.cinePhi = Math.sin(cinemaT * 0.06 + 1.0) * 0.010 * idleDamp + beatCam.phiKick * beatDamp;
		orbit.cineRadius = Math.sin(cinemaT * 0.04 + 2.0) * 0.080 * idleDamp - beatCam.radiusKick * beatDamp * (dj ? 1.22 : 1.18);
	}

	function updateCamera(): void {
		const fa = orbit.focus.active;
		let targetTheta: number;
		let targetPhi: number;
		let targetRadius: number;
		let tLookAt: { x: number; y: number; z: number };
		if (fa) {
			targetTheta = orbit.focus.theta;
			targetPhi = orbit.focus.phi;
			targetRadius = orbit.focus.radius;
			tLookAt = orbit.focus.lookAt;
		} else if (orbit.centerLocked) {
			targetTheta = orbit.baselineTheta + orbit.cineTheta;
			targetPhi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.baselinePhi + orbit.cinePhi));
			targetRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.baselineRadius + orbit.cineRadius));
			tLookAt = { x: 0, y: 0, z: 0 };
		} else {
			targetTheta = orbit.userTheta + orbit.cineTheta;
			targetPhi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.userPhi + orbit.cinePhi));
			targetRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + orbit.cineRadius));
			tLookAt = { x: 0, y: 0, z: 0 };
		}
		let focusEase = fa ? 0.16 : 0.10;
		let radiusEase = fa ? 0.12 : 0.07;
		if (beatCam.punch > 0.01) {
			focusEase = Math.max(focusEase, 0.12 + beatCam.punch * 0.12);
			radiusEase = Math.max(radiusEase, 0.09 + beatCam.punch * 0.12);
		}
		orbit.theta += (targetTheta - orbit.theta) * focusEase;
		orbit.phi += (targetPhi - orbit.phi) * focusEase;
		orbit.radius += (targetRadius - orbit.radius) * radiusEase;
		orbit.lookAt.x += (tLookAt.x - orbit.lookAt.x) * focusEase;
		orbit.lookAt.y += (tLookAt.y - orbit.lookAt.y) * focusEase;
		orbit.lookAt.z += (tLookAt.z - orbit.lookAt.z) * focusEase;
		const cy = Math.cos(orbit.phi);
		const sy = Math.sin(orbit.phi);
		const ct = Math.cos(orbit.theta);
		const st = Math.sin(orbit.theta);
		camera.position.set(
			orbit.lookAt.x + orbit.radius * cy * st,
			orbit.lookAt.y + orbit.radius * sy,
			orbit.lookAt.z + orbit.radius * cy * ct,
		);
		camera.lookAt(orbit.lookAt.x, orbit.lookAt.y, orbit.lookAt.z);
		const cameraShake = clampRange(Number(profile.cinemaShake) || 0, 0, 1.8);
		camera.rotation.z += beatCam.rollKick * cameraShake;
		const cameraPunch = Math.max(camPunch * 0.55, beatCam.punch * 0.54 + beatCam.radiusKick * 0.16) * cameraShake;
		const targetFOV = BASE_FOV - cameraPunch * (profile.isDj ? 2.62 : 2.35);
		const fovEase = targetFOV < camera.fov ? 0.24 : 0.12;
		camera.fov += (targetFOV - camera.fov) * fovEase;
		camera.updateProjectionMatrix();
		camPunch *= 0.86;
	}

	function skullCameraTargetVectors(
		portrait: boolean,
		shelfComposition: boolean,
		zoom = 0,
	): { position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } } {
		if (shelfComposition) {
			return {
				position: {
					x: portrait ? -0.06 : 0,
					y: portrait ? -2.36 : -2.50,
					z: (portrait ? 4.88 : 4.96) + zoom * 0.78,
				},
				lookAt: {
					x: portrait ? -0.04 : 0,
					y: portrait ? -0.26 : -0.20,
					z: 0.03,
				},
			};
		}
		return {
			position: {
				x: 0,
				y: portrait ? -2.38 : -2.52,
				z: (portrait ? 4.92 : 4.98) + zoom,
			},
			lookAt: {
				x: 0,
				y: portrait ? -0.28 : -0.20,
				z: 0.02,
			},
		};
	}

	function applySkullCameraPose(ctx: FrameContext, pose: SkullCameraPoseOptions): void {
		if (disposed) return;
		const active = !!pose.active;
		skullCamera.blend += ((active ? 1 : 0) - skullCamera.blend) * Math.min(1, ctx.dt * (active ? 4.8 : 7.2));
		if (skullCamera.blend < 0.002) return;
		const shelfTarget = pose.shelfComposition ? 1 : 0;
		skullCamera.shelfMix += (shelfTarget - skullCamera.shelfMix) * Math.min(1, ctx.dt * (shelfTarget > skullCamera.shelfMix ? 4.6 : 5.8));
		if (Math.abs(skullCamera.shelfMix - shelfTarget) < 0.002) skullCamera.shelfMix = shelfTarget;
		const base = skullCameraTargetVectors(pose.portrait, false, pose.zoom);
		const shelf = skullCameraTargetVectors(pose.portrait, true, pose.zoom);
		const mix = skullCamera.shelfMix;
		skullCamera.targetPosition = {
			x: base.position.x + (shelf.position.x - base.position.x) * mix,
			y: base.position.y + (shelf.position.y - base.position.y) * mix,
			z: base.position.z + (shelf.position.z - base.position.z) * mix,
		};
		skullCamera.lookAt = {
			x: base.lookAt.x + (shelf.lookAt.x - base.lookAt.x) * mix,
			y: base.lookAt.y + (shelf.lookAt.y - base.lookAt.y) * mix,
			z: base.lookAt.z + (shelf.lookAt.z - base.lookAt.z) * mix,
		};
		camera.position.x += (skullCamera.targetPosition.x - camera.position.x) * skullCamera.blend;
		camera.position.y += (skullCamera.targetPosition.y - camera.position.y) * skullCamera.blend;
		camera.position.z += (skullCamera.targetPosition.z - camera.position.z) * skullCamera.blend;
		camera.lookAt(skullCamera.lookAt.x, skullCamera.lookAt.y, skullCamera.lookAt.z);
		camera.updateProjectionMatrix();
	}

	function clearFocusPendingTimer(): void {
		if (focusPendingTimer == null) return;
		focusTimers.clearTimeout(focusPendingTimer);
		focusPendingTimer = null;
	}

	function clearFocusExitTimer(): void {
		if (focusExitTimer == null) return;
		focusTimers.clearTimeout(focusExitTimer);
		focusExitTimer = null;
	}

	function activateFocusZone(type: FocusZoneType, zoneOpts: FocusZoneOptions = {}): void {
		if (disposed) return;
		const target = focusTargetForZone(type, zoneOpts);
		orbit.centerLocked = false;
		orbit.focus.active = true;
		orbit.focus.type = type;
		orbit.focus.theta = target.theta;
		orbit.focus.phi = target.phi;
		orbit.focus.radius = target.radius;
		orbit.focus.lookAt = { ...target.lookAt };
		camPunch = Math.max(camPunch, target.camPunch);
	}

	function setFocusZone(type: FocusZoneType | null, zoneOpts: SetFocusZoneOptions = {}): void {
		if (disposed) return;
		const focusKey = type
			? `${type}:${zoneOpts.portrait ? 1 : 0}:${zoneOpts.wallpaperSafe ? 1 : 0}`
			: "";
		if (focusWantType === type && focusWantKey === focusKey && !zoneOpts.immediate) return;
		focusWantType = type;
		focusWantKey = focusKey;
		clearFocusPendingTimer();
		clearFocusExitTimer();
		if (!type) {
			const exitDelay = orbit.focus.type === "queue"
				? FOCUS_ZONE_QUEUE_EXIT_DELAY_MS
				: FOCUS_ZONE_EXIT_DELAY_MS;
			focusExitTimer = focusTimers.setTimeout(() => {
				focusExitTimer = null;
				if (disposed) return;
				if (!focusWantType) orbit.focus.active = false;
			}, exitDelay);
			return;
		}
		if (zoneOpts.immediate) {
			activateFocusZone(type, zoneOpts);
			return;
		}
		focusPendingTimer = focusTimers.setTimeout(() => {
			focusPendingTimer = null;
			if (disposed) return;
			if (focusWantType !== type) return;
			if (focusWantKey !== focusKey) return;
			activateFocusZone(type, zoneOpts);
		}, FOCUS_ZONE_ACTIVATE_DELAY_MS);
	}

	function setPresetCameraBaseline(preset: number): void {
		if (disposed) return;
		const p = Math.max(0, Math.min(6, Number(preset) || 0));
		if (p === 1) {
			orbit.userRadius = 6.2;
			orbit.userPhi = 0.03;
			orbit.userTheta = 0.0;
			orbit.baselineRadius = 6.2;
			orbit.baselinePhi = 0.03;
			orbit.baselineTheta = 0.0;
		} else if (p === 2) {
			orbit.userRadius = 7.0;
			orbit.userPhi = 0.15;
			orbit.userTheta = 0.0;
			orbit.baselineRadius = 7.0;
			orbit.baselinePhi = 0.15;
			orbit.baselineTheta = 0.0;
		} else if (p === 3) {
			orbit.userRadius = 8.0;
			orbit.userPhi = 0.05;
			orbit.userTheta = 0.0;
			orbit.baselineRadius = 8.0;
			orbit.baselinePhi = 0.05;
			orbit.baselineTheta = 0.0;
		} else if (p === 4) {
			orbit.userRadius = 6.5;
			orbit.userPhi = 0.04;
			orbit.userTheta = 0.0;
			orbit.baselineRadius = 6.5;
			orbit.baselinePhi = 0.04;
			orbit.baselineTheta = 0.0;
		} else if (p === 5) {
			orbit.userRadius = 9.4;
			orbit.userPhi = 0.34;
			orbit.userTheta = -0.52;
			orbit.baselineRadius = 9.4;
			orbit.baselinePhi = 0.34;
			orbit.baselineTheta = -0.52;
		} else if (p === 6) {
			orbit.userRadius = 7.4;
			orbit.userPhi = 0.10;
			orbit.userTheta = 0.18;
			orbit.baselineRadius = 7.4;
			orbit.baselinePhi = 0.10;
			orbit.baselineTheta = 0.18;
		} else {
			orbit.userRadius = 6.6;
			orbit.userPhi = 0.08;
			orbit.userTheta = 0.0;
			orbit.baselineRadius = 6.6;
			orbit.baselinePhi = 0.08;
			orbit.baselineTheta = 0.0;
		}
	}

	function scheduleBeatCamera(time: number, burst: number, isScheduled: boolean, snapshot: AudioSnapshot): void {
		if (!profile.cinema) return;
		if (!isFinite(time)) return;
		const strength = clamp01(burst);
		const confidence = clamp01(strength);
		const isPrimary = true;
		const visualImpact = clamp01(strength);
		const isMapSource = isScheduled;
		const isLiveSource = !isScheduled;
		const livePreview = isLiveSource && snapshot.energy < 0.001;
		const dj = profile.isDj;
		const trackScale = cinemaTrackProfile.scale || 1;
		if (isMapSource && !isPrimary) return;
		if (isMapSource && visualImpact < 0.18 && strength < 0.56) return;
		if (isMapSource && confidence < 0.30 && strength < 0.68) return;
		if (trackScale < 0.58 && isMapSource && strength < 0.72 && visualImpact < 0.46) return;
		if (trackScale < 0.50 && isLiveSource && strength < (dj ? 0.58 : 0.84) && visualImpact < (dj ? 0.42 : 0.56)) return;
		const lowTone = 0.62;
		const bodyTone = 0.22;
		const snapTone = 0.16;
		const rawLowTone = lowTone;
		const rawBodyTone = bodyTone;
		const rawSnapTone = snapTone;
		const toneSum = Math.max(0.001, lowTone + bodyTone + snapTone);
		const nLow = lowTone / toneSum;
		const nBody = bodyTone / toneSum;
		const nSnap = snapTone / toneSum;
		const sharpness = nSnap;
		const mass = nLow * 0.72 + nBody * 0.36 + strength * 0.20;
		let mode = "deep";
		if (nSnap > 0.42 && nSnap > nLow * 1.18 && nSnap > nBody * 1.08) mode = "snap";
		else if (nBody > 0.46 && nBody > nLow * 1.12) mode = "body";
		void rawLowTone;
		void rawBodyTone;
		void rawSnapTone;
		let amp: number;
		if (dj) {
			amp = 0.16 + strength * 0.20 + 0.05;
		} else {
			amp = Math.max(0.18, Math.min(0.72, 0.15 + strength * 0.34 + confidence * 0.06 + mass * 0.13 + nSnap * 0.04));
		}
		if (isMapSource) amp *= 0.68 + visualImpact * 0.46;
		if (!isPrimary) amp *= 0.62;
		if (!isScheduled && !livePreview) amp *= 0.74;
		if (!isScheduled && livePreview) amp *= dj ? 0.62 : 0.78;
		if (mode === "deep" && !dj) amp = Math.min(0.62, amp * 1.12);
		const dynScale = cameraDynamicsScale(0.92 + visualImpact * 0.12 + mass * 0.08);
		amp *= dj ? clampRange(dynScale, 0.72, 1.16) : dynScale;
		const attack = Math.max(0.014, Math.min(0.038, beatCam.attack * (1.18 - sharpness * 0.55)));
		const hold = Math.max(0.014, Math.min(0.052, beatCam.hold * (0.62 + nLow * 0.55 + nBody * 0.25)));
		const release = Math.max(0.110, Math.min(0.255, beatCam.release * (0.76 + mass * 0.56 + nBody * 0.18 - sharpness * 0.18)));
		const idx = Math.floor(time * 2.7);
		let combo: string | null = null;
		if (!combo) {
			const comboSlot = Math.abs(idx) % 4;
			combo = comboSlot === 0 ? "downbeat" : comboSlot === 1 ? "push" : comboSlot === 2 ? "drop" : "rebound";
		}
		let zoomAmp = 0.070 + mass * 0.190 + (mode === "deep" ? 0.095 : 0.018) + strength * 0.045;
		let thetaAmp = 0.00035;
		let phiAmp = 0.002 + (mode === "body" ? 0.012 : mode === "snap" ? 0.005 : 0.002);
		let rollAmp = mode === "snap" ? 0.003 + nSnap * 0.004 : 0.0008;
		zoomAmp *= 0.76 + dynScale * 0.28;
		phiAmp *= 0.82 + dynScale * 0.20;
		rollAmp *= 0.78 + dynScale * 0.24;
		const phase = idx * 1.21;
		const event: BeatCameraEvent = {
			start: time,
			amp,
			attack,
			hold,
			release,
			zoomAmp,
			phiAmp,
			thetaAmp,
			rollAmp,
			combo,
			phase,
			mode,
			strength,
			mass,
			body: nBody,
			snap: nSnap,
			dj,
		};
		beatCam.events.push(event);
		cinemaTrackProfile.punchPeak = Math.max(cinemaTrackProfile.punchPeak, amp);
		if (strength > CAM_PUNCH_BEAT_THRESHOLD && time - lastCamPunchAt >= CAM_PUNCH_MIN_INTERVAL) {
			camPunch = Math.max(camPunch, 0.28);
			lastCamPunchAt = time;
		}
	}

	return {
		update(ctx) {
			if (disposed) return;
			updateCinemaDynamics(ctx.snapshot.energy, ctx.snapshot.rb);
			updateBeatCamera(ctx);
			updateCinema(ctx.dt);
			updateCamera();
		},
		applyBeat(burst, isScheduled) {
			if (disposed) return;
			const now = opts.getCurrentTime ? opts.getCurrentTime() : performance.now() / 1000;
			const snapshot: AudioSnapshot = {
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
			};
			scheduleBeatCamera(now, burst, isScheduled, snapshot);
		},
		applySkullCameraPose,
		setFocusZone,
		setPresetCameraBaseline,
		setProfile(next) {
			profile.cinema = next.cinema;
			profile.cinemaShake = next.cinemaShake;
			profile.isDj = next.isDj;
			profile.trackScaleAuto = next.trackScaleAuto;
		},
		getProfile() {
			return { ...profile };
		},
		getState() {
			return {
				cinemaDynamics,
				cinemaTrackProfile,
				beatCam,
				orbit,
				skullCamera,
				cineOffset: { theta: orbit.cineTheta, phi: orbit.cinePhi, radius: orbit.cineRadius },
				cameraPunch: camPunch,
			};
		},
		dispose() {
			disposed = true;
			clearFocusPendingTimer();
			clearFocusExitTimer();
			beatCam.events.length = 0;
		},
	};
}

export interface HomeRippleUniforms {
	uRippleTex: { value: { image?: { data?: Float32Array; width?: number; height?: number }; needsUpdate?: boolean } };
	uRippleCount: { value: number };
	uTime: { value: number };
	uBass: { value: number };
}

export interface HomeRipples {
	update(dtSeconds: number): void;
	trigger(x: number, y: number, strength: number): void;
	getData(): Float32Array;
}

export interface HomeRipplesOptions {
	random?: () => number;
}

interface RippleSlot {
	x: number;
	y: number;
	age: number;
	str: number;
}

export const RIPPLE_MAX = 12;
export const RIPPLE_PLANE_SIZE = 4.8;
const BASS_THRESHOLD = 0.30;
const RIPPLE_COOLDOWN = 0.32;

export function createHomeRipples(
	uniforms: HomeRippleUniforms,
	opts: HomeRipplesOptions = {},
): HomeRipples {
	const random = opts.random ?? Math.random;
	const data = getOrCreateRippleData(uniforms);
	const ripples: RippleSlot[] = Array.from({ length: RIPPLE_MAX }, () => ({ x: 0, y: 0, age: -10, str: 0 }));
	const regions = buildRegions();
	let rippleIdx = 0;
	let lastRippleAt = 0;
	let lastBassRising = false;

	function trigger(x: number, y: number, strength: number): void {
		const r = ripples[rippleIdx]!;
		r.x = x;
		r.y = y;
		r.age = 0;
		r.str = strength;
		rippleIdx = (rippleIdx + 1) % RIPPLE_MAX;
	}

	function update(dtSeconds: number): void {
		const bass = Number(uniforms.uBass.value) || 0;
		const isBassHit = bass > BASS_THRESHOLD && !lastBassRising;
		lastBassRising = bass > BASS_THRESHOLD * 0.75;
		const now = Number(uniforms.uTime.value) || 0;
		if (isBassHit && (now - lastRippleAt) > RIPPLE_COOLDOWN) {
			lastRippleAt = now;
			const count = 2 + (random() < 0.5 ? 0 : 1);
			const used: Record<number, boolean> = {};
			for (let k = 0; k < count; k++) {
				let idx = 0;
				let tries = 0;
				do {
					idx = Math.floor(random() * 9);
					tries += 1;
				} while (used[idx] && tries < 12);
				used[idx] = true;
				const reg = regions[idx]!;
				const jx = reg.x + (random() - 0.5) * 0.7;
				const jy = reg.y + (random() - 0.5) * 0.7;
				const str = 0.65 + bass * 1.4 + random() * 0.25;
				trigger(jx, jy, str);
			}
		}

		const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
		let active = 0;
		for (let i = 0; i < RIPPLE_MAX; i++) {
			const r = ripples[i]!;
			if (r.str > 0.005) {
				r.age += dt;
				if (r.age > 2.0) {
					r.str = 0;
					r.age = -10;
				}
			}
			const off = i * 4;
			data[off] = r.x;
			data[off + 1] = r.y;
			data[off + 2] = r.age;
			data[off + 3] = r.str;
			if (r.str > 0.005) active += 1;
		}
		uniforms.uRippleTex.value.needsUpdate = true;
		uniforms.uRippleCount.value = active;
	}

	return {
		update,
		trigger,
		getData() {
			return data;
		},
	};
}

function getOrCreateRippleData(uniforms: HomeRippleUniforms): Float32Array {
	const image = uniforms.uRippleTex.value.image;
	if (image?.data instanceof Float32Array && image.data.length >= RIPPLE_MAX * 4) {
		image.width = 1;
		image.height = RIPPLE_MAX;
		return image.data;
	}
	const data = new Float32Array(RIPPLE_MAX * 4);
	uniforms.uRippleTex.value.image = { data, width: 1, height: RIPPLE_MAX };
	return data;
}

function buildRegions(): Array<{ x: number; y: number }> {
	const regions: Array<{ x: number; y: number }> = [];
	for (let ry = 0; ry < 3; ry++) {
		for (let rx = 0; rx < 3; rx++) {
			regions.push({
				x: (rx / 2 - 0.5) * RIPPLE_PLANE_SIZE * 0.72,
				y: (ry / 2 - 0.5) * RIPPLE_PLANE_SIZE * 0.72,
			});
		}
	}
	return regions;
}

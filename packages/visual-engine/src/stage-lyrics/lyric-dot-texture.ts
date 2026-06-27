import type * as THREE from "three";
import type { ThreeModule } from "../runtime/renderer-setup";

export function makeDotTexture(THREE: ThreeModule): THREE.Texture {
	let tex: THREE.Texture;
	try {
		if (typeof document !== "undefined") {
			const cv = document.createElement("canvas");
			cv.width = 64;
			cv.height = 64;
			const c = cv.getContext("2d") as CanvasRenderingContext2D | null;
			if (c) {
				const g = c.createRadialGradient(32, 32, 0, 32, 32, 31);
				g.addColorStop(0.0, "rgba(255,255,255,0.96)");
				g.addColorStop(0.42, "rgba(255,255,255,0.78)");
				g.addColorStop(0.72, "rgba(255,255,255,0.22)");
				g.addColorStop(1.0, "rgba(255,255,255,0)");
				c.fillStyle = g as unknown as string;
				c.fillRect(0, 0, 64, 64);
			}
			if (typeof THREE.CanvasTexture === "function") {
				tex = new THREE.CanvasTexture(cv) as THREE.Texture;
			} else {
				tex = new THREE.Texture();
				(tex as unknown as { image: HTMLCanvasElement }).image = cv;
			}
		} else {
			tex = new THREE.Texture();
		}
	} catch {
		tex = new THREE.Texture();
	}
	(tex as unknown as { minFilter: number }).minFilter = THREE.LinearFilter;
	(tex as unknown as { magFilter: number }).magFilter = THREE.LinearFilter;
	return tex;
}
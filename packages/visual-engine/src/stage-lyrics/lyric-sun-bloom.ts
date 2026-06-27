import type * as THREE from "three";
import type { ThreeModule } from "../runtime/renderer-setup";

let cachedTexture: THREE.Texture | null = null;
let cachedFor: ThreeModule | null = null;

export function getLyricSunBloomTexture(THREE: ThreeModule): THREE.Texture | null {
	if (cachedTexture && cachedFor === THREE) return cachedTexture;
	if (typeof document === "undefined") {
		return null;
	}
	const canvas = document.createElement("canvas");
	canvas.width = 1024;
	canvas.height = 512;
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
	if (ctx) {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const cx = canvas.width * 0.5;
		const cy = canvas.height * 0.5;
		ctx.save();
		ctx.translate(cx, cy);
		ctx.scale(2.05, 1);
		const radial = ctx.createRadialGradient(0, 0, 0, 0, 0, canvas.height * 0.43);
		radial.addColorStop(0.0, "rgba(255,246,186,0.92)");
		radial.addColorStop(0.18, "rgba(255,219,126,0.44)");
		radial.addColorStop(0.46, "rgba(255,186,82,0.15)");
		radial.addColorStop(1.0, "rgba(255,186,82,0)");
		ctx.fillStyle = radial as unknown as string;
		ctx.fillRect(-canvas.width, -canvas.height, canvas.width * 2, canvas.height * 2);
		ctx.restore();
		ctx.save();
		ctx.globalCompositeOperation = "lighter";
		ctx.filter = "blur(34px)";
		ctx.fillStyle = "rgba(255,235,168,0.18)";
		ctx.beginPath();
		ctx.ellipse(cx, cy, canvas.width * 0.33, canvas.height * 0.14, -0.06, 0, Math.PI * 2);
		ctx.fill();
		ctx.filter = "blur(58px)";
		ctx.fillStyle = "rgba(255,214,122,0.11)";
		ctx.beginPath();
		ctx.ellipse(cx, cy, canvas.width * 0.45, canvas.height * 0.19, -0.05, 0, Math.PI * 2);
		ctx.fill();
		ctx.filter = "blur(18px)";
		const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, canvas.width * 0.16);
		core.addColorStop(0.0, "rgba(255,252,220,0.38)");
		core.addColorStop(0.34, "rgba(255,230,158,0.20)");
		core.addColorStop(1.0, "rgba(255,210,116,0)");
		ctx.fillStyle = core as unknown as string;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.restore();
		ctx.save();
		ctx.globalCompositeOperation = "destination-in";
		const xMask = ctx.createLinearGradient(0, 0, canvas.width, 0);
		xMask.addColorStop(0.0, "rgba(255,255,255,0)");
		xMask.addColorStop(0.11, "rgba(255,255,255,1)");
		xMask.addColorStop(0.89, "rgba(255,255,255,1)");
		xMask.addColorStop(1.0, "rgba(255,255,255,0)");
		ctx.fillStyle = xMask as unknown as string;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		const yMask = ctx.createLinearGradient(0, 0, 0, canvas.height);
		yMask.addColorStop(0.0, "rgba(255,255,255,0)");
		yMask.addColorStop(0.18, "rgba(255,255,255,1)");
		yMask.addColorStop(0.82, "rgba(255,255,255,1)");
		yMask.addColorStop(1.0, "rgba(255,255,255,0)");
		ctx.fillStyle = yMask as unknown as string;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.restore();
	}
	if (typeof THREE.CanvasTexture !== "function") return null;
	const tex = new THREE.CanvasTexture(canvas) as THREE.Texture;
	(tex as unknown as { minFilter: number }).minFilter = THREE.LinearFilter;
	(tex as unknown as { magFilter: number }).magFilter = THREE.LinearFilter;
	(tex as unknown as { generateMipmaps: boolean }).generateMipmaps = false;
	cachedTexture = tex;
	cachedFor = THREE;
	return tex;
}

export function resetLyricSunBloomCache(): void {
	cachedTexture = null;
	cachedFor = null;
}
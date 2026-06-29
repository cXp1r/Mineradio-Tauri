// NOTE: appends the SVG displacement-map glass filter <svg> and toggles the
// html.control-glass-svg-ok class. ResizeObserver refreshes the displacement map inputs
// as the bar width/height change. If attachment fails (SSR/test without ResizeObserver),
// no-op but DO NOT change the look — note the error.

import { createControlGlassSvg, generateControlGlassDisplacementMap, supportsControlGlassSvgFilter } from "./control-glass-svg";

export interface ControlGlassNodeOptions {
	refreshOnResize?: boolean;
}

const XLINK_NS = "http://www.w3.org/1999/xlink";

function updateMap(barEl: HTMLElement, mapImg: SVGFEImageElement): void {
	if (!barEl || !mapImg) return;
	const rect = barEl.getBoundingClientRect();
	if (rect.width < 2 || rect.height < 2) return;
	const radius = parseFloat(getComputedStyle(barEl).borderRadius) || 24;
	const href = generateControlGlassDisplacementMap(rect.width, rect.height, radius);
	mapImg.setAttribute("href", href);
	try {
		mapImg.setAttributeNS(XLINK_NS, "href", href);
	} catch {
		// ignore — some legacy browsers reject xlink href on SVGFEImageElement
	}
}

export function attachControlGlassNode(barEl: HTMLElement | null, optsGlass: ControlGlassNodeOptions = {}): () => void {
	if (typeof document === "undefined" || !barEl) {
		return () => {};
	}
	if (typeof ResizeObserver === "undefined") {
		return () => {};
	}

	let svg = document.getElementById("control-glass-svg") as SVGElement | null;
	if (!svg) {
		try {
			svg = createControlGlassSvg(document.body);
		} catch {
			return () => {};
		}
	}

	const mapImg = document.getElementById("control-glass-map") as SVGFEImageElement | null;
	if (supportsControlGlassSvgFilter()) {
		document.documentElement.classList.add("control-glass-svg-ok");
	}
	if (mapImg) updateMap(barEl, mapImg);

	let ro: ResizeObserver | null = null;
	const refresh = () => {
		if (document.getElementById("control-glass-map")) {
			const img = document.getElementById("control-glass-map") as SVGFEImageElement | null;
			if (img) updateMap(barEl, img);
		}
	};
	if (optsGlass.refreshOnResize !== false) {
		ro = new ResizeObserver(() => {
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(refresh);
			else refresh();
		});
		ro.observe(barEl);
	}

	let resizeListener: (() => void) | null = null;
	if (typeof window !== "undefined") {
		resizeListener = () => {
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(refresh);
			else refresh();
		};
		window.addEventListener("resize", resizeListener);
	}

	return () => {
		if (ro) ro.disconnect();
		ro = null;
		if (resizeListener && typeof window !== "undefined") {
			window.removeEventListener("resize", resizeListener);
			resizeListener = null;
		}
	};
}

import {
	type Color,
	type ColorStop,
	colorToRawRGBA,
	toRGBColor,
} from "../schema";
import { lerpOklab } from "./geometry/blendInterpolation";

/**
 * Sample a linear/radial gradient's ColorStop list at parameter t (0-1),
 * blending in OKLab perceptual space with each stop's midpoint bias
 * applied. Mirrors the WGSL sampleGradientStops()/remapGradientT() pair in
 * renderer/shaders/gradient{Common,Fill}.wgsl.ts — keep both in sync.
 */
export function sampleGradientColorAt(stops: ColorStop[], t: number): Color {
	if (stops.length === 0) return { type: "rgb", r: 0, g: 0, b: 0, a: 1 };
	if (stops.length === 1) return stops[0].color;

	const sorted = [...stops].sort((a, b) => a.offset - b.offset);
	const ct = Math.max(0, Math.min(1, t));

	if (ct <= sorted[0].offset) return sorted[0].color;
	const last = sorted[sorted.length - 1];
	if (ct >= last.offset) return last.color;

	for (let i = 0; i < sorted.length - 1; i++) {
		const s0 = sorted[i];
		const s1 = sorted[i + 1];
		if (ct >= s0.offset && ct <= s1.offset) {
			const range = s1.offset - s0.offset;
			const f =
				range > 0 ? remapGradientT((ct - s0.offset) / range, s0.midpoint) : 0;
			return lerpOklab(
				toRGBColor(colorToRawRGBA(s0.color)),
				toRGBColor(colorToRawRGBA(s1.color)),
				f,
			);
		}
	}

	return last.color;
}

/**
 * Photoshop-style piecewise-linear midpoint remap. `fRaw` is the raw linear
 * position within a stop segment (0-1); `midpoint` biases where the visual
 * 50% point falls. Mirrors remapGradientT() in
 * renderer/shaders/gradientCommon.wgsl.ts.
 */
export function remapGradientT(fRaw: number, midpoint: number): number {
	const mp = Math.max(0.0001, Math.min(0.9999, midpoint));
	if (fRaw < mp) return (0.5 * fRaw) / mp;
	return 0.5 + (0.5 * (fRaw - mp)) / (1 - mp);
}

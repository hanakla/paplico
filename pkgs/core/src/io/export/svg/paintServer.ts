import {
	type Color,
	type ColorStop,
	colorToRawRGBA,
	type LinearGradient,
	type RadialGradient,
	type RawRGBA,
} from "../../../schema";
import {
	oklabToRgb,
	rgbToOklab,
} from "../../../utils/geometry/blendInterpolation";
import {
	composeWorldAffine,
	formatNumber,
	type SvgCoordMapper,
	svgMatrixToString,
	type WorldAffine,
} from "./pathData";
import type { SvgDocumentBuilder, SvgNode } from "./svgBuilder";

/** Resolved SVG paint: a `fill`/`stroke` value plus its scalar opacity. */
export interface SvgPaint {
	paint: string;
	opacity: number;
}

/** Stops sampled per pair when approximating the renderer's OKLab ramp. */
const GRADIENT_SAMPLE_SEGMENTS = 8;

export function colorToSvgPaint(color: Color): SvgPaint {
	const raw = colorToRawRGBA(color);
	return { paint: rawToHex(raw), opacity: raw.a };
}

/**
 * Register a gradient def and return the referencing paint. Gradient
 * coordinates are bbox-relative with Y up (see svgImport's inverse mapping);
 * `unitToWorld` carries that unit space through the element's LOCAL bounds
 * and transform into world space — the renderer evaluates gradient uv in
 * pre-transform local space (gradientFill.wgsl), so the gradient must rotate
 * and shear with the element.
 */
export function gradientToSvgPaint(
	gradient: LinearGradient | RadialGradient,
	unitToWorld: WorldAffine,
	mapper: SvgCoordMapper,
	builder: SvgDocumentBuilder,
): SvgPaint {
	const stops = [...gradient.stops].sort((a, b) => a.offset - b.offset);
	if (stops.length === 0) return { paint: "none", opacity: 1 };
	if (stops.length === 1) return colorToSvgPaint(stops[0].color);
	const determinant =
		unitToWorld.m00 * unitToWorld.m11 - unitToWorld.m01 * unitToWorld.m10;
	if (Math.abs(determinant) < 1e-9) return colorToSvgPaint(stops[0].color);

	const stopNodes = expandStops(stops).map(
		(stop): SvgNode => ({
			tag: "stop",
			attrs: {
				offset: formatNumber(stop.offset),
				"stop-color": rawToHex(stop.color),
				...(stop.color.a < 1 ? { "stop-opacity": stop.color.a } : {}),
			},
		}),
	);

	const id = builder.allocId("grad");
	if (gradient.type === "linear") {
		builder.addDef({
			tag: "linearGradient",
			attrs: {
				id,
				gradientUnits: "userSpaceOnUse",
				x1: gradient.x1,
				y1: gradient.y1,
				x2: gradient.x2,
				y2: gradient.y2,
				gradientTransform: svgMatrixToString(mapper.composeWorld(unitToWorld)),
			},
			children: stopNodes,
		});
	} else {
		if (gradient.radiusX <= 0 || gradient.radiusY <= 0) {
			return colorToSvgPaint(stops[0].color);
		}
		// The shader rotates the ellipse in uv space, then scales by the
		// relative radii: unit circle → translate(cx, cy)·Rot(θ)·diag(rx, ry),
		// all composed under the unit→world map.
		const cos = Math.cos(gradient.rotation);
		const sin = Math.sin(gradient.rotation);
		const transform = mapper.composeWorld(
			composeWorldAffine(unitToWorld, {
				m00: cos * gradient.radiusX,
				m01: -sin * gradient.radiusY,
				m10: sin * gradient.radiusX,
				m11: cos * gradient.radiusY,
				tx: gradient.cx,
				ty: gradient.cy,
			}),
		);
		builder.addDef({
			tag: "radialGradient",
			attrs: {
				id,
				gradientUnits: "userSpaceOnUse",
				cx: 0,
				cy: 0,
				r: 1,
				gradientTransform: svgMatrixToString(transform),
			},
			children: stopNodes,
		});
	}
	return { paint: `url(#${id})`, opacity: 1 };
}

/**
 * Expand stop pairs into sampled plain stops reproducing the renderer's
 * ramp: OKLab color interpolation with the Photoshop-style midpoint remap
 * (gradientCommon.wgsl). SVG interpolates linearly in sRGB, so intermediate
 * stops pin the curve to the shader's values.
 */
function expandStops(
	stops: readonly ColorStop[],
): { offset: number; color: RawRGBA }[] {
	const result: { offset: number; color: RawRGBA }[] = [];
	for (let i = 0; i < stops.length; i++) {
		const stop = stops[i];
		const raw = colorToRawRGBA(stop.color);
		result.push({ offset: stop.offset, color: raw });

		const next = stops[i + 1];
		if (!next) continue;
		const nextRaw = colorToRawRGBA(next.color);
		const sameColor =
			raw.r === nextRaw.r && raw.g === nextRaw.g && raw.b === nextRaw.b;
		// A same-color pair with an unbiased midpoint is exactly linear in
		// both sRGB and OKLab — nothing to approximate.
		if (sameColor && stop.midpoint === 0.5) continue;

		const range = next.offset - stop.offset;
		if (range <= 0) continue;
		for (let k = 1; k < GRADIENT_SAMPLE_SEGMENTS; k++) {
			const u = k / GRADIENT_SAMPLE_SEGMENTS;
			const f = remapGradientT(u, stop.midpoint);
			result.push({
				offset: stop.offset + u * range,
				color: mixOklab(raw, nextRaw, f),
			});
		}
	}
	return result;
}

/** TS twin of gradientCommon.wgsl's remapGradientT (piecewise midpoint bias). */
function remapGradientT(fRaw: number, midpoint: number): number {
	const mp = Math.min(0.9999, Math.max(0.0001, midpoint));
	if (fRaw < mp) return (0.5 * fRaw) / mp;
	return 0.5 + (0.5 * (fRaw - mp)) / (1 - mp);
}

function mixOklab(a: RawRGBA, b: RawRGBA, f: number): RawRGBA {
	const labA = rgbToOklab({ type: "rgb", ...a });
	const labB = rgbToOklab({ type: "rgb", ...b });
	const rgb = oklabToRgb({
		L: labA.L + (labB.L - labA.L) * f,
		a: labA.a + (labB.a - labA.a) * f,
		b: labA.b + (labB.b - labA.b) * f,
		// The shader mixes alpha linearly in sRGB space, outside the OKLab
		// conversion (gradientFill.wgsl) — do the same here.
		alpha: 1,
	});
	return { r: rgb.r, g: rgb.g, b: rgb.b, a: a.a + (b.a - a.a) * f };
}

function rawToHex(raw: RawRGBA): string {
	const channel = (v: number) =>
		Math.round(Math.min(1, Math.max(0, v)) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${channel(raw.r)}${channel(raw.g)}${channel(raw.b)}`;
}

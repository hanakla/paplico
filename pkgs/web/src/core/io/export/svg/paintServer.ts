import {
	type BoundingBox,
	type Color,
	type ColorStop,
	colorToRawRGBA,
	type LinearGradient,
	type RadialGradient,
	type RawRGBA,
} from "../../../schema";
import {
	composeWorldAffine,
	formatNumber,
	type SvgCoordMapper,
	svgMatrixToString,
} from "./pathData";
import type { SvgDocumentBuilder, SvgNode } from "./svgBuilder";

/** Resolved SVG paint: a `fill`/`stroke` value plus its scalar opacity. */
export interface SvgPaint {
	paint: string;
	opacity: number;
}

export function colorToSvgPaint(color: Color): SvgPaint {
	const raw = colorToRawRGBA(color);
	return { paint: rawToHex(raw), opacity: raw.a };
}

/**
 * Register a gradient def for an element whose world bounding box is
 * `worldBounds` and return the referencing paint. Gradient coordinates are
 * bbox-relative with Y up (see svgImport's inverse mapping); they are
 * expanded to world space here and emitted as userSpaceOnUse.
 */
export function gradientToSvgPaint(
	gradient: LinearGradient | RadialGradient,
	worldBounds: BoundingBox,
	mapper: SvgCoordMapper,
	builder: SvgDocumentBuilder,
): SvgPaint {
	const stops = [...gradient.stops].sort((a, b) => a.offset - b.offset);
	if (stops.length === 0) return { paint: "none", opacity: 1 };
	if (stops.length === 1) return colorToSvgPaint(stops[0].color);
	if (worldBounds.width <= 0 || worldBounds.height <= 0) {
		return colorToSvgPaint(stops[0].color);
	}

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

	// The renderer evaluates gradients in the element's world-bbox-normalized
	// uv space (Y up) — see gradientFill.wgsl. Emitting raw unit coordinates
	// with a bbox gradientTransform reproduces that exactly, including the
	// uv-space projection of diagonal linear gradients on non-square bounds.
	const unitToWorld = {
		m00: worldBounds.width,
		m01: 0,
		m10: 0,
		m11: worldBounds.height,
		tx: worldBounds.minX,
		ty: worldBounds.minY,
	};

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
		// all composed under the bbox map.
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
 * Expand Photoshop-style stop midpoints into plain stops. A midpoint biases
 * where the blend toward the next stop reaches 50%; SVG has no equivalent,
 * so an intermediate 50/50-mixed stop is inserted at the biased position.
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
		const midpoint = stop.midpoint;
		if (midpoint === 0.5) continue;
		const clamped = Math.min(0.95, Math.max(0.05, midpoint));
		const nextRaw = colorToRawRGBA(next.color);
		result.push({
			offset: stop.offset + clamped * (next.offset - stop.offset),
			color: mixRawRGBA(raw, nextRaw),
		});
	}
	return result;
}

function mixRawRGBA(a: RawRGBA, b: RawRGBA): RawRGBA {
	return {
		r: (a.r + b.r) / 2,
		g: (a.g + b.g) / 2,
		b: (a.b + b.b) / 2,
		a: (a.a + b.a) / 2,
	};
}

function rawToHex(raw: RawRGBA): string {
	const channel = (v: number) =>
		Math.round(Math.min(1, Math.max(0, v)) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${channel(raw.r)}${channel(raw.g)}${channel(raw.b)}`;
}

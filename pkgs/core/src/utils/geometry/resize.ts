/**
 * Element resize/scale utilities
 * Pure functions for computing scaled element properties.
 */

import { readStoredBrushSize, withStoredBrushSize } from "../../brush/access";
import {
	type BoundingBox,
	type CubicBezierSegment,
	type FillAppearance,
	type FillColor,
	type Filter,
	type FilterEntry,
	type FreeGradient,
	isAppearancePresetRef,
	type LinearGradient,
	type MeshGradient,
	type RadialGradient,
	type StrokeAppearance,
	type StrokeWidthPoint,
	type TextContent,
	type TextLayout,
	type TextStyle,
} from "../../schema";
import {
	type Affine2D,
	applyAffineToPoint,
	composeAffine,
	invertAffine,
	isIdentityAffine,
} from "./repeatInterpolation";

/** Which axes a resize mirrored, as reported by the dragged resize handle. */
export type AxisFlip = { x: boolean; y: boolean };

/** Scale factors along the two axes of a space. */
export type AxisScale = { x: number; y: number };

/**
 * The affine a resize applies in the frame's space: `originalBounds` onto
 * `newBounds`. A mirrored axis gets a negative scale and maps from the far
 * edge, so the original min edge lands on the new max edge.
 */
export function createResizeAffine(
	originalBounds: BoundingBox,
	newBounds: BoundingBox,
	flip: AxisFlip = { x: false, y: false },
): Affine2D {
	const scaleX = axisScale(originalBounds.width, newBounds.width, flip.x);
	const scaleY = axisScale(originalBounds.height, newBounds.height, flip.y);
	const baseX = flip.x ? newBounds.maxX : newBounds.minX;
	const baseY = flip.y ? newBounds.maxY : newBounds.minY;
	return {
		a: scaleX,
		b: 0,
		c: 0,
		d: scaleY,
		e: baseX - originalBounds.minX * scaleX,
		f: baseY - originalBounds.minY * scaleY,
	};
}

/**
 * `map`, an affine in the space `placement` maps into, expressed in the
 * space `placement` maps from: P⁻¹ ∘ map ∘ P.
 */
export function mapWithin(map: Affine2D, placement: Affine2D): Affine2D {
	return composeAffine(invertAffine(placement), composeAffine(map, placement));
}

/**
 * How much a map stretches the unit vectors of its axes: the factors a rect
 * kind scales its sides by. A collapsed axis counts as unscaled.
 */
export function resizeAxisScale(map: Affine2D): AxisScale {
	return {
		x: Math.hypot(map.a, map.b) || 1,
		y: Math.hypot(map.c, map.d) || 1,
	};
}

/**
 * What is left of `map` once its axis scale is taken out, translation
 * included: the mirror, turn and shear a rect kind folds into its transform.
 * `map` equals this remainder composed onto the axis scale.
 */
export function resizeRemainder(map: Affine2D, scale: AxisScale): Affine2D {
	return {
		a: map.a / scale.x,
		b: map.b / scale.x,
		c: map.c / scale.y,
		d: map.d / scale.y,
		e: map.e,
		f: map.f,
	};
}

/**
 * `map`, an affine in an element's local space, expressed in the
 * bounds-relative space its gradients are stored in: out of `before`, the
 * bounds the gradients were placed in, and into `after`, the bounds they
 * are placed in once the map is baked. A flat side keeps its coordinate.
 */
export function boundsRelativeMap(
	map: Affine2D,
	before: BoundingBox,
	after: BoundingBox,
): Affine2D {
	const into = {
		a: before.width || 1,
		b: 0,
		c: 0,
		d: before.height || 1,
		e: before.minX,
		f: before.minY,
	};
	const outOf = invertAffine({
		a: after.width || 1,
		b: 0,
		c: 0,
		d: after.height || 1,
		e: after.minX,
		f: after.minY,
	});
	return composeAffine(outOf, composeAffine(map, into));
}

/**
 * Map the gradients of an appearance stack through `map`, an affine in the
 * bounds-relative space they are stored in (see boundsRelativeMap). A
 * gradient's geometry is stored relative to the element's bounds, so a map
 * that turns or mirrors the shape has to turn or mirror the gradient on its
 * own, or the fill would stay put while the shape it fills turns. Patterns
 * keep their tiling: the shader reads their scale by magnitude, so a
 * mirrored tile has nothing to ride on.
 */
export function mapGradientFilters(filters: Filter[], map: Affine2D): Filter[] {
	if (isIdentityAffine(map)) return filters;
	return filters.map((filter) => {
		if (filter.processor === "fill") {
			const fillFilter = filter as FillAppearance;
			return withParams(fillFilter, {
				fill: mapFill(fillFilter.paramData.params.fill, map),
			});
		}
		if (filter.processor === "stroke") {
			const strokeFilter = filter as StrokeAppearance;
			const { strokeColor } = strokeFilter.paramData.params;
			if (strokeColor.type !== "stroke-gradient") return filter;
			return withParams(strokeFilter, {
				strokeColor: {
					...strokeColor,
					gradient: mapLinearGradient(strokeColor.gradient, map),
				},
			});
		}
		return filter;
	});
}

/**
 * Mirror a path's width profile. Its sides are named by the travel direction,
 * which a mirror keeps, while a single-axis mirror turns the path's left into
 * its right; swapping the sides keeps the wide side on the part of the shape
 * it belonged to. A mirror on both axes is a half turn and keeps the sides.
 */
export function mirrorStrokeWidths(
	strokeWidths: StrokeWidthPoint[],
	flip: AxisFlip,
): StrokeWidthPoint[] {
	if (flip.x === flip.y) return strokeWidths;
	return strokeWidths.map(({ t, side1, side2 }) => ({
		t,
		side1: side2,
		side2: side1,
	}));
}

/**
 * Path segments mapped through an affine: the points by the whole map, the
 * control points, which are offsets from their anchors, by its linear part.
 */
export function mapSegments(
	segments: CubicBezierSegment[],
	map: Affine2D,
): CubicBezierSegment[] {
	const point = <P extends { x: number; y: number }>(p: P): P => ({
		...p,
		...applyAffineToPoint(map, p),
	});
	const vector = <V extends { x: number; y: number }>(v: V): V => ({
		...v,
		x: map.a * v.x + map.c * v.y,
		y: map.b * v.x + map.d * v.y,
	});
	return segments.map((seg) => ({
		...seg,
		start: seg.start ? point(seg.start) : undefined,
		cp1: vector(seg.cp1),
		cp2: vector(seg.cp2),
		end: point(seg.end),
	}));
}

/**
 * Scale a TextLayout's box sides. An "auto" side is pinned at `autoSize`,
 * the measured side scaled the same way.
 */
export function scaleTextLayout(
	layout: TextLayout,
	scale: AxisScale,
	autoSize: { width: number; height: number },
): TextLayout {
	return {
		...layout,
		boxWidth:
			typeof layout.boxWidth === "number"
				? layout.boxWidth * scale.x
				: autoSize.width,
		boxHeight:
			typeof layout.boxHeight === "number"
				? layout.boxHeight * scale.y
				: autoSize.height,
	};
}

/**
 * Scale a TextStyle's fontSize and strokeWidth by a uniform factor.
 */
export function scaleTextStyle(
	style: TextStyle,
	uniformScale: number,
): TextStyle {
	return {
		...style,
		fontSize: style.fontSize * uniformScale,
		strokeWidth: style.strokeWidth
			? style.strokeWidth * uniformScale
			: undefined,
	};
}

/**
 * Scale the brush size of stroke appearance filters by a uniform factor,
 * so stroke widths follow element resizes. Non-stroke filters pass through.
 */
export function scaleStrokeFilters(
	filters: FilterEntry[] | undefined,
	scale: number,
): FilterEntry[] | undefined {
	return filters?.map((f) =>
		isAppearancePresetRef(f) || f.processor !== "stroke"
			? f
			: scaleStrokeAppearance(f as StrokeAppearance, scale),
	);
}

/** The stroke with its brush size multiplied by `scale`; untouched without brush settings. */
export function scaleStrokeAppearance(
	stroke: StrokeAppearance,
	scale: number,
): StrokeAppearance {
	const params = stroke.paramData.params;
	const size = readStoredBrushSize(params.brushSettings);
	if (params.brushSettings == null || size === undefined) return stroke;
	return {
		...stroke,
		paramData: {
			...stroke.paramData,
			params: {
				...params,
				brushSettings: withStoredBrushSize(params.brushSettings, size * scale),
			},
		},
	};
}

/**
 * Scale TextContent: scale all run font sizes by uniformScale.
 */
export function scaleTextContent(
	content: TextContent,
	uniformScale: number,
): TextContent {
	return {
		...content,
		paragraphs: content.paragraphs.map((para) => ({
			...para,
			runs: para.runs.map((run) => ({
				...run,
				style: scaleTextStyle(run.style, uniformScale),
			})),
		})),
	};
}

/**
 * Scale factor for one axis. An extent of zero carries no shape to scale, and
 * dividing by it would send every coordinate to Infinity, so such an axis is
 * only translated onto the new bounds.
 */
function axisScale(
	originalSize: number,
	newSize: number,
	flipped: boolean,
): number {
	if (originalSize === 0) return 1;
	return (newSize / originalSize) * (flipped ? -1 : 1);
}

function mapFill(fill: FillColor, map: Affine2D): FillColor {
	switch (fill.type) {
		case "linear":
			return mapLinearGradient(fill, map);
		case "radial":
			return mapRadialGradient(fill, map);
		case "free":
			return mapFreeGradient(fill, map);
		case "mesh":
			return mapMeshGradient(fill, map);
		default:
			return fill;
	}
}

function mapLinearGradient(
	gradient: LinearGradient,
	map: Affine2D,
): LinearGradient {
	const start = applyAffineToPoint(map, { x: gradient.x1, y: gradient.y1 });
	const end = applyAffineToPoint(map, { x: gradient.x2, y: gradient.y2 });
	return { ...gradient, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/**
 * The ellipse is the unit circle under its axes; its image under the map is
 * the unit circle under the map times those axes, whose singular values are
 * the new radii and whose left rotation is the new turn. Of the two ways to
 * name the axes, the one closer to where the map sends the horizontal
 * radius is kept, so the radii keep their roles.
 */
function mapRadialGradient(
	gradient: RadialGradient,
	map: Affine2D,
): RadialGradient {
	const center = applyAffineToPoint(map, { x: gradient.cx, y: gradient.cy });
	const cos = Math.cos(gradient.rotation);
	const sin = Math.sin(gradient.rotation);
	const ax = gradient.radiusX * cos;
	const ay = gradient.radiusX * sin;
	const bx = -gradient.radiusY * sin;
	const by = gradient.radiusY * cos;
	const m00 = map.a * ax + map.c * ay;
	const m10 = map.b * ax + map.d * ay;
	const m01 = map.a * bx + map.c * by;
	const m11 = map.b * bx + map.d * by;
	const e = (m00 + m11) / 2;
	const f = (m00 - m11) / 2;
	const g = (m10 + m01) / 2;
	const h = (m10 - m01) / 2;
	const q = Math.hypot(e, h);
	const r = Math.hypot(f, g);
	const turn = (Math.atan2(h, e) + Math.atan2(g, f)) / 2;
	const forward = Math.atan2(m10, m00);
	const major = nearestEquivalentAngle(turn, forward, Math.PI);
	const minor = nearestEquivalentAngle(turn + Math.PI / 2, forward, Math.PI);
	const keepsMajor = Math.abs(major - forward) <= Math.abs(minor - forward);
	return {
		...gradient,
		cx: center.x,
		cy: center.y,
		radiusX: keepsMajor ? q + r : Math.abs(q - r),
		radiusY: keepsMajor ? Math.abs(q - r) : q + r,
		rotation: nearestEquivalentAngle(
			keepsMajor ? major : minor,
			gradient.rotation,
			Math.PI,
		),
	};
}

function mapFreeGradient(gradient: FreeGradient, map: Affine2D): FreeGradient {
	return {
		...gradient,
		stops: gradient.stops.map((stop) => ({
			...stop,
			...applyAffineToPoint(map, stop),
			...(stop.edgeCPs ? { edgeCPs: mapPointRecord(stop.edgeCPs, map) } : {}),
		})),
	};
}

function mapMeshGradient(gradient: MeshGradient, map: Affine2D): MeshGradient {
	return {
		...gradient,
		vertices: gradient.vertices.map((vertex) => ({
			...vertex,
			...applyAffineToPoint(map, vertex),
			handles: mapPointRecord(vertex.handles, map),
		})),
	};
}

function mapPointRecord<K extends string | number>(
	points: Record<K, { x: number; y: number }>,
	map: Affine2D,
): Record<K, { x: number; y: number }> {
	return Object.fromEntries(
		Object.entries<{ x: number; y: number }>(points).map(([key, point]) => [
			key,
			applyAffineToPoint(map, point),
		]),
	) as Record<K, { x: number; y: number }>;
}

/** `angle` shifted by whole periods to land closest to `reference`. */
function nearestEquivalentAngle(
	angle: number,
	reference: number,
	period: number,
): number {
	return angle - Math.round((angle - reference) / period) * period;
}

function withParams<T extends object>(
	filter: Filter<T>,
	params: Partial<T>,
): Filter<T> {
	return {
		...filter,
		paramData: {
			...filter.paramData,
			params: { ...filter.paramData.params, ...params },
		},
	};
}

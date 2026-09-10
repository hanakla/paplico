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
	type TextContent,
	type TextLayout,
	type TextStyle,
} from "../../schema";

interface ScaleTransform {
	scaleX: number;
	scaleY: number;
	mapX: (x: number) => number;
	mapY: (y: number) => number;
}

/** Which axes a resize mirrored, as reported by the dragged resize handle. */
export type AxisFlip = { x: boolean; y: boolean };

/**
 * Create a scale transform that maps coordinates from originalBounds to newBounds.
 * A mirrored axis gets a negative scale and maps from the far edge, so the
 * original min edge lands on the new max edge.
 */
export function createScaleTransform(
	originalBounds: BoundingBox,
	newBounds: BoundingBox,
	flip: AxisFlip = { x: false, y: false },
): ScaleTransform {
	const scaleX = axisScale(originalBounds.width, newBounds.width, flip.x);
	const scaleY = axisScale(originalBounds.height, newBounds.height, flip.y);
	const baseX = flip.x ? newBounds.maxX : newBounds.minX;
	const baseY = flip.y ? newBounds.maxY : newBounds.minY;

	return {
		scaleX,
		scaleY,
		mapX: (x: number) => baseX + (x - originalBounds.minX) * scaleX,
		mapY: (y: number) => baseY + (y - originalBounds.minY) * scaleY,
	};
}

/**
 * Mirror the gradients of an appearance stack. A gradient's geometry is stored
 * relative to the element's bounds, and a mirror leaves those bounds where they
 * were, so without this the fill would stay put while the shape it fills turns
 * over. Patterns keep their tiling: the shader reads their scale by magnitude,
 * so a mirrored tile has nothing to ride on.
 */
export function mirrorGradientFilters(
	filters: Filter[],
	flip: AxisFlip,
): Filter[] {
	if (!flip.x && !flip.y) return filters;
	return filters.map((filter) => {
		if (filter.processor === "fill") {
			const fillFilter = filter as FillAppearance;
			return withParams(fillFilter, {
				fill: mirrorFill(fillFilter.paramData.params.fill, flip),
			});
		}
		if (filter.processor === "stroke") {
			const strokeFilter = filter as StrokeAppearance;
			const { strokeColor } = strokeFilter.paramData.params;
			if (strokeColor.type !== "stroke-gradient") return filter;
			return withParams(strokeFilter, {
				strokeColor: {
					...strokeColor,
					gradient: mirrorLinearGradient(strokeColor.gradient, flip),
				},
			});
		}
		return filter;
	});
}

/**
 * Scale path segments from originalBounds to newBounds.
 */
export function scaleSegments(
	segments: CubicBezierSegment[],
	transform: ScaleTransform,
): CubicBezierSegment[] {
	const { mapX, mapY, scaleX, scaleY } = transform;
	return segments.map((seg) => ({
		...seg,
		start: seg.start
			? { ...seg.start, x: mapX(seg.start.x), y: mapY(seg.start.y) }
			: undefined,
		// cp1/cp2 are relative offsets (vectors), not positions.
		// Only scale component applies; translation must not be added.
		cp1: { ...seg.cp1, x: seg.cp1.x * scaleX, y: seg.cp1.y * scaleY },
		cp2: { ...seg.cp2, x: seg.cp2.x * scaleX, y: seg.cp2.y * scaleY },
		end: { ...seg.end, x: mapX(seg.end.x), y: mapY(seg.end.y) },
	}));
}

/**
 * Scale a TextLayout's boxWidth/boxHeight.
 */
export function scaleTextLayout(
	layout: TextLayout,
	transform: ScaleTransform,
	newBounds: BoundingBox,
): TextLayout {
	const newLayout = { ...layout };
	// A mirror carries a negative scale, but the box itself stays positive.
	if (typeof newLayout.boxWidth === "number") {
		newLayout.boxWidth = newLayout.boxWidth * Math.abs(transform.scaleX);
	} else {
		newLayout.boxWidth = newBounds.width;
	}
	if (typeof newLayout.boxHeight === "number") {
		newLayout.boxHeight = newLayout.boxHeight * Math.abs(transform.scaleY);
	} else {
		newLayout.boxHeight = newBounds.height;
	}
	return newLayout;
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
	return filters?.map((f) => {
		if (isAppearancePresetRef(f) || f.processor !== "stroke") return f;
		const params = (f as StrokeAppearance).paramData.params;
		const size = readStoredBrushSize(params.brushSettings);
		if (params.brushSettings == null || size === undefined) return f;
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...params,
					brushSettings: withStoredBrushSize(
						params.brushSettings,
						size * scale,
					),
				},
			},
		};
	});
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

function mirrorFill(fill: FillColor, flip: AxisFlip): FillColor {
	switch (fill.type) {
		case "linear":
			return mirrorLinearGradient(fill, flip);
		case "radial":
			return mirrorRadialGradient(fill, flip);
		case "free":
			return mirrorFreeGradient(fill, flip);
		case "mesh":
			return mirrorMeshGradient(fill, flip);
		default:
			return fill;
	}
}

function mirrorLinearGradient(
	gradient: LinearGradient,
	flip: AxisFlip,
): LinearGradient {
	const start = mirrorPoint({ x: gradient.x1, y: gradient.y1 }, flip);
	const end = mirrorPoint({ x: gradient.x2, y: gradient.y2 }, flip);
	return { ...gradient, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/**
 * The radii are lengths and survive a mirror. The rotation does not: mirroring
 * one axis turns the ellipse the other way, while mirroring both is a half
 * turn, which leaves it as it was.
 */
function mirrorRadialGradient(
	gradient: RadialGradient,
	flip: AxisFlip,
): RadialGradient {
	const center = mirrorPoint({ x: gradient.cx, y: gradient.cy }, flip);
	return {
		...gradient,
		cx: center.x,
		cy: center.y,
		rotation: flip.x !== flip.y ? -gradient.rotation : gradient.rotation,
	};
}

function mirrorFreeGradient(
	gradient: FreeGradient,
	flip: AxisFlip,
): FreeGradient {
	return {
		...gradient,
		stops: gradient.stops.map((stop) => ({
			...stop,
			...mirrorPoint(stop, flip),
			...(stop.edgeCPs
				? { edgeCPs: mirrorPointRecord(stop.edgeCPs, flip) }
				: {}),
		})),
	};
}

function mirrorMeshGradient(
	gradient: MeshGradient,
	flip: AxisFlip,
): MeshGradient {
	return {
		...gradient,
		vertices: gradient.vertices.map((vertex) => ({
			...vertex,
			...mirrorPoint(vertex, flip),
			handles: mirrorPointRecord(vertex.handles, flip),
		})),
	};
}

function mirrorPointRecord<K extends string | number>(
	points: Record<K, { x: number; y: number }>,
	flip: AxisFlip,
): Record<K, { x: number; y: number }> {
	return Object.fromEntries(
		Object.entries<{ x: number; y: number }>(points).map(([key, point]) => [
			key,
			mirrorPoint(point, flip),
		]),
	) as Record<K, { x: number; y: number }>;
}

/** Mirror one bounds-relative point, where 0 and 1 are the opposite edges. */
function mirrorPoint(
	point: { x: number; y: number },
	flip: AxisFlip,
): { x: number; y: number } {
	return {
		x: flip.x ? 1 - point.x : point.x,
		y: flip.y ? 1 - point.y : point.y,
	};
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

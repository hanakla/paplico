/**
 * Element resize/scale utilities
 * Pure functions for computing scaled element properties.
 */

import { readStoredBrushSize, withStoredBrushSize } from "../../brush/access";
import {
	type BoundingBox,
	type CubicBezierSegment,
	type FilterEntry,
	isAppearancePresetRef,
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

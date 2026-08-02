import type { TextGlyphQuad } from "../../../typography/glyphQuad";
import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import { rectGeom } from "./shared";

/**
 * Touch-type (per-char adjust) overlay: one rotated quad per selected glyph
 * plus a single handle set on the combined AABB — corner rects scale, the
 * circle above rotates. Deltas apply uniformly to every selected char, so one
 * handle set is enough; the quads show which chars are targeted and their
 * current rotation.
 */

/** hitId prefix; suffixes: `char:<contentIndex>` | `rotate` | `skew` | `scale:<pos>` */
export const TEXT_CHAR_TOUCH_HIT_PREFIX = "char-touch:";

/** Screen distance from the AABB top edge to the rotation handle */
const ROTATION_HANDLE_OFFSET_PX = 24;
/** Screen x-offset of the skew handle, placing it just right of the rotation handle */
const SKEW_HANDLE_OFFSET_PX = 22;
/** Half-length of the "/" skew icon (screen px) */
const SKEW_ICON_HALF_LEN_PX = 6;
/** Thickness of the "/" skew icon (screen px) */
const SKEW_ICON_THICKNESS_PX = 3;

export interface TextCharTouchOverlayData {
	/** World-space quads of the selected glyphs */
	quads: readonly TextGlyphQuad[];
	/** World-space AABB spanning all selected quads */
	combinedBounds: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	};
}

export function buildTextCharTouchOverlay(
	data: TextCharTouchOverlayData,
	theme: UITheme,
	zoom: number,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const sw = theme.strokeWidth.default;
	const accent = theme.colors.selectionBounds;

	for (const quad of data.quads) {
		prims.push({
			kind: "polyline",
			points: quad.corners,
			closed: true,
			// The translucent face makes the whole glyph area draggable
			// (filled closed polylines hit-test across their interior)
			fill: { color: theme.colors.charTouchQuadFill },
			stroke: { color: accent, width: sw },
			hitId: `${TEXT_CHAR_TOUCH_HIT_PREFIX}char:${quad.charIndex}`,
			hitPadding: { screen: 4 },
		});
	}

	if (data.quads.length === 0) return prims;

	const { minX, minY, maxX, maxY } = data.combinedBounds;
	prims.push({
		kind: "rect",
		...rectGeom(minX, minY, maxX, maxY),
		stroke: { color: accent, width: sw },
	});

	// Scale handles on the AABB corners
	const sizePx = theme.handleSize.selection;
	const cornerHandles = [
		{ pos: "nw", x: minX, y: maxY },
		{ pos: "ne", x: maxX, y: maxY },
		{ pos: "se", x: maxX, y: minY },
		{ pos: "sw", x: minX, y: minY },
	] as const;
	for (const handle of cornerHandles) {
		prims.push({
			kind: "rect",
			cx: handle.x,
			cy: handle.y,
			width: { screen: sizePx },
			height: { screen: sizePx },
			fill: { color: theme.colors.white },
			stroke: { color: accent, width: sw },
			hitId: `${TEXT_CHAR_TOUCH_HIT_PREFIX}scale:${handle.pos}`,
			hitPadding: { screen: 4 },
		});
	}

	// Rotation handle above the top edge (screen-constant offset)
	const topCenterX = (minX + maxX) / 2;
	prims.push({
		kind: "circle",
		cx: topCenterX,
		cy: maxY,
		radius: { screen: sizePx / 2 },
		screenOffset: { x: 0, y: ROTATION_HANDLE_OFFSET_PX },
		fill: { color: theme.colors.white },
		stroke: { color: accent, width: sw },
		hitId: `${TEXT_CHAR_TOUCH_HIT_PREFIX}rotate`,
		hitPadding: { screen: 6 },
	});

	// Skew handle: a thick "/" just right of the rotation handle. Endpoints are
	// screen-constant (halfLen / zoom) around a shared anchor; screenOffset then
	// parks the whole icon at the handle spot.
	const half = SKEW_ICON_HALF_LEN_PX / zoom;
	prims.push({
		kind: "line",
		x1: topCenterX - half,
		y1: maxY - half,
		x2: topCenterX + half,
		y2: maxY + half,
		screenOffset: { x: SKEW_HANDLE_OFFSET_PX, y: ROTATION_HANDLE_OFFSET_PX },
		fill: { color: accent, width: { screen: SKEW_ICON_THICKNESS_PX } },
		hitId: `${TEXT_CHAR_TOUCH_HIT_PREFIX}skew`,
		hitPadding: { screen: 10 },
	});

	return prims;
}

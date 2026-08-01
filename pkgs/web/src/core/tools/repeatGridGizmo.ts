import type {
	CirclePrimitive,
	LinePrimitive,
	PolylinePrimitive,
	RectPrimitive,
	UIPrimitive,
} from "../renderer/ui/primitives";
import { UI_THEME } from "../renderer/ui/theme";
import type { BoundingBox, RepeatObject } from "../schema";
import {
	type Affine2D,
	applyAffineToPoint,
} from "../utils/geometry/repeatInterpolation";

/** A point on the radial ring at `angle` (0 = up), in the source authored space
 *  before the repeat transform. Matches radialInstances' placement. */
function radialRingPoint(
	center: { x: number; y: number },
	radius: number,
	angle: number,
): { x: number; y: number } {
	return {
		x: center.x + radius * Math.sin(angle),
		y: center.y - radius * Math.cos(angle),
	};
}

/** Screen-space diagonal offset of the region-resize handle past the box's
 *  bottom-right corner (clear of the corner scale handle). */
const REGION_OFFSET_SCREEN = 22;
/** Screen-space half-size of the square region-resize handle. */
const REGION_HALF_SCREEN = 6;
/** Fraction along the edge (from the corner) where a spacing handle sits — on
 *  the edge but off the midpoint, clearing the corner / edge-midpoint resize
 *  handles (and the rotation handle above the top edge). */
const SPACING_EDGE_FRACTION = 0.25;
/** Screen-space radius of the round spacing handles. */
const SPACING_RADIUS_SCREEN = 9;

/**
 * Handles for a grid Repeat, distinguished by FORM (not color). The selection
 * box already outlines the fill region (grid bounds == the clipped region), so:
 *   - fill region: a rounded-square resize handle just past the box's
 *     bottom-right corner. Copies are clipped to the region, so dragging it fills
 *     a range continuously (the count reflows), never stepping per copy.
 *   - spacing: a round handle with a double chevron showing the drag direction
 *     (`<>` column gap on the TOP edge, `^v` row gap on the LEFT edge).
 * The box's own resize handles keep scaling the whole repeat.
 */
export function buildRepeatGridGizmo(
	bounds: BoundingBox,
	zoom: number,
): UIPrimitive[] {
	const z = Math.max(zoom, 1e-3);
	const regionOff = REGION_OFFSET_SCREEN / z;
	const spacingBarX = bounds.minX + bounds.width * SPACING_EDGE_FRACTION;
	const spacingBarY = bounds.maxY - bounds.height * SPACING_EDGE_FRACTION;
	// World is Y-up: the box's bottom-right corner is (maxX, minY).
	const rx = bounds.maxX + regionOff;
	const ry = bounds.minY - regionOff;
	return [
		...regionHandle(rx, ry, z),
		// Spacing on the top / left edges: column gap (horizontal `<>`), row gap
		// (vertical `^v`).
		...spacingHandle(
			"grid-spacing-x",
			spacingBarX,
			bounds.maxY,
			"horizontal",
			z,
		),
		...spacingHandle("grid-spacing-y", bounds.minX, spacingBarY, "vertical", z),
	];
}

/**
 * Radial gizmo: a ring through the copies plus three handles —
 *   - `radial-radius`: the first copy; drag it around/in-out to set the radius
 *     and the start angle.
 *   - `radial-sweep`: the last copy; drag it around the ring to set the sweep.
 *   - `radial-count`: at the center; drag horizontally to add / remove copies.
 * All are drawn in world space (the source authored ring transformed by the
 * repeat's own transform).
 */
export function buildRepeatRadialGizmo(
	repeat: RepeatObject,
	center: { x: number; y: number },
	affine: Affine2D,
	zoom: number,
): UIPrimitive[] {
	const { radius, startAngle, sweep, count } = repeat.radial;
	const pt = (angle: number) =>
		applyAffineToPoint(affine, radialRingPoint(center, radius, angle));

	const SAMPLES = 48;
	const ring: { x: number; y: number }[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		ring.push(pt((Math.PI * 2 * i) / SAMPLES));
	}

	const n = Math.max(1, Math.floor(count));
	const isFull = Math.abs(sweep) >= Math.PI * 2 - 1e-6;
	const lastAngle =
		startAngle + (n > 1 ? (isFull ? (Math.PI * 2 * (n - 1)) / n : sweep) : 0);
	const pivot = applyAffineToPoint(affine, center);
	const first = pt(startAngle);
	const last = pt(lastAngle);

	return [
		{
			kind: "polyline",
			points: ring,
			closed: true,
			stroke: { color: UI_THEME.colors.selectionBounds, width: 1 },
		},
		line(pivot, first),
		circleHandle("radial-radius", first.x, first.y),
		circleHandle("radial-sweep", last.x, last.y),
		squareHandle("radial-count", pivot.x, pivot.y),
	];
}

function line(
	a: { x: number; y: number },
	b: { x: number; y: number },
): LinePrimitive {
	return {
		kind: "line",
		x1: a.x,
		y1: a.y,
		x2: b.x,
		y2: b.y,
		stroke: { color: UI_THEME.colors.selectionBounds, width: 1 },
	};
}

function circleHandle(id: string, cx: number, cy: number): CirclePrimitive {
	return {
		kind: "circle",
		cx,
		cy,
		radius: { screen: SPACING_RADIUS_SCREEN },
		fill: { color: UI_THEME.colors.white },
		stroke: { color: UI_THEME.colors.selectionBounds, width: 1.5 },
		hitId: id,
	};
}

function squareHandle(id: string, cx: number, cy: number): RectPrimitive {
	return {
		kind: "rect",
		cx,
		cy,
		width: { screen: REGION_HALF_SCREEN * 2 },
		height: { screen: REGION_HALF_SCREEN * 2 },
		cornerRadius: { screen: 2.5 },
		fill: { color: UI_THEME.colors.white },
		stroke: { color: UI_THEME.colors.selectionBounds, width: 1.5 },
		hitId: id,
	};
}

/** Rounded square + a diagonal double-arrow hint, for resizing the fill region. */
function regionHandle(cx: number, cy: number, zoom: number): UIPrimitive[] {
	const half = REGION_HALF_SCREEN / zoom;
	const a = half * 0.7; // arrow reach
	const head = half * 0.32;
	const square: RectPrimitive = {
		kind: "rect",
		cx,
		cy,
		width: { screen: REGION_HALF_SCREEN * 2 },
		height: { screen: REGION_HALF_SCREEN * 2 },
		cornerRadius: { screen: 2.5 },
		fill: { color: UI_THEME.colors.white },
		stroke: { color: UI_THEME.colors.selectionBounds, width: 1.5 },
		hitId: "grid-region",
	};
	// Diagonal ↙↗ line with arrowheads, hinting "drag to resize the region".
	const shaft = stroke([
		{ x: cx - a, y: cy - a },
		{ x: cx + a, y: cy + a },
	]);
	const headTR = stroke([
		{ x: cx + a - head, y: cy + a },
		{ x: cx + a, y: cy + a },
		{ x: cx + a, y: cy + a - head },
	]);
	const headBL = stroke([
		{ x: cx - a + head, y: cy - a },
		{ x: cx - a, y: cy - a },
		{ x: cx - a, y: cy - a + head },
	]);
	return [square, shaft, headTR, headBL];
}

/**
 * A round handle carrying a double chevron pointing along the drag axis. The
 * circle is the hit target; the two chevrons are decorative strokes on top.
 */
function spacingHandle(
	id: string,
	cx: number,
	cy: number,
	orientation: "horizontal" | "vertical",
	zoom: number,
): UIPrimitive[] {
	const off = 4.5 / zoom; // chevron distance from center
	const aw = 3 / zoom; // arm length toward center
	const ah = 3.5 / zoom; // arm half-height
	const circle: CirclePrimitive = {
		kind: "circle",
		cx,
		cy,
		radius: { screen: SPACING_RADIUS_SCREEN },
		fill: { color: UI_THEME.colors.white },
		stroke: { color: UI_THEME.colors.selectionBounds, width: 1.5 },
		hitId: id,
	};
	const chevrons =
		orientation === "horizontal"
			? [
					stroke([
						{ x: cx - off + aw, y: cy + ah },
						{ x: cx - off, y: cy },
						{ x: cx - off + aw, y: cy - ah },
					]),
					stroke([
						{ x: cx + off - aw, y: cy + ah },
						{ x: cx + off, y: cy },
						{ x: cx + off - aw, y: cy - ah },
					]),
				]
			: [
					stroke([
						{ x: cx - ah, y: cy + off - aw },
						{ x: cx, y: cy + off },
						{ x: cx + ah, y: cy + off - aw },
					]),
					stroke([
						{ x: cx - ah, y: cy - off + aw },
						{ x: cx, y: cy - off },
						{ x: cx + ah, y: cy - off + aw },
					]),
				];
	return [circle, ...chevrons];
}

function stroke(points: Array<{ x: number; y: number }>): PolylinePrimitive {
	return {
		kind: "polyline",
		points,
		stroke: { color: UI_THEME.colors.selectionBounds, width: 1.5 },
	};
}

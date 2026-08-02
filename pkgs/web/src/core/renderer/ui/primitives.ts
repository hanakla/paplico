import type { RGBA } from "./theme";

/**
 * Declarative UI overlay primitives.
 *
 * Builders (renderer/ui/builders/) translate tool overlay data into arrays of
 * these primitives; lowering (renderer/ui/lowering.ts) turns the sorted
 * primitive stream into cubic-bezier GPU instances for a single draw call.
 */

/**
 * A size or width with a coordinate-space annotation.
 *
 * - Size fields (radius, width, height, halfSize, head sizes, line fill
 *   width): bare number = world units. `screen` resolves as `px / zoom`.
 * - Stroke width fields (`StrokeStyle.width`): bare number = screen pixels.
 *   `screen` resolves with the AA-compensated half-width formula
 *   `(px + 1) / 2 / zoom`; `world` resolves as `w / 2` (exact, no padding).
 * - Object form may combine both spaces; components are summed after
 *   resolution (e.g. `{ world: r, screen: 0.5 }` = r + 0.5px outset).
 */
export type Dim = number | { world?: number; screen?: number };

interface FillStyle {
	color: RGBA;
}

interface StrokeStyle {
	color: RGBA;
	/** Stroke width. Bare number = screen px, AA-compensated at lowering. */
	width: Dim;
	/**
	 * Dash pattern in screen px (`length` drawn, `gap` skipped). Currently
	 * honored only by straight-edge rect strokes (cornerRadius 0); other
	 * primitives render solid.
	 */
	dash?: { length: number; gap: number };
}

interface PrimBase {
	/** Z offset added to the overlay's base z. Omitted = 0 (array order). */
	zIndex?: number;
	/**
	 * Screen-fixed offset in pixels, applied along world axes (Y-up) to every
	 * positional coordinate of the primitive. Resolved as `offset / zoom`.
	 */
	screenOffset?: { x: number; y: number };
	/**
	 * When set, hitTestOverlays (renderer/ui/hitTest.ts) reports this id for
	 * points hitting the primitive. Omitted = not hit-testable.
	 */
	hitId?: string;
	/**
	 * Hit-test tolerance override (size Dim semantics: bare number = world
	 * units). Default: `UI_THEME.hitTolerancePx / zoom`.
	 */
	hitPadding?: Dim;
	/** When true, the primitive is hit-testable but never drawn. */
	hitOnly?: boolean;
}

export interface CirclePrimitive extends PrimBase {
	kind: "circle";
	cx: number;
	cy: number;
	radius: Dim;
	fill?: FillStyle;
	stroke?: StrokeStyle;
}

export interface RectPrimitive extends PrimBase {
	kind: "rect";
	/** Center position (world). */
	cx: number;
	cy: number;
	width: Dim;
	height: Dim;
	/** Corner radius; clamped to half the shorter side. Omitted / 0 = sharp. */
	cornerRadius?: Dim;
	fill?: FillStyle;
	stroke?: StrokeStyle;
}

export interface DiamondPrimitive extends PrimBase {
	kind: "diamond";
	cx: number;
	cy: number;
	/** Distance from center to each vertex. */
	halfSize: Dim;
	fill?: FillStyle;
	stroke?: StrokeStyle;
}

export interface LinePrimitive extends PrimBase {
	kind: "line";
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	stroke?: StrokeStyle;
	/**
	 * Fat-line fill: a bar of exact total `width` (size semantics, no AA
	 * padding). Used for rotated filled bars such as the text cursor.
	 */
	fill?: { color: RGBA; width: Dim };
}

export interface PolylinePrimitive extends PrimBase {
	kind: "polyline";
	points: ReadonlyArray<{ x: number; y: number }>;
	/** When true, the stroke includes a closing segment (last → first). */
	closed?: boolean;
	/** Scanline fill of the (implicitly closed) polygon. */
	fill?: FillStyle;
	stroke?: StrokeStyle;
}

export interface BezierPathPrimitive extends PrimBase {
	kind: "bezierPath";
	/** Segments chain: a missing `start` continues from the previous end. */
	segments: ReadonlyArray<{
		start?: { x: number; y: number };
		cp1: { x: number; y: number };
		cp2: { x: number; y: number };
		end: { x: number; y: number };
	}>;
	closed?: boolean;
	fill?: FillStyle;
	stroke?: StrokeStyle;
}

export interface ArcPrimitive extends PrimBase {
	kind: "arc";
	cx: number;
	cy: number;
	radiusX: Dim;
	/** Defaults to radiusX (circular arc). */
	radiusY?: Dim;
	/** Ellipse rotation in radians (CCW, world Y-up). */
	rotation?: number;
	/** Arc angles in radians (CCW, 0 = +X axis). Full sweep = 2π. */
	startAngle: number;
	endAngle: number;
	stroke: StrokeStyle;
}

export interface ArrowPrimitive extends PrimBase {
	kind: "arrow";
	/** Tail position. */
	x1: number;
	y1: number;
	/** Tip position. */
	x2: number;
	y2: number;
	color: RGBA;
	/** Shaft stroke width. Bare number = screen px, AA-compensated. */
	width: Dim;
	/** Head triangle length along the arrow direction. */
	headLength: Dim;
	/** Head triangle base width. */
	headWidth: Dim;
}

export type UIPrimitive =
	| CirclePrimitive
	| RectPrimitive
	| DiamondPrimitive
	| LinePrimitive
	| PolylinePrimitive
	| BezierPathPrimitive
	| ArcPrimitive
	| ArrowPrimitive;

/**
 * A generic overlay channel entry (`UIOverlayState.overlays`): a batch of
 * primitives rendered at an optional base z. Stored values are immutable —
 * replace the whole object to update, never mutate in place.
 */
export interface UIOverlay {
	/** Base z for all primitives. Default: `OVERLAY_Z.default`. */
	zIndex?: number;
	primitives: readonly UIPrimitive[];
}

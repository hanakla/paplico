import type { Viewport } from "../../schema";
import { screenToWorld } from "../../utils/geometry/geometry";
import { flattenBezierContour, isPointInFillContour } from "./fillTessellation";
import {
	resolveScreenOffset,
	resolveSizeDim,
	resolveStrokeHalfWidth,
} from "./lowering";
import type { OverlayKey } from "./overlayKeys";
import type {
	ArcPrimitive,
	BezierPathPrimitive,
	UIOverlay,
	UIPrimitive,
} from "./primitives";
import { OVERLAY_Z, UI_THEME } from "./theme";

/**
 * Declarative CPU hit testing for the generic overlay channel
 * (`UIOverlayState.overlays`). Primitives carrying a `hitId` are tested in
 * the exact z/insertion order used for drawing (lowering.ts), scanned in
 * reverse so the front-most primitive wins. Dim/screenOffset resolution is
 * shared with lowering so hit extents match rendered extents.
 */

export interface OverlayHit {
	overlayKey: OverlayKey;
	hitId: string;
}

/** Flattening steps per cubic segment for bezier-path distance approximation. */
const BEZIER_HIT_STEPS = 16;

const TWO_PI = Math.PI * 2;

/**
 * Hit-test `point` (screen coordinates) against all overlay primitives that
 * carry a `hitId`. Returns the front-most hit or null.
 */
export function hitTestOverlays(
	overlays: Readonly<Partial<Record<OverlayKey, UIOverlay>>>,
	point: { x: number; y: number },
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): OverlayHit | null {
	const world = screenToWorld(
		point.x,
		point.y,
		viewport,
		canvasWidth,
		canvasHeight,
	);
	const zoom = viewport.zoom;

	// Same ordering rule as lowerScene: (overlay z + primitive zIndex, insertion
	// order). Record key insertion order defines overlay insertion order.
	const entries: Array<{
		z: number;
		seq: number;
		overlayKey: OverlayKey;
		prim: UIPrimitive;
	}> = [];
	let seq = 0;
	const overlayEntries = Object.entries(overlays) as Array<
		[OverlayKey, UIOverlay | undefined]
	>;
	for (const [overlayKey, overlay] of overlayEntries) {
		if (!overlay) continue;
		const baseZ = overlay.zIndex ?? OVERLAY_Z.default;
		for (const prim of overlay.primitives) {
			seq++;
			if (prim.hitId == null) continue;
			entries.push({ z: baseZ + (prim.zIndex ?? 0), seq, overlayKey, prim });
		}
	}
	entries.sort((a, b) => a.z - b.z || a.seq - b.seq);

	// Reverse scan: front-most primitive first.
	for (let i = entries.length - 1; i >= 0; i--) {
		const { overlayKey, prim } = entries[i];
		const tolerance =
			prim.hitPadding != null
				? resolveSizeDim(prim.hitPadding, zoom)
				: UI_THEME.hitTolerancePx / zoom;
		if (hitTestPrimitive(prim, world.x, world.y, zoom, tolerance)) {
			return { overlayKey, hitId: prim.hitId! };
		}
	}
	return null;
}

// --- Per-primitive hit tests (world space) ---

function hitTestPrimitive(
	prim: UIPrimitive,
	px: number,
	py: number,
	zoom: number,
	tolerance: number,
): boolean {
	// Undo the primitive's screen-fixed offset instead of offsetting every coord.
	const { x: ox, y: oy } = resolveScreenOffset(prim.screenOffset, zoom);
	const x = px - ox;
	const y = py - oy;

	switch (prim.kind) {
		case "circle": {
			const radius = resolveSizeDim(prim.radius, zoom);
			return Math.hypot(x - prim.cx, y - prim.cy) <= radius + tolerance;
		}
		case "rect": {
			// Distance to the (axis-aligned) rect: 0 inside, else edge distance.
			const halfW = resolveSizeDim(prim.width, zoom) / 2;
			const halfH = resolveSizeDim(prim.height, zoom) / 2;
			const dx = Math.max(Math.abs(x - prim.cx) - halfW, 0);
			const dy = Math.max(Math.abs(y - prim.cy) - halfH, 0);
			return Math.hypot(dx, dy) <= tolerance;
		}
		case "diamond": {
			const hs = resolveSizeDim(prim.halfSize, zoom);
			// L1 distance ≤ hs means inside; otherwise the edge lines |dx|+|dy|=hs
			// are at Euclidean distance (|dx|+|dy|−hs)/√2.
			const l1 = Math.abs(x - prim.cx) + Math.abs(y - prim.cy);
			return l1 <= hs || (l1 - hs) / Math.SQRT2 <= tolerance;
		}
		case "line": {
			const hw = Math.max(
				prim.stroke ? resolveStrokeHalfWidth(prim.stroke.width, zoom) : 0,
				prim.fill ? resolveSizeDim(prim.fill.width, zoom) / 2 : 0,
			);
			return (
				distanceToSegment(x, y, prim.x1, prim.y1, prim.x2, prim.y2) <=
				hw + tolerance
			);
		}
		case "polyline": {
			const points = prim.points;
			if (points.length < 2) return false;
			const hw = prim.stroke
				? resolveStrokeHalfWidth(prim.stroke.width, zoom)
				: 0;
			const maxDist = hw + tolerance;
			const segCount = prim.closed ? points.length : points.length - 1;
			for (let i = 0; i < segCount; i++) {
				const p0 = points[i];
				const p1 = points[(i + 1) % points.length];
				if (distanceToSegment(x, y, p0.x, p0.y, p1.x, p1.y) <= maxDist) {
					return true;
				}
			}
			if (prim.closed && prim.fill && isPointInFillContour(points, x, y)) {
				return true;
			}
			return false;
		}
		case "bezierPath":
			return hitTestBezierPath(prim, x, y, zoom, tolerance);
		case "arc":
			return hitTestArc(prim, x, y, zoom, tolerance);
		case "arrow": {
			// Whole arrow as a fat segment: shaft half-width or head half-width,
			// whichever is larger.
			const hw = Math.max(
				resolveStrokeHalfWidth(prim.width, zoom),
				resolveSizeDim(prim.headWidth, zoom) / 2,
			);
			return (
				distanceToSegment(x, y, prim.x1, prim.y1, prim.x2, prim.y2) <=
				hw + tolerance
			);
		}
	}
}

/** Angle-range + radial-band test against the (possibly elliptical) arc. */
function hitTestArc(
	prim: ArcPrimitive,
	x: number,
	y: number,
	zoom: number,
	tolerance: number,
): boolean {
	const rx = resolveSizeDim(prim.radiusX, zoom);
	const ry = prim.radiusY != null ? resolveSizeDim(prim.radiusY, zoom) : rx;
	if (rx <= 0 || ry <= 0) return false;
	const hw = resolveStrokeHalfWidth(prim.stroke.width, zoom);
	const maxDist = hw + tolerance;

	// Un-rotate the point into the ellipse's local frame.
	const rotation = prim.rotation ?? 0;
	const cos = Math.cos(-rotation);
	const sin = Math.sin(-rotation);
	const dx = x - prim.cx;
	const dy = y - prim.cy;
	const lx = dx * cos - dy * sin;
	const ly = dx * sin + dy * cos;

	// Parametric angle of the nearest ellipse point (exact for circles,
	// approximation for ellipses — consistent with the ≤4-cubic rendering).
	const angle = Math.atan2(ly / ry, lx / rx);

	const sweep = prim.endAngle - prim.startAngle;
	if (Math.abs(sweep) < TWO_PI) {
		if (sweep === 0) return false;
		// Normalized CCW offset from startAngle in [0, 2π).
		const offset = (((angle - prim.startAngle) % TWO_PI) + TWO_PI) % TWO_PI;
		const inSweep =
			sweep > 0 ? offset <= sweep : offset === 0 || offset >= TWO_PI + sweep;
		if (!inSweep) return false;
	}

	// Radial band: distance to the ellipse point at the computed angle.
	const ex = rx * Math.cos(angle);
	const ey = ry * Math.sin(angle);
	return Math.hypot(lx - ex, ly - ey) <= maxDist;
}

/** Flatten each cubic into line segments and test segment distance. */
function hitTestBezierPath(
	prim: BezierPathPrimitive,
	x: number,
	y: number,
	zoom: number,
	tolerance: number,
): boolean {
	if (
		prim.fill &&
		prim.closed &&
		isPointInFillContour(
			flattenBezierContour(prim.segments, 0, 0, 0.25 / zoom),
			x,
			y,
		)
	) {
		return true;
	}
	if (!prim.stroke) return false;

	const hw = resolveStrokeHalfWidth(prim.stroke.width, zoom);
	const maxDist = hw + tolerance;

	let prevEnd: { x: number; y: number } | null = null;
	for (const seg of prim.segments) {
		const p0 = seg.start ?? prevEnd ?? seg.end;
		let lastX = p0.x;
		let lastY = p0.y;
		for (let i = 1; i <= BEZIER_HIT_STEPS; i++) {
			const t = i / BEZIER_HIT_STEPS;
			const mt = 1 - t;
			const a = mt * mt * mt;
			const b = 3 * mt * mt * t;
			const c = 3 * mt * t * t;
			const d = t * t * t;
			const cx = a * p0.x + b * seg.cp1.x + c * seg.cp2.x + d * seg.end.x;
			const cy = a * p0.y + b * seg.cp1.y + c * seg.cp2.y + d * seg.end.y;
			if (distanceToSegment(x, y, lastX, lastY, cx, cy) <= maxDist) {
				return true;
			}
			lastX = cx;
			lastY = cy;
		}
		prevEnd = seg.end;
	}
	return false;
}

function distanceToSegment(
	px: number,
	py: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(px - x1, py - y1);
	const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

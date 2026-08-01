import type { ElementTransform, Vec3 } from "../schema";

/**
 * Shared rotation-ring construction for on-canvas 3D gizmos (Reference3DTool,
 * the select tool's extrude gizmo). Projection-agnostic: callers supply a
 * `project` callback mapping a 3D point to their 2D frame.
 */

/** Maps a 3D point into the caller's 2D frame; null = not projectable. */
export type GizmoProjectFn = (point: Vec3) => { x: number; y: number } | null;

/** Ring polyline sample count (also used for the drag-sign probe). */
export const GIZMO_RING_SEGMENTS = 32;

/** Right-handed orthonormal basis of the plane perpendicular to `axis`. */
export function ringBasis(axis: Vec3): { u: Vec3; v: Vec3 } {
	const ref: Vec3 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
	const u = normalize3(cross3(axis, ref));
	return { u, v: cross3(axis, u) };
}

/**
 * 2D sample points of the rotation ring for `axis`: the unit circle around
 * `center` pushed through the projection LINEARIZED at the center (unit-step
 * finite differences), then scaled so the widest extent is exactly
 * `radiusLocal`. This keeps the ring a fixed on-screen size regardless of
 * how non-linear the projection is away from the center.
 * Null when the center or a basis step does not project.
 */
export function projectRingPoints(
	center: Vec3,
	axis: Vec3,
	radiusLocal: number,
	project: GizmoProjectFn,
): Array<{ x: number; y: number }> | null {
	const centerLocal = project(center);
	if (!centerLocal) return null;

	// Local-space images of unit steps along the ring plane's basis.
	const { u, v } = ringBasis(axis);
	const a = unitStepImage(center, u, centerLocal, project);
	const b = unitStepImage(center, v, centerLocal, project);
	if (!a || !b) return null;

	// Largest singular value of [a b] = the projected ellipse's semi-major
	// extent for a unit circle; normalize it onto the requested radius.
	const e = a.x * a.x + a.y * a.y;
	const f = a.x * b.x + a.y * b.y;
	const g = b.x * b.x + b.y * b.y;
	const trace = e + g;
	const det = e * g - f * f;
	const major = Math.sqrt(
		(trace + Math.sqrt(Math.max(trace * trace - 4 * det, 0))) / 2,
	);
	if (major < 1e-9) return null;
	const s = radiusLocal / major;

	const points: Array<{ x: number; y: number }> = [];
	for (let i = 0; i < GIZMO_RING_SEGMENTS; i++) {
		const t = (i / GIZMO_RING_SEGMENTS) * Math.PI * 2;
		const cos = Math.cos(t);
		const sin = Math.sin(t);
		points.push({
			x: centerLocal.x + (a.x * cos + b.x * sin) * s,
			y: centerLocal.y + (a.y * cos + b.y * sin) * s,
		});
	}
	return points;
}

/**
 * Orientation of the projected ring: +1 when increasing ring parameter reads
 * counter-clockwise in the 2D frame. Because {u, v, axis} is right-handed,
 * this is exactly the sign mapping a CCW pointer angle onto a positive
 * rotation around `axis`.
 */
export function ringOrientationSign(
	points: Array<{ x: number; y: number }>,
): 1 | -1 {
	let area = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		area += a.x * b.y - b.x * a.y;
	}
	return area >= 0 ? 1 : -1;
}

/** Representative uniform scale of a transform (for screen-fixed sizes). */
export function meanTransformScale(t: ElementTransform): number {
	const scale = Math.sqrt(Math.abs(t.scaleX * t.scaleY));
	return scale > 1e-6 ? scale : 1;
}

/** 2D image of a +1 step from `center` along `dir` under `project`. */
function unitStepImage(
	center: Vec3,
	dir: Vec3,
	centerLocal: { x: number; y: number },
	project: GizmoProjectFn,
): { x: number; y: number } | null {
	const to = project([
		center[0] + dir[0],
		center[1] + dir[1],
		center[2] + dir[2],
	]);
	if (!to) return null;
	return { x: to.x - centerLocal.x, y: to.y - centerLocal.y };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

function normalize3(v: Vec3): Vec3 {
	const len = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / len, v[1] / len, v[2] / len];
}

import {
	type ElementTransform,
	isIdentityTransform,
	type Reference3DCamera,
	type Vec3,
} from "../../schema";
import { applyTransformToPoint } from "../../utils/geometry/geometry";

/**
 * Shared pinhole-camera projection math for the Reference3D subsystem.
 *
 * Pure functions, three.js-free, always loaded (used by Reference3DTool and the
 * perspective-ruler vanishing point derivation). The camera model matches
 * Reference3DService exactly: fovDeg = vertical FOV, aspect = width / height,
 * look-at basis with the camera's `up` reference.
 *
 * Element mapping follows Reference3DElementRenderer's quad blit: NDC maps
 * linearly onto the untransformed local rect, and the composed element
 * transform (applyTransformToPoint around the rect center) carries local
 * coordinates onto the canvas.
 */

export interface Vec2 {
	x: number;
	y: number;
}

/** Element placement rect in element-local canvas coordinates (untransformed). */
export interface LocalRect {
	cx: number;
	cy: number;
	width: number;
	height: number;
}

interface CameraBasis {
	forward: Vec3;
	right: Vec3;
	up: Vec3;
}

// --- Vec3 ops ---

export function add3(a: Vec3, b: Vec3): Vec3 {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3, s: number): Vec3 {
	return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a: Vec3, b: Vec3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

export function length3(a: Vec3): number {
	return Math.hypot(a[0], a[1], a[2]);
}

export function normalize3(a: Vec3): Vec3 {
	const len = length3(a);
	return len < 1e-12 ? [0, 0, 0] : scale3(a, 1 / len);
}

// --- Camera projection ---

export function cameraBasis(camera: Reference3DCamera): CameraBasis {
	const forward = normalize3(sub3(camera.target, camera.position));
	const upRef: Vec3 = camera.up ?? [0, 1, 0];
	let right = cross3(forward, upRef);
	if (length3(right) < 1e-6) right = cross3(forward, [0, 0, 1]);
	right = normalize3(right);
	return { forward, right, up: cross3(right, forward) };
}

/** Half-height of the view frustum at the given depth (or the ortho half-height). */
export function viewHalfHeightAt(
	camera: Reference3DCamera,
	depth: number,
): number {
	return camera.projection === "orthographic"
		? (camera.orthoHeight ?? 2) / 2
		: Math.tan((camera.fovDeg * Math.PI) / 360) * depth;
}

/**
 * Project a world-3D point to NDC through the element camera. Returns null
 * for points at or behind the camera plane (perspective projection).
 */
export function projectToNdc(
	point: Vec3,
	camera: Reference3DCamera,
	aspect: number,
): Vec2 | null {
	const basis = cameraBasis(camera);
	const rel = sub3(point, camera.position);
	const x = dot3(rel, basis.right);
	const y = dot3(rel, basis.up);
	const depth = dot3(rel, basis.forward);

	if (camera.projection === "orthographic") {
		const halfH = (camera.orthoHeight ?? 2) / 2;
		return { x: x / (halfH * aspect), y: y / halfH };
	}

	if (depth <= 1e-6) return null;
	const halfH = Math.tan((camera.fovDeg * Math.PI) / 360) * depth;
	return { x: x / (halfH * aspect), y: y / halfH };
}

// --- Element-local ↔ canvas mapping ---

/** NDC (-1..1, Y up) → element-local coordinates within the local rect. */
export function ndcToLocal(ndc: Vec2, rect: LocalRect): Vec2 {
	return {
		x: rect.cx + (ndc.x * rect.width) / 2,
		y: rect.cy + (ndc.y * rect.height) / 2,
	};
}

/**
 * Forward-map an element-local point to canvas world through the composed
 * transform (SRT around the local rect center — identical to the renderer's
 * corner transform).
 */
export function localToCanvasPoint(
	point: Vec2,
	rect: LocalRect,
	transform: ElementTransform,
): Vec2 {
	if (isIdentityTransform(transform)) return point;
	return applyTransformToPoint(point.x, point.y, transform, rect.cx, rect.cy);
}

/** Inverse of localToCanvasPoint: canvas world → element-local coordinates. */
export function canvasToLocalPoint(
	point: Vec2,
	rect: LocalRect,
	transform: ElementTransform,
): Vec2 {
	if (isIdentityTransform(transform)) return point;
	const dx = point.x - transform.x - rect.cx;
	const dy = point.y - transform.y - rect.cy;
	const cos = Math.cos(transform.rotation);
	const sin = Math.sin(transform.rotation);
	const sx = dx * cos + dy * sin;
	const sy = -dx * sin + dy * cos;
	return {
		x: sx / (transform.scaleX || 1e-12) + rect.cx,
		y: sy / (transform.scaleY || 1e-12) + rect.cy,
	};
}

/**
 * Map an element-local direction vector to canvas space (rotation + scale
 * only — translation drops out for directions). Not normalized.
 */
export function transformDirection(
	direction: Vec2,
	transform: ElementTransform,
): Vec2 {
	if (isIdentityTransform(transform)) return direction;
	const sx = direction.x * transform.scaleX;
	const sy = direction.y * transform.scaleY;
	const cos = Math.cos(transform.rotation);
	const sin = Math.sin(transform.rotation);
	return { x: sx * cos - sy * sin, y: sx * sin + sy * cos };
}

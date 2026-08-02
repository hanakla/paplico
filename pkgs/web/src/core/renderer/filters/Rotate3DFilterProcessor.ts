/**
 * 3D Rotation Pre-Filter Processor
 *
 * Vector-based 3D rotation: rotates each bezier control point around the
 * subpath bounding box centre via R = Rz * Ry * Rx, then applies perspective
 * projection. The adaptive subdivision / segment re-emit machinery is shared
 * with other projective pre-filters in `projectiveBezier.ts`; this file owns
 * only the rotation matrix and the (R, d) point projection.
 */

import type {
	Appearance,
	BoundingBox,
	CubicBezierSegment,
	Filter,
} from "../../schema";
import type { FilterHandler } from "../canvas/pipeline/FilterRenderer";
import {
	type Point,
	transformSegmentsWithProjection,
	visitSegmentPoints,
} from "./projectiveBezier";

export interface Rotate3DParams {
	rotateX: number;
	rotateY: number;
	rotateZ: number;
	perspective: number;
}

export interface Rotate3DFilter extends Appearance<Rotate3DParams> {
	processor: "3d-rotate";
}

export interface Rotate3DProjectionContext {
	R: Mat3;
	d: number;
	cx: number;
	cy: number;
	zThreshold: number;
	projectionErrorThreshold: number;
}

type Mat3 = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

const Z_VARIANCE_THRESHOLD_RATIO = 0.02; // 2% of perspective distance
const PROJECTION_ERROR_THRESHOLD_RATIO = 0.0005; // 0.05% of source bounds diagonal
const MIN_PROJECTION_ERROR_THRESHOLD = 0.01;
const MIN_NEAR_PLANE_MARGIN = 1e-3;

export class Rotate3DFilterProcessor implements FilterHandler {
	public async initialize(
		_device: GPUDevice,
		_canvasFormat: GPUTextureFormat,
	): Promise<void> {
		/* no-op: vector deformation does not use GPU pipelines */
	}

	public preProcess(
		segments: CubicBezierSegment[],
		filter: Filter,
	): CubicBezierSegment[] {
		return applyRotate3DToSegments(
			segments,
			(filter as Rotate3DFilter).paramData.params,
		);
	}

	public onScaleFilter(filter: Filter, _scale: [number, number]): Filter {
		return filter;
	}

	public getExpansionMargin(_filter: Filter): number {
		// preProcess deforms geometry itself; downstream bounds are recalculated
		// from the transformed segments so no extra texture padding is required.
		return 0;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as Rotate3DParams;
		const b = paramsB as Rotate3DParams;
		return {
			rotateX: a.rotateX + (b.rotateX - a.rotateX) * t,
			rotateY: a.rotateY + (b.rotateY - a.rotateY) * t,
			rotateZ: a.rotateZ + (b.rotateZ - a.rotateZ) * t,
			perspective: a.perspective + (b.perspective - a.perspective) * t,
		};
	}
}

export function applyRotate3DToSegments(
	segments: CubicBezierSegment[],
	params: Rotate3DParams,
	boundsOverride?: Pick<BoundingBox, "minX" | "minY" | "maxX" | "maxY">,
): CubicBezierSegment[] {
	const context = createRotate3DProjectionContext(
		params,
		segments,
		boundsOverride,
	);
	if (!context) return segments;

	return applyRotate3DWithContext(segments, context);
}

export function createRotate3DProjectionContext(
	params: Rotate3DParams,
	segments: CubicBezierSegment[],
	boundsOverride?: Pick<BoundingBox, "minX" | "minY" | "maxX" | "maxY">,
): Rotate3DProjectionContext | null {
	if (segments.length === 0) return null;

	const rx = toRadians(params.rotateX);
	const ry = -toRadians(params.rotateY);
	const rz = -toRadians(params.rotateZ);

	if (Math.abs(rx) < 1e-9 && Math.abs(ry) < 1e-9 && Math.abs(rz) < 1e-9) {
		return null;
	}

	const R = buildRotationMatrix(rx, ry, rz);
	const { cx, cy, halfDiag } = boundsOverride
		? computeCenterFromBounds(boundsOverride)
		: computeBBoxCenter(segments);
	if (halfDiag < 1e-9) return null;

	const d = computePerspectiveDistance(params.perspective, halfDiag);
	const safeD = ensureSafePerspectiveDistance(segments, R, d, cx, cy, halfDiag);
	const zThreshold = safeD * Z_VARIANCE_THRESHOLD_RATIO;
	const projectionErrorThreshold = Math.max(
		halfDiag * PROJECTION_ERROR_THRESHOLD_RATIO,
		MIN_PROJECTION_ERROR_THRESHOLD,
	);

	return {
		R,
		d: safeD,
		cx,
		cy,
		zThreshold,
		projectionErrorThreshold,
	};
}

export function applyRotate3DWithContext(
	segments: CubicBezierSegment[],
	context: Rotate3DProjectionContext,
): CubicBezierSegment[] {
	const { R, d, cx, cy, zThreshold, projectionErrorThreshold } = context;
	return transformSegmentsWithProjection(
		segments,
		(x, y) => projectPoint(x, y, R, d, cx, cy),
		projectionErrorThreshold,
		(p0, p1, p2, p3) => {
			const z0 = rotatedZ(R, p0.x - cx, p0.y - cy);
			const z1 = rotatedZ(R, p1.x - cx, p1.y - cy);
			const z2 = rotatedZ(R, p2.x - cx, p2.y - cy);
			const z3 = rotatedZ(R, p3.x - cx, p3.y - cy);
			return Math.max(z0, z1, z2, z3) - Math.min(z0, z1, z2, z3) > zThreshold;
		},
	);
}

// ---------------------------------------------------------------------------
// Rotation / projection helpers
// ---------------------------------------------------------------------------

function toRadians(deg: number): number {
	return (deg * Math.PI) / 180.0;
}

/** Build composed rotation matrix R = Rz * Ry * Rx (row-major). */
function buildRotationMatrix(rx: number, ry: number, rz: number): Mat3 {
	const cx = Math.cos(rx);
	const sx = Math.sin(rx);
	const cy = Math.cos(ry);
	const sy = Math.sin(ry);
	const cz = Math.cos(rz);
	const sz = Math.sin(rz);

	return [
		cz * cy,
		-sz * cx + cz * sy * sx,
		sz * sx + cz * sy * cx,
		sz * cy,
		cz * cx + sz * sy * sx,
		-cz * sx + sz * sy * cx,
		-sy,
		cy * sx,
		cy * cx,
	];
}

/** Rotated z-coordinate of (x, y, 0) — used for subdivision heuristics. */
function rotatedZ(m: Mat3, x: number, y: number): number {
	return m[6] * x + m[7] * y;
}

/**
 * Rotate (x, y, 0) around (cx, cy) and apply perspective projection.
 * Camera is at (cx, cy, -d) looking toward +z so that z=0 points project
 * onto themselves.
 */
function projectPoint(
	x: number,
	y: number,
	R: Mat3,
	d: number,
	cx: number,
	cy: number,
): Point {
	const lx = x - cx;
	const ly = y - cy;
	const rx = R[0] * lx + R[1] * ly;
	const ry = R[3] * lx + R[4] * ly;
	const rz = R[6] * lx + R[7] * ly;

	const denom = Math.max(d + rz, MIN_NEAR_PLANE_MARGIN);
	const w = d / denom;
	return { x: rx * w + cx, y: ry * w + cy };
}

function computeCenterFromBounds(
	bounds: Pick<BoundingBox, "minX" | "minY" | "maxX" | "maxY">,
): {
	cx: number;
	cy: number;
	halfDiag: number;
} {
	const cx = (bounds.minX + bounds.maxX) / 2;
	const cy = (bounds.minY + bounds.maxY) / 2;
	const dx = bounds.maxX - bounds.minX;
	const dy = bounds.maxY - bounds.minY;
	return { cx, cy, halfDiag: Math.sqrt(dx * dx + dy * dy) / 2 };
}

function computeBBoxCenter(segments: CubicBezierSegment[]): {
	cx: number;
	cy: number;
	halfDiag: number;
} {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	visitSegmentPoints(segments, (p) => {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	});

	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const dx = maxX - minX;
	const dy = maxY - minY;
	const halfDiag = Math.sqrt(dx * dx + dy * dy) / 2;
	return { cx, cy, halfDiag };
}

function computePerspectiveDistance(
	perspective: number,
	halfDiag: number,
): number {
	const clampedPerspective = Math.min(Math.max(perspective, 1), 179);
	const fovRad = toRadians(clampedPerspective);
	return halfDiag / Math.tan(fovRad / 2);
}

function ensureSafePerspectiveDistance(
	segments: CubicBezierSegment[],
	R: Mat3,
	d: number,
	cx: number,
	cy: number,
	halfDiag: number,
): number {
	let minRotatedDepth = Infinity;
	visitSegmentPoints(segments, (p) => {
		minRotatedDepth = Math.min(
			minRotatedDepth,
			rotatedZ(R, p.x - cx, p.y - cy),
		);
	});

	const nearPlaneMargin = Math.max(halfDiag * 0.05, MIN_NEAR_PLANE_MARGIN);
	return Math.max(d, -minRotatedDepth + nearPlaneMargin);
}

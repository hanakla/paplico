import type { Vec3 } from "../../schema";

/**
 * Minimal 4x4 matrix math for the extrude appearance pipeline (three-free).
 * Matrices are column-major Float32Arrays (WGSL `mat4x4f` layout), so they
 * upload to uniform buffers without conversion.
 */
export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
	// biome-ignore format: matrix literal
	return new Float32Array([
		1, 0, 0, 0,
		0, 1, 0, 0,
		0, 0, 1, 0,
		0, 0, 0, 1,
	]);
}

/** result = a · b (apply b first, then a). */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Float32Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) {
				sum += a[k * 4 + row] * b[col * 4 + k];
			}
			out[col * 4 + row] = sum;
		}
	}
	return out;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
	const out = mat4Identity();
	out[12] = x;
	out[13] = y;
	out[14] = z;
	return out;
}

export function mat4RotationX(rad: number): Mat4 {
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const out = mat4Identity();
	out[5] = c;
	out[6] = s;
	out[9] = -s;
	out[10] = c;
	return out;
}

export function mat4RotationY(rad: number): Mat4 {
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const out = mat4Identity();
	out[0] = c;
	out[2] = -s;
	out[8] = s;
	out[10] = c;
	return out;
}

export function mat4RotationZ(rad: number): Mat4 {
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const out = mat4Identity();
	out[0] = c;
	out[1] = s;
	out[4] = -s;
	out[5] = c;
	return out;
}

/**
 * Orthographic projection onto WebGPU clip space (x,y ∈ [-1,1], z ∈ [0,1]).
 * The camera looks down -Z: zNear is the largest (closest) z, zFar the
 * smallest, and closer geometry maps to smaller depth values.
 */
export function mat4Orthographic(
	left: number,
	right: number,
	bottom: number,
	top: number,
	zNear: number,
	zFar: number,
): Mat4 {
	const out = mat4Identity();
	out[0] = 2 / (right - left);
	out[5] = 2 / (top - bottom);
	out[10] = 1 / (zFar - zNear);
	out[12] = (right + left) / (left - right);
	out[13] = (top + bottom) / (bottom - top);
	out[14] = zNear / (zNear - zFar);
	return out;
}

/**
 * Simple perspective factor around a screen-space principal point:
 * x' = originX + (x - originX) / w, y' = originY + (y - originY) / w,
 * w = 1 - z / focal. Geometry in front of the XY plane (z > 0) enlarges,
 * geometry behind (z < 0, the extruded back) shrinks.
 */
export function mat4SimplePerspective(
	focal: number,
	originX = 0,
	originY = 0,
): Mat4 {
	const out = mat4Identity();
	out[8] = -originX / focal;
	out[9] = -originY / focal;
	out[11] = -1 / focal;
	return out;
}

export function mat4PerspectiveDistanceFromFov(
	perspectiveDeg: number,
	halfDiagonal: number,
): number {
	const clampedPerspective = Math.min(Math.max(perspectiveDeg, 1), 179);
	const fovRad = (clampedPerspective * Math.PI) / 180;
	return halfDiagonal / Math.tan(fovRad / 2);
}

/** Transform a point, applying the homogeneous divide. */
export function mat4TransformPoint(m: Mat4, point: Vec3): Vec3 {
	const x = point[0];
	const y = point[1];
	const z = point[2];
	const w = m[3] * x + m[7] * y + m[11] * z + m[15];
	if (Math.abs(w) < 1e-7) {
		return [Number.NaN, Number.NaN, Number.NaN];
	}
	return [
		(m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
		(m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
		(m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
	];
}

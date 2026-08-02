/**
 * Transform Common WGSL - Element transform struct and apply function
 *
 * Shared by stroke, gradientFill, stencil, and brushStamp shaders.
 * Each element's transform is stored in a Storage Buffer indexed by elementIndex.
 *
 * GPU struct layout: 56 bytes (14 × 4-byte values)
 *   tx, ty            - Translation offset (world units)
 *   originX, originY  - Transform origin (center of raw bounds)
 *   m00, m01, m10, m11 - Row-major 2×2 linear part (rotation · shear · scale)
 *   maskIndex         - Index into clip mask atlas (0xFFFFFFFF = no mask);
 *                       high bit set = the mask is inverted
 *   _pad1             - Padding for vec2f alignment
 *   maskBoundsMin     - World-space min corner of mask texture coverage
 *   maskBoundsMax     - World-space max corner of mask texture coverage
 *
 * Identity transform (tx=0, ty=0, origin=(0,0), m=identity,
 * maskIndex=0xFFFFFFFF) produces an arithmetic no-op and skips mask sampling.
 */

export const TRANSFORM_COMMON_WGSL = /* wgsl */ `
struct ElementTransform {
	tx: f32,
	ty: f32,
	originX: f32,
	originY: f32,
	m00: f32,
	m01: f32,
	m10: f32,
	m11: f32,
	maskIndex: u32,
	_pad1: u32,
	maskBoundsMin: vec2f,
	maskBoundsMax: vec2f,
}

fn applyElementTransform(pos: vec2f, et: ElementTransform) -> vec2f {
	let local = pos - vec2f(et.originX, et.originY);
	let mapped = vec2f(
		et.m00 * local.x + et.m01 * local.y,
		et.m10 * local.x + et.m11 * local.y,
	);
	return mapped + vec2f(et.originX, et.originY) + vec2f(et.tx, et.ty);
}
`;

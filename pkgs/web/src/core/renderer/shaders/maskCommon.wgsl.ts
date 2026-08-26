/**
 * Mask Common WGSL - mask sampling shared by every shader that can be clipped:
 * the unified geometry shader, its vertex-pulling variant, both brush-stamp
 * shaders and the ribbon stroke shader. Expects `maskAtlas` / `maskSampler`
 * bound at group(3) in the including module.
 *
 * The mask texture holds the mask elements rendered with their real appearance
 * in premultiplied alpha, so its luminance already carries the mask's own
 * opacity — one dot product yields "luminance x opacity". A flat white
 * silhouette (what clip groups render) has premultiplied RGB of (1,1,1)*a, so
 * its luminance equals its alpha and clipping behaves exactly as before.
 */

export const MASK_COMMON_WGSL = /* wgsl */ `
@group(3) @binding(2) var<storage, read> maskRects: array<vec4u>;

const MASK_LUMA = vec3f(0.2126, 0.7152, 0.0722);
const MASK_ATLAS_BIT = 0x40000000u;

fn applyClipMask(premultiplied: vec4f, maskIdx: u32, boundsMin: vec2f, boundsMax: vec2f, worldPos: vec2f) -> vec4f {
	if (maskIdx == 0xFFFFFFFFu) {
		return premultiplied;
	}
	let rawUV = (worldPos - boundsMin) / (boundsMax - boundsMin);
	// Flip Y: world coords are Y-up but texture UV is Y-down.
	let maskUV = vec2f(rawUV.x, 1.0 - rawUV.y);
	// Use textureSampleLevel (explicit LOD) to avoid uniform control flow
	// restriction of textureSample.  Clamp UV and zero-out fragments outside
	// [0,1] via step() instead of an early-return branch.
	var clampedUV = clamp(maskUV, vec2f(0.0), vec2f(1.0));
	if ((maskIdx & MASK_ATLAS_BIT) != 0u) {
		let rect = maskRects[maskIdx & 0x3FFFFFFFu];
		let origin = vec2f(rect.xy);
		let size = vec2f(rect.zw);
		let atlasSize = vec2f(textureDimensions(maskAtlas));
		clampedUV = (origin + vec2f(0.5) + clampedUV * max(size - vec2f(1.0), vec2f(0.0))) / atlasSize;
	}
	let sampled = textureSampleLevel(maskAtlas, maskSampler, clampedUV, 0.0);
	let inBounds = step(0.0, maskUV.x) * step(maskUV.x, 1.0)
	             * step(0.0, maskUV.y) * step(maskUV.y, 1.0);
	// Outside the covered area the mask reads as empty, which an inverted mask
	// turns into "fully visible" — the mirror of the non-inverted case.
	let covered = dot(sampled.rgb, MASK_LUMA) * inBounds;
	let inverted = f32((maskIdx & 0x80000000u) != 0u);
	let maskValue = mix(covered, 1.0 - covered, inverted);
	return premultiplied * maskValue;
}
`;

/**
 * Shared vertex-side conventions for every quad blit in the renderer.
 *
 * A quad is drawn as two triangles over four corners ordered TL → TR → BR → BL.
 * `computeQuadProjectiveWeights` (utils/geometry/quadProjection) produces one
 * homogeneous weight per corner in that same order; the vertex stage multiplies
 * the corner's UV by its weight and the fragment stage divides by the
 * interpolated weight, which turns the GPU's per-triangle linear interpolation
 * into the projective mapping a non-parallelogram quad actually needs.
 *
 * Corner order, triangle winding and the UV assignment have to agree between
 * the CPU weights and every shader that consumes them, so they live here once
 * instead of being re-typed per pipeline. Interpolate `@location` uv as
 * `uv * q` alongside a `q` varying, then resolve it with `projectiveQuadUv`.
 */
export const PROJECTIVE_QUAD_WGSL = /* wgsl */ `
	/** Corner index (0=TL, 1=TR, 2=BR, 3=BL) for a 6-vertex quad draw. */
	fn quadCornerIndex(vertexIndex: u32) -> u32 {
		// TL-TR-BL, then BL-TR-BR.
		var cornerIdx = array<u32, 6>(0u, 1u, 3u, 3u, 1u, 2u);
		return cornerIdx[vertexIndex];
	}

	/** The unit-square UV a corner samples, in the same order. */
	fn quadCornerUv(cornerIndex: u32) -> vec2f {
		var uvs = array<vec2f, 4>(
			vec2f(0.0, 0.0),
			vec2f(1.0, 0.0),
			vec2f(1.0, 1.0),
			vec2f(0.0, 1.0),
		);
		return uvs[cornerIndex];
	}

	/** Undo the per-corner weight the vertex stage folded into the UV. */
	fn projectiveQuadUv(uvTimesQ: vec2f, q: f32) -> vec2f {
		return uvTimesQ / q;
	}
`;

/**
 * Soft proof blit shader.
 *
 * Applies an RGB→CMYK→RGB roundtrip 3D LUT as the final display pass to
 * simulate how the document would look when printed (soft proofing).
 * Fullscreen 6-vertex blit, same construction as EXPOSURE_BLIT_SHADER.
 */
export const SOFT_PROOF_BLIT_SHADER = /* wgsl */ `
	struct SoftProofUniforms {
		lutSize: f32,
	}

	@group(0) @binding(0) var<uniform> proofUniforms: SoftProofUniforms;
	@group(0) @binding(1) var lutSampler: sampler;
	@group(0) @binding(2) var lutTexture: texture_3d<f32>;
	@group(0) @binding(3) var sourceTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var output: VertexOutput;

		var positions = array<vec2f, 6>(
			vec2f(-1.0, -1.0),
			vec2f(1.0, -1.0),
			vec2f(-1.0, 1.0),
			vec2f(-1.0, 1.0),
			vec2f(1.0, -1.0),
			vec2f(1.0, 1.0),
		);

		var texCoords = array<vec2f, 6>(
			vec2f(0.0, 1.0),
			vec2f(1.0, 1.0),
			vec2f(0.0, 0.0),
			vec2f(0.0, 0.0),
			vec2f(1.0, 1.0),
			vec2f(1.0, 0.0),
		);

		output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
		output.texCoord = texCoords[vertexIndex];
		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let sampled = textureSample(sourceTexture, lutSampler, input.texCoord);
		let alpha = sampled.a;

		// Source is premultiplied; (near-)transparent pixels carry no color.
		if (alpha < 0.0001) {
			return vec4f(0.0);
		}

		// Unpremultiply, then clamp to SDR range. HDR rgba16float sources may
		// exceed 1.0, but print simulation is inherently SDR.
		let straight = clamp(sampled.rgb / alpha, vec3f(0.0), vec3f(1.0));

		// Half-texel correction: remap [0,1] onto LUT texel centers so that
		// pure black/white hit the first/last texel exactly. Without this the
		// extremes sample past the grid and shift in hue.
		let n = proofUniforms.lutSize;
		let lutCoord = straight * ((n - 1.0) / n) + vec3f(0.5 / n);

		// Trilinear interpolation. Explicit LOD because textureSample is not
		// allowed after the non-uniform early return above.
		let proofed = textureSampleLevel(lutTexture, lutSampler, lutCoord, 0.0).rgb;

		// Re-premultiply for the premultiplied canvas alpha mode.
		return vec4f(proofed * alpha, alpha);
	}
`;

/**
 * Simple Blit Shader - Copy texture with automatic format conversion
 * Used for copying regions with format conversion (e.g., bgra8unorm → rgba8unorm)
 * Renders a fullscreen triangle in NDC space (no world coord transformation)
 */

export const SIMPLE_BLIT_SHADER = /* wgsl */ `
	@group(0) @binding(0) var texSampler: sampler;
	@group(0) @binding(1) var sourceTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var output: VertexOutput;

		// Fullscreen triangle in NDC space (-1 to 1)
		// This covers the entire viewport with just 3 vertices
		var positions = array<vec2f, 3>(
			vec2f(-1.0, -1.0),  // bottom-left
			vec2f(3.0, -1.0),   // way off to the right
			vec2f(-1.0, 3.0),   // way off to the top
		);

		// Texture coordinates (0,0 = top-left, 1,1 = bottom-right)
		var texCoords = array<vec2f, 3>(
			vec2f(0.0, 1.0),
			vec2f(2.0, 1.0),
			vec2f(0.0, -1.0),
		);

		output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
		output.texCoord = texCoords[vertexIndex];

		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		return textureSample(sourceTexture, texSampler, input.texCoord);
	}
`;

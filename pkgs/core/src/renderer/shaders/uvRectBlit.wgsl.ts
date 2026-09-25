/**
 * Fullscreen blit of a sub-rect of a texture over the current viewport.
 *
 * The generic counterpart of SIMPLE_BLIT_SHADER for callers that cannot map
 * the whole source: a draw whose destination rect runs past the attachment has
 * to be clamped, and the source uv must shrink with it or the image squeezes
 * into the visible part. The blend mode is the pipeline's business, so
 * destination-over (drawing beneath what is already there) and plain over both
 * use this same module.
 *
 * Bind group: 0 = uniforms (uvRect), 1 = sampler, 2 = source texture.
 */
export const UV_RECT_BLIT_SHADER = /* wgsl */ `
	struct Uniforms {
		// Sub-rect of the source to map over the viewport (minU, minV, maxU, maxV).
		uvRect: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var samp: sampler;
	@group(0) @binding(2) var srcTex: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) uv: vec2f,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
		var pos = array<vec2f, 3>(
			vec2f(-1.0, -1.0),
			vec2f(3.0, -1.0),
			vec2f(-1.0, 3.0),
		);
		var out: VertexOutput;
		let p = pos[vi];
		out.position = vec4f(p, 0.0, 1.0);
		out.uv = vec2f((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
		return out;
	}

	@fragment
	fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
		let uv = mix(uniforms.uvRect.xy, uniforms.uvRect.zw, in.uv);
		return textureSampleLevel(srcTex, samp, uv, 0.0);
	}
`;

import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

export const SVG_OFFSET_SHADER = /* wgsl */ `
	struct Uniforms {
		// Whole-texel shift in texture space (Y down).
		offset: vec2i,
		inputMode: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy)) - uniforms.offset;
		return fetchInput(inputTexture, p, uniforms.inputMode);
	}
`;

import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/**
 * feDropShadow compose: the blurred alpha read at the offset position,
 * tinted with the flood color, then the original input composited over
 * that shadow.
 */
export const SVG_DROP_SHADOW_COMPOSE_SHADER = /* wgsl */ `
	struct Uniforms {
		// Whole-texel shift in texture space (Y down).
		offset: vec2i,
		inputMode: u32,
		// Premultiplied flood color already scaled by flood-opacity.
		color: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var blurredAlphaTexture: texture_2d<f32>;
	@group(0) @binding(2) var inputTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		let shadow = uniforms.color * fetchOrZero(blurredAlphaTexture, p - uniforms.offset).a;
		let source = fetchInput(inputTexture, p, uniforms.inputMode);
		return source + shadow * (1.0 - source.a);
	}
`;

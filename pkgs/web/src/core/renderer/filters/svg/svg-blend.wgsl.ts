import { BLEND_MODE_FUNCTIONS_WGSL } from "../../shaders/blendModes.wgsl";
import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_PREMULTIPLY_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/**
 * feBlend: Compositing-1 blending of `in` (source) over `in2` (backdrop).
 * The blend functions work on straight rgb, so both inputs are
 * unpremultiplied around the blend and the result is re-premultiplied.
 */
export const SVG_BLEND_SHADER = /* wgsl */ `
	struct Uniforms {
		mode: u32,
		inputMode: u32,
		input2Mode: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;
	@group(0) @binding(2) var input2Texture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_PREMULTIPLY_WGSL}
	${SVG_TEXEL_FETCH_WGSL}
	${BLEND_MODE_FUNCTIONS_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		let source = unpremultiply(fetchInput(inputTexture, p, uniforms.inputMode));
		let backdrop = unpremultiply(fetchInput(input2Texture, p, uniforms.input2Mode));
		let alphaS = source.a;
		let alphaB = backdrop.a;
		let blended = applyBlendMode(backdrop.rgb, source.rgb, uniforms.mode);
		let rgb = (1.0 - alphaB) * alphaS * source.rgb
			+ alphaB * alphaS * blended
			+ (1.0 - alphaS) * alphaB * backdrop.rgb;
		return vec4f(rgb, alphaS + alphaB * (1.0 - alphaS));
	}
`;

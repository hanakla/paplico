import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/**
 * feComposite: Porter-Duff on premultiplied texels, `in` (i1) on top of
 * `in2` (i2). The arithmetic operator is clamped back into a valid
 * premultiplied color as the spec requires.
 */
export const SVG_COMPOSITE_SHADER = /* wgsl */ `
	struct Uniforms {
		// Index into the operator order: over, in, out, atop, xor, arithmetic.
		op: u32,
		inputMode: u32,
		input2Mode: u32,
		k: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;
	@group(0) @binding(2) var input2Texture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		let i1 = fetchInput(inputTexture, p, uniforms.inputMode);
		let i2 = fetchInput(input2Texture, p, uniforms.input2Mode);
		switch uniforms.op {
			case 1u: {
				return i1 * i2.a;
			}
			case 2u: {
				return i1 * (1.0 - i2.a);
			}
			case 3u: {
				return i1 * i2.a + i2 * (1.0 - i1.a);
			}
			case 4u: {
				return i1 * (1.0 - i2.a) + i2 * (1.0 - i1.a);
			}
			case 5u: {
				let k = uniforms.k;
				let r = clamp(k.x * i1 * i2 + k.y * i1 + k.z * i2 + vec4f(k.w), vec4f(0.0), vec4f(1.0));
				return vec4f(min(r.rgb, vec3f(r.a)), r.a);
			}
			default: {
				return i1 + i2 * (1.0 - i1.a);
			}
		}
	}
`;

import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/**
 * One separable feMorphology pass: per-channel min (erode) or max (dilate)
 * over premultiplied texels within `radius` along `direction`. Taps outside
 * the texture are skipped rather than read as transparent, which is how
 * resvg and Skia treat the filter region edge — an erode must not eat into a
 * flood that fills the whole region.
 */
export const SVG_MORPHOLOGY_SHADER = /* wgsl */ `
	const OPERATOR_ERODE = 0u;

	struct Uniforms {
		direction: vec2i,
		radius: i32,
		op: u32,
		inputMode: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		let dim = vec2i(textureDimensions(inputTexture));
		var result = fetchInput(inputTexture, p, uniforms.inputMode);
		for (var i = -uniforms.radius; i <= uniforms.radius; i = i + 1) {
			let q = p + uniforms.direction * i;
			if (q.x < 0 || q.y < 0 || q.x >= dim.x || q.y >= dim.y) {
				continue;
			}
			let c = fetchInput(inputTexture, q, uniforms.inputMode);
			result = select(max(result, c), min(result, c), uniforms.op == OPERATOR_ERODE);
		}
		return result;
	}
`;

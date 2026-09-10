import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_PREMULTIPLY_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/** Largest kernel order the pass supports; the uniform holds order squared weights. */
export const SVG_CONVOLVE_ORDER_MAX = 7;

/** Kernel weights packed four per vec4f. */
export const SVG_CONVOLVE_KERNEL_VEC4_COUNT = Math.ceil(
	SVG_CONVOLVE_ORDER_MAX ** 2 / 4,
);

/**
 * feConvolveMatrix. The kernel is applied rotated by 180 degrees as the spec
 * formula demands: the source texel at (x - target + j, y - target + i)
 * meets kernel entry (order - 1 - i, order - 1 - j). Taps are one world px
 * apart, so at higher rasterization scales they step several texels.
 */
export const SVG_CONVOLVE_MATRIX_SHADER = /* wgsl */ `
	const EDGE_DUPLICATE = 0u;
	const EDGE_WRAP = 1u;

	struct Uniforms {
		order: i32,
		divisor: f32,
		bias: f32,
		edgeMode: u32,
		preserveAlpha: u32,
		inputMode: u32,
		// Texels per kernel cell (the rasterization scale).
		kernelUnit: f32,
		// Row-major kernel weights packed four per vec4f.
		kernel: array<vec4f, ${SVG_CONVOLVE_KERNEL_VEC4_COUNT}>,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_PREMULTIPLY_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	fn kernelWeight(index: i32) -> f32 {
		return uniforms.kernel[index / 4][index % 4];
	}

	fn wrapCoord(v: i32, size: i32) -> i32 {
		return ((v % size) + size) % size;
	}

	fn fetchEdge(p: vec2i) -> vec4f {
		let dim = vec2i(textureDimensions(inputTexture));
		if (uniforms.edgeMode == EDGE_DUPLICATE) {
			return fetchInput(inputTexture, clamp(p, vec2i(0), dim - vec2i(1)), uniforms.inputMode);
		}
		if (uniforms.edgeMode == EDGE_WRAP) {
			return fetchInput(inputTexture, vec2i(wrapCoord(p.x, dim.x), wrapCoord(p.y, dim.y)), uniforms.inputMode);
		}
		return fetchInput(inputTexture, p, uniforms.inputMode);
	}

	fn fetchSample(p: vec2i) -> vec4f {
		let c = fetchEdge(p);
		return select(c, unpremultiply(c), uniforms.preserveAlpha == 1u);
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		let order = uniforms.order;
		let reach = order / 2;
		var sum = vec4f(0.0);
		for (var i = 0; i < order; i = i + 1) {
			for (var j = 0; j < order; j = j + 1) {
				let w = kernelWeight((order - 1 - i) * order + (order - 1 - j));
				let tap = vec2i(round(vec2f(f32(j - reach), f32(i - reach)) * uniforms.kernelUnit));
				sum += fetchSample(p + tap) * w;
			}
		}
		let center = fetchEdge(p);
		let scaled = sum / uniforms.divisor;
		if (uniforms.preserveAlpha == 1u) {
			let rgb = clamp(scaled.rgb + uniforms.bias * center.a, vec3f(0.0), vec3f(1.0));
			return premultiply(vec4f(rgb, center.a));
		}
		// The spec adds bias to the alpha result as is, and to the premultiplied
		// color scaled by that resulting alpha.
		let alpha = clamp(scaled.a + uniforms.bias, 0.0, 1.0);
		let rgb = clamp(scaled.rgb + uniforms.bias * alpha, vec3f(0.0), vec3f(alpha));
		return vec4f(rgb, alpha);
	}
`;

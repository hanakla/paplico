import {
	SVG_FULLSCREEN_VERTEX_WGSL,
	SVG_TEXEL_FETCH_WGSL,
} from "./svg-wgsl-includes";

/**
 * One separable Gaussian pass over premultiplied texels. Taps run to 3σ on
 * each side; sigma <= 0 degenerates to a copy (still applying the input mode).
 */
export const SVG_GAUSSIAN_BLUR_SHADER = /* wgsl */ `
	struct Uniforms {
		direction: vec2i,
		sigma: f32,
		inputMode: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let p = vec2i(floor(input.position.xy));
		if (uniforms.sigma <= 0.0) {
			return fetchInput(inputTexture, p, uniforms.inputMode);
		}
		let radius = i32(ceil(uniforms.sigma * 3.0));
		let denom = 2.0 * uniforms.sigma * uniforms.sigma;
		var sum = vec4f(0.0);
		var weightSum = 0.0;
		for (var i = -radius; i <= radius; i = i + 1) {
			let w = exp(-f32(i * i) / denom);
			sum += fetchInput(inputTexture, p + uniforms.direction * i, uniforms.inputMode) * w;
			weightSum += w;
		}
		return sum / weightSum;
	}
`;

/**
 * Box-averages `stride` x `stride` blocks of the input into a smaller
 * texture, applying the input mode; blocks past the input edge average in
 * transparent black like every other read outside the filter region. The
 * first block starts at `phase` (in (-stride, 0]) so the block grid stays
 * anchored to the filter region rather than to the texture.
 */
export const SVG_BLUR_DOWNSAMPLE_SHADER = /* wgsl */ `
	struct Uniforms {
		stride: vec2i,
		phase: vec2i,
		inputMode: u32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let origin = vec2i(floor(input.position.xy)) * uniforms.stride + uniforms.phase;
		var sum = vec4f(0.0);
		for (var y = 0; y < uniforms.stride.y; y = y + 1) {
			for (var x = 0; x < uniforms.stride.x; x = x + 1) {
				sum += fetchInput(inputTexture, origin + vec2i(x, y), uniforms.inputMode);
			}
		}
		return sum / f32(uniforms.stride.x * uniforms.stride.y);
	}
`;

/** Bilinear upsample of a `stride`-times smaller texture back to the target. */
export const SVG_BLUR_UPSAMPLE_SHADER = /* wgsl */ `
	struct Uniforms {
		stride: vec2i,
		phase: vec2i,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;

	${SVG_FULLSCREEN_VERTEX_WGSL}
	${SVG_TEXEL_FETCH_WGSL}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		// Texel centers of the small texture sit at phase + (i + 0.5) * stride.
		let q = (input.position.xy - vec2f(uniforms.phase)) / vec2f(uniforms.stride) - 0.5;
		let base = vec2i(floor(q));
		let t = q - vec2f(base);
		let c00 = fetchOrZero(inputTexture, base);
		let c10 = fetchOrZero(inputTexture, base + vec2i(1, 0));
		let c01 = fetchOrZero(inputTexture, base + vec2i(0, 1));
		let c11 = fetchOrZero(inputTexture, base + vec2i(1, 1));
		return mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
	}
`;

/**
 * Blur pyramid downsample shader (BlurPyramidBuilder).
 *
 * Builds one level of a calibrated Gaussian pyramid: each level halves one
 * axis (run once horizontally, once vertically per level) while applying a
 * separable Gaussian of PYRAMID_PASS_SIGMA source texels, so every level's
 * cumulative effective sigma is known analytically (variances add across
 * passes). Different blur radii then interpolate between two adjacent levels
 * instead of each running its own full-resolution blur.
 *
 * Pool textures are size-quantized, so both source and destination may be
 * larger than their used region. The destination pass sets a viewport over
 * its used region and derives the shared "region uv" from the fragment
 * position; source samples are scaled/clamped into the source's used region
 * (`srcCtl`), mirroring the meshUvRect clamp idiom in the refraction shader.
 *
 * Linear-sampled tap pairing matches the legacy full-resolution blur: adjacent
 * taps fold into one bilinear fetch at the weight-interpolated offset.
 */
export const BLUR_PYRAMID_SHADER = /* wgsl */ `
	struct Uniforms {
		// xy: destination used size (px), zw: blur axis step in source-texture
		// uv per source texel (axis / quantized source size).
		dstSizeStep: vec4f,
		// xy: source used-area uv scale (used / quantized), zw: half texel of
		// the used region in region uv (0.5 / used size) for edge clamping.
		srcCtl: vec4f,
		// x: Gaussian sigma in source texels.
		params: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var samp: sampler;
	@group(0) @binding(2) var src: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
		var pos = array<vec2f, 3>(
			vec2f(-1.0, -1.0),
			vec2f(3.0, -1.0),
			vec2f(-1.0, 3.0),
		);
		var out: VertexOutput;
		out.position = vec4f(pos[vi], 0.0, 1.0);
		return out;
	}

	// Sample the source at a region-uv position, clamped into its used area
	// (quantized pool textures have garbage past the used region).
	fn sampleSrc(regionUv: vec2f) -> vec4f {
		let clamped = clamp(
			regionUv,
			uniforms.srcCtl.zw,
			vec2f(1.0) - uniforms.srcCtl.zw,
		);
		return textureSampleLevel(src, samp, clamped * uniforms.srcCtl.xy, 0.0);
	}

	@fragment
	fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
		// The viewport restricts rendering to the destination's used region, so
		// the fragment position over dstSize is the shared region uv.
		let regionUv = in.position.xy / uniforms.dstSizeStep.xy;
		let sigma = uniforms.params.x;
		if (sigma <= 0.0) {
			return sampleSrc(regionUv);
		}
		// Blur offsets live in source-texture uv; convert back to region uv via
		// srcCtl.xy so sampleSrc's clamp-then-scale lands on the right texels.
		let stepRegion = uniforms.dstSizeStep.zw / uniforms.srcCtl.xy;
		let radius = i32(ceil(sigma * 3.0));
		let inv = 1.0 / (2.0 * sigma * sigma);
		var sum = sampleSrc(regionUv);
		var total = 1.0;
		// Paired bilinear taps, identical scheme to the legacy blur: bounded
		// uniform loop, breaks past the radius.
		for (var k = 1; k <= 24; k = k + 1) {
			let a = 2 * k - 1;
			if (a > radius) { break; }
			let b = a + 1;
			let wa = exp(-f32(a * a) * inv);
			let wb = select(0.0, exp(-f32(b * b) * inv), b <= radius);
			let w = wa + wb;
			let off = (f32(a) * wa + f32(b) * wb) / w;
			let o = off * stepRegion;
			sum += sampleSrc(regionUv + o) * w;
			sum += sampleSrc(regionUv - o) * w;
			total += 2.0 * w;
		}
		return sum / total;
	}
`;

/**
 * Direct separable Gaussian evaluation for dirty pyramid tiles. It produces
 * the same downsampled level as the horizontal + vertical passes, but avoids
 * materializing the horizontal intermediate for a small changed region.
 */
export const BLUR_PYRAMID_FUSED_SHADER = /* wgsl */ `
	struct Uniforms {
		// xy: destination used size (px). zw is unused by this variant.
		dstSizeStep: vec4f,
		// xy: source used-area uv scale (used / quantized), zw: half texel of
		// the used region in region uv (0.5 / used size) for edge clamping.
		srcCtl: vec4f,
		// x: Gaussian sigma in source texels.
		params: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var samp: sampler;
	@group(0) @binding(2) var src: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
		var pos = array<vec2f, 3>(
			vec2f(-1.0, -1.0),
			vec2f(3.0, -1.0),
			vec2f(-1.0, 3.0),
		);
		var out: VertexOutput;
		out.position = vec4f(pos[vi], 0.0, 1.0);
		return out;
	}

	fn sampleSrc(regionUv: vec2f) -> vec4f {
		let clamped = clamp(
			regionUv,
			uniforms.srcCtl.zw,
			vec2f(1.0) - uniforms.srcCtl.zw,
		);
		return textureSampleLevel(src, samp, clamped * uniforms.srcCtl.xy, 0.0);
	}

	// A paired bilinear sample for one axis. Index 0 is the center; each pair
	// after it represents symmetric positive / negative weighted tap pairs.
	fn axisTap(index: i32, sigma: f32) -> vec2f {
		if (index == 0) {
			return vec2f(0.0, 1.0);
		}
		let pair = (index + 1) / 2;
		let a = 2 * pair - 1;
		let b = a + 1;
		let radius = i32(ceil(sigma * 3.0));
		if (a > radius) {
			return vec2f(0.0);
		}
		let inv = 1.0 / (2.0 * sigma * sigma);
		let wa = exp(-f32(a * a) * inv);
		let wb = select(0.0, exp(-f32(b * b) * inv), b <= radius);
		let weight = wa + wb;
		let offset = (f32(a) * wa + f32(b) * wb) / weight;
		let sign = select(-1.0, 1.0, index % 2 == 1);
		return vec2f(sign * offset, weight);
	}

	@fragment
	fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
		let regionUv = in.position.xy / uniforms.dstSizeStep.xy;
		let sigma = uniforms.params.x;
		if (sigma <= 0.0) {
			return sampleSrc(regionUv);
		}
		let sourceSize = vec2f(textureDimensions(src));
		let stepRegion = (1.0 / sourceSize) / uniforms.srcCtl.xy;
		var sum = vec4f(0.0);
		var total = 0.0;
		for (var y = 0; y < 7; y = y + 1) {
			let yTap = axisTap(y, sigma);
			for (var x = 0; x < 7; x = x + 1) {
				let xTap = axisTap(x, sigma);
				let weight = xTap.y * yTap.y;
				sum += sampleSrc(
					regionUv + vec2f(xTap.x, yTap.x) * stepRegion,
				) * weight;
				total += weight;
			}
		}
		return sum / total;
	}
`;

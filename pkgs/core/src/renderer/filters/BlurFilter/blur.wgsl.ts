/**
 * Gaussian Blur Filter Shader
 * Two-pass separable blur for performance
 */

export const BLUR_SHADER = /* wgsl */ `
	struct Uniforms {
		resolution: vec2f,
		direction: vec2f, // (1, 0) for horizontal, (0, 1) for vertical
		radius: f32,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var inputTexture: texture_2d<f32>;
	@group(0) @binding(2) var inputSampler: sampler;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
	}

	// Fullscreen quad vertex shader
	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var output: VertexOutput;

		// Generate fullscreen triangle
		let x = f32((vertexIndex & 1u) << 1u);
		let y = f32(vertexIndex & 2u);

		output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
		output.texCoord = vec2f(x, y);

		return output;
	}

	// Standard Gaussian blur for premultiplied alpha textures.
	// Premultiplied alpha is a linear color space, so separable 2-pass
	// Gaussian blur is mathematically correct with simple weighted sum.
	// Adjacent tap pairs are merged into single bilinear samples (the
	// sampler is linear), halving texture reads with identical output.
	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let texelSize = 1.0 / uniforms.resolution;
		let offset = uniforms.direction * texelSize;

		let kernelSize = i32(ceil(uniforms.radius * 2.0)) | 1;
		let halfKernel = kernelSize / 2;

		let sigma = uniforms.radius / 2.0;
		let sigma2 = sigma * sigma;

		var colorSum = textureSample(inputTexture, inputSampler, input.texCoord);
		var totalWeight = 1.0;

		for (var i = 1; i <= halfKernel; i = i + 2) {
			let w1 = exp(-f32(i * i) / (2.0 * sigma2));
			if (i + 1 <= halfKernel) {
				let w2 = exp(-f32((i + 1) * (i + 1)) / (2.0 * sigma2));
				let w = w1 + w2;
				let t = (f32(i) * w1 + f32(i + 1) * w2) / w;

				colorSum += textureSample(inputTexture, inputSampler, input.texCoord + t * offset) * w;
				colorSum += textureSample(inputTexture, inputSampler, input.texCoord - t * offset) * w;
				totalWeight += 2.0 * w;
			} else {
				// Odd tail tap: sample it alone so the tap set (and thus the
				// output) stays exactly the pre-optimization kernel.
				colorSum += textureSample(inputTexture, inputSampler, input.texCoord + f32(i) * offset) * w1;
				colorSum += textureSample(inputTexture, inputSampler, input.texCoord - f32(i) * offset) * w1;
				totalWeight += 2.0 * w1;
			}
		}

		return colorSum / totalWeight;
	}
`;

/**
 * Wide-radius blur resolve.
 *
 * Reads the two levels of a calibrated Gaussian blur pyramid (BlurPyramid)
 * that bracket the blur's sigma and lerps them with the variance-space mix
 * factor. Cost is flat in the radius, where BLUR_SHADER grows 2·radius+1
 * taps per axis; the processor routes radii past PYRAMID_BLUR_MIN_RADIUS
 * here.
 */
export const BLUR_PYRAMID_RESOLVE_SHADER = /* wgsl */ `
	struct Uniforms {
		// x: variance-calibrated lerp between the lo and hi levels.
		control: vec4f,
		// Used-area sampling ctl per level: xy = used/quantized uv scale,
		// zw = half texel of the used region (clamp margin).
		loCtl: vec4f,
		hiCtl: vec4f,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(0) @binding(1) var samp: sampler;
	@group(0) @binding(2) var loTexture: texture_2d<f32>;
	@group(0) @binding(3) var hiTexture: texture_2d<f32>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
	}

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
		var output: VertexOutput;
		let x = f32((vertexIndex & 1u) << 1u);
		let y = f32(vertexIndex & 2u);
		output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
		output.texCoord = vec2f(x, y);
		return output;
	}

	fn sampleLevel(tex: texture_2d<f32>, ctl: vec4f, regionUv: vec2f) -> vec4f {
		let clamped = clamp(regionUv, ctl.zw, vec2f(1.0) - ctl.zw);
		return textureSampleLevel(tex, samp, clamped * ctl.xy, 0.0);
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let lo = sampleLevel(loTexture, uniforms.loCtl, input.texCoord);
		let hi = sampleLevel(hiTexture, uniforms.hiCtl, input.texCoord);
		return mix(lo, hi, uniforms.control.x);
	}
`;

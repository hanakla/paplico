export const HK_KIRAKIRA_VERTICAL_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	radius: f32,
	strength: f32,
	sparkle: f32,
	sparkleAlpha: f32,
	blendOpacity: f32,
	makeOriginalTransparent: f32,
	useCustomColor: f32,
	customColor: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;

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

fn gaussianWeight(offset: f32, sigma: f32) -> f32 {
	let gaussianExp = -0.5 * (offset * offset) / (sigma * sigma);
	return exp(gaussianExp) / (2.5066282746 * sigma);
}

// Samples are premultiplied; custom color mode swaps in the custom rgb
// premultiplied by the sample's coverage to stay in the same space.
fn blurSample(sampleColor: vec4f) -> vec4f {
	if (uniforms.useCustomColor > 0.5) {
		return vec4f(uniforms.customColor.rgb * sampleColor.a, sampleColor.a);
	}
	return sampleColor;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	let radiusScaled = uniforms.radius * dpiScale;
	let sigma = radiusScaled * 0.33 * uniforms.strength;

	let intermediateColor = textureSample(inputTexture, inputSampler, texCoord);

	if (sigma <= 0.0) {
		return intermediateColor;
	}

	// Plain weighted mean of premultiplied samples is the correct
	// premultiplied result; the previous alpha-weighted rgb normalization
	// emitted straight-alpha rgb that whitened translucent glow edges.
	let centerWeight = gaussianWeight(0.0, sigma);
	var result = blurSample(intermediateColor) * centerWeight;
	var totalWeight = centerWeight;

	let pixelStep = vec2f(0.0, 1.0 / dims.y);
	// Gaussian weights beyond 3 sigma are negligible, so truncate the
	// kernel there (sigma shrinks with strength while radiusScaled does
	// not). Adjacent tap pairs are merged into single bilinear samples
	// (the sampler is linear), halving texture reads.
	let kernelRadius = i32(ceil(min(radiusScaled, sigma * 3.0)));

	for (var i = 1; i <= kernelRadius; i = i + 2) {
		let w1 = gaussianWeight(f32(i), sigma);
		let w2 = gaussianWeight(f32(i + 1), sigma);
		let w = w1 + w2;
		let t = (f32(i) * w1 + f32(i + 1) * w2) / w;

		let samplePos = textureSample(inputTexture, inputSampler, texCoord + pixelStep * t);
		let sampleNeg = textureSample(inputTexture, inputSampler, texCoord - pixelStep * t);

		result += (blurSample(samplePos) + blurSample(sampleNeg)) * w;
		totalWeight += w * 2.0;
	}

	return result / totalWeight;
}
`;

export const HK_KIRAKIRA_HORIZONTAL_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	radius: f32,
	strength: f32,
	sparkle: f32,
	sparkleAlpha: f32,
	blendOpacity: f32,
	makeOriginalTransparent: f32,
	useCustomColor: f32,
	customColor: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var originalTexture: texture_2d<f32>;
@group(0) @binding(3) var inputSampler: sampler;

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

fn gaussianWeight(offset: f32, sigma: f32) -> f32 {
	let gaussianExp = -0.5 * (offset * offset) / (sigma * sigma);
	return exp(gaussianExp) / (2.5066282746 * sigma);
}

// Samples are premultiplied; custom color mode swaps in the custom rgb
// premultiplied by the sample's coverage to stay in the same space.
fn blurSample(sampleColor: vec4f) -> vec4f {
	if (uniforms.useCustomColor > 0.5) {
		return vec4f(uniforms.customColor.rgb * sampleColor.a, sampleColor.a);
	}
	return sampleColor;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	let originalColor = textureSample(originalTexture, inputSampler, texCoord);

	let radiusScaled = uniforms.radius * dpiScale;
	let sigma = radiusScaled * 0.33 * uniforms.strength;

	let intermediateColor = textureSample(inputTexture, inputSampler, texCoord);

	if (sigma <= 0.0) {
		return originalColor;
	}

	// Plain weighted mean of premultiplied samples is the correct
	// premultiplied result; the previous alpha-weighted rgb normalization
	// emitted straight-alpha rgb that whitened translucent glow edges.
	let centerWeight = gaussianWeight(0.0, sigma);
	var result = blurSample(intermediateColor) * centerWeight;
	var totalWeight = centerWeight;

	let pixelStep = vec2f(1.0 / dims.x, 0.0);
	// Gaussian weights beyond 3 sigma are negligible, so truncate the
	// kernel there (sigma shrinks with strength while radiusScaled does
	// not). Adjacent tap pairs are merged into single bilinear samples
	// (the sampler is linear), halving texture reads.
	let kernelRadius = i32(ceil(min(radiusScaled, sigma * 3.0)));

	for (var i = 1; i <= kernelRadius; i = i + 2) {
		let w1 = gaussianWeight(f32(i), sigma);
		let w2 = gaussianWeight(f32(i + 1), sigma);
		let w = w1 + w2;
		let t = (f32(i) * w1 + f32(i + 1) * w2) / w;

		let samplePos = textureSample(inputTexture, inputSampler, texCoord + pixelStep * t);
		let sampleNeg = textureSample(inputTexture, inputSampler, texCoord - pixelStep * t);

		result += (blurSample(samplePos) + blurSample(sampleNeg)) * w;
		totalWeight += w * 2.0;
	}

	var finalColor = result / totalWeight;

	// Apply sparkle effect (sparkle 0-2 amplifies values up to 3x)
	let sparkleMultiplier = 1.0 + uniforms.sparkle;
	let sparkleAlphaMultiplier = 1.0 + uniforms.sparkle * uniforms.sparkleAlpha;

	// finalColor is premultiplied, so blendOpacity scales rgb and alpha
	// together; fading alpha alone would leave over-bright straight rgb.
	let sparkledColor = vec4f(
		finalColor.rgb * sparkleMultiplier,
		finalColor.a * sparkleAlphaMultiplier,
	) * uniforms.blendOpacity;

	// Adjust alpha based on makeOriginalTransparent setting
	if (uniforms.makeOriginalTransparent > 0.5) {
		// Scale the premultiplied sparkle by the original's inverse
		// coverage: zeroing alpha alone left premultiplied rgb behind,
		// which composited additively as a faint ghost of the original.
		finalColor = sparkledColor * (1.0 - originalColor.a);
	} else {
		// Premultiplied source-over (original over the glow); the former
		// mix/max approximation under-covered anti-aliased edges and cut
		// a translucent seam along the shape boundary.
		finalColor = originalColor + sparkledColor * (1.0 - originalColor.a);
	}

	return clamp(finalColor, vec4f(0.0), vec4f(1.0));
}
`;

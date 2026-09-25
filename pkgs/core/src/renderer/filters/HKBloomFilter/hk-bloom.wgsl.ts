export const HK_BLOOM_EXTRACT_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	threshold: f32,
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

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;

	let originalColor = textureSample(inputTexture, inputSampler, texCoord);
	let brightness = dot(originalColor.rgb, vec3f(0.299, 0.587, 0.114));

	var extractedColor = vec4f(0.0, 0.0, 0.0, 0.0);
	if (brightness > uniforms.threshold && originalColor.a > 0.0) {
		let factor = (brightness - uniforms.threshold) / (1.0 - uniforms.threshold);
		extractedColor = vec4f(originalColor.rgb * factor, originalColor.a);
	}

	return extractedColor;
}
`;

export const HK_BLOOM_BLUR_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	radius: f32,
	blurStrength: f32,
	direction: vec2f,
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

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let sigma = uniforms.radius * uniforms.blurStrength / 3.0;
	let kernelRadius = i32(uniforms.radius);

	if (sigma <= 0.0) {
		return textureSample(inputTexture, inputSampler, texCoord);
	}

	let pixelStep = uniforms.direction / dims;

	var sum = vec4f(0.0);
	var weightSum = 0.0;

	let centerWeight = gaussianWeight(0.0, sigma);
	let centerColor = textureSample(inputTexture, inputSampler, texCoord);
	sum += centerColor * centerWeight;
	weightSum += centerWeight;

	for (var i = 1; i <= kernelRadius; i++) {
		let offset = f32(i);
		let weight = gaussianWeight(offset, sigma);

		let offsetPos = pixelStep * offset;
		let offsetNeg = -pixelStep * offset;

		let posCoord = texCoord + offsetPos;
		let negCoord = texCoord + offsetNeg;

		let samplePos = textureSample(inputTexture, inputSampler, posCoord);
		let sampleNeg = textureSample(inputTexture, inputSampler, negCoord);

		sum += (samplePos + sampleNeg) * weight;
		weightSum += weight * 2.0;
	}

	return sum / weightSum;
}
`;

export const HK_BLOOM_COMPOSITE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	intensity: f32,
	blendMode: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var originalTexture: texture_2d<f32>;
@group(0) @binding(2) var bloomTexture: texture_2d<f32>;
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

fn overlayBlend(base: vec3f, overlay: vec3f) -> vec3f {
	var result: vec3f;
	for (var i = 0; i < 3; i++) {
		if (base[i] < 0.5) {
			result[i] = 2.0 * base[i] * overlay[i];
		} else {
			result[i] = 1.0 - 2.0 * (1.0 - base[i]) * (1.0 - overlay[i]);
		}
	}
	return result;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;

	let originalColor = textureSample(originalTexture, inputSampler, texCoord);
	let bloomColor = textureSample(bloomTexture, inputSampler, texCoord);

	let scaledBloom = bloomColor.rgb * uniforms.intensity;

	var finalColor: vec4f;
	if (uniforms.blendMode < 0.5) {
		// Normal: additive
		finalColor = vec4f(originalColor.rgb + scaledBloom, originalColor.a);
	} else {
		// Overlay
		finalColor = vec4f(overlayBlend(originalColor.rgb, scaledBloom), originalColor.a);
	}

	return finalColor;
}
`;

import { includeOklabMix } from "./wgsl-includes";

export const HK_DIRECTIONAL_BLUR_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	strength: f32,
	angle: f32,
	opacity: f32,
	blurMode: f32,
	originalEmphasis: f32,
	fadeOut: f32,
	fadeDirection: f32,
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

fn getOffset(angle: f32) -> vec2f {
	let radians = angle * 3.14159 / 180.0;
	return vec2f(cos(radians), sin(radians));
}

fn gaussianWeight(distance: f32, sigma: f32) -> f32 {
	let normalized = distance / sigma;
	return exp(-(normalized * normalized) / 2.0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	let originalColor = textureSample(inputTexture, inputSampler, texCoord);
	let normalizedOpacity = min(uniforms.opacity, 1.0);

	if (uniforms.strength <= 0.0 || uniforms.opacity <= 0.0) {
		return originalColor;
	}

	let adjustedStrength = uniforms.strength * dpiScale;
	let pixelOffset = getOffset(uniforms.angle) * adjustedStrength;
	let texOffset = pixelOffset / dims;

	let numSamples = max(i32(adjustedStrength), 5);

	var blurredSum = vec4f(0.0);
	var totalWeight = 0.0;

	var startSample = -numSamples;
	var endSample = numSamples;

	// blurMode: 0=both, 1=behind, 2=front
	if (uniforms.blurMode > 0.5 && uniforms.blurMode < 1.5) {
		// behind
		startSample = 0;
		endSample = numSamples;
	} else if (uniforms.blurMode > 1.5) {
		// front
		startSample = -numSamples;
		endSample = 0;
	}

	for (var i = startSample; i <= endSample; i++) {
		if (i == 0) {
			blurredSum += originalColor;
			totalWeight += 1.0;
			continue;
		}

		let blurIntensity = 1.5;
		let sampleOffset = f32(i) / f32(numSamples) * blurIntensity;

		let normalizedDistance = f32(abs(i)) / f32(numSamples);
		let baseCoord = texCoord + texOffset * sampleOffset;

		var sampleCoord = baseCoord;
		if (uniforms.fadeOut > 0.0) {
			let scale = max(1.0 - (normalizedDistance * uniforms.fadeOut), 0.01);

			let center = vec2f(0.5, 0.5);
			sampleCoord = center + (baseCoord - center) / scale;

			if (uniforms.fadeDirection != 0.0) {
				let shift = (1.0 - scale) * 0.5 * uniforms.fadeDirection;
				sampleCoord.y += shift;
			}
		}

		sampleCoord = clamp(sampleCoord, vec2f(0.0), vec2f(1.0));
		let sampleColor = textureSample(inputTexture, inputSampler, sampleCoord);

		let sigma = 0.5;
		let weight = gaussianWeight(normalizedDistance, sigma);

		blurredSum += sampleColor * weight;
		totalWeight += weight;
	}

	var finalColor = originalColor;

	if (totalWeight > 0.0) {
		// Samples are premultiplied, so their weighted mean is the correct
		// premultiplied result — no unpremultiply, which blew semi-transparent
		// areas out to white when the straight-alpha rgb hit the compositor.
		let blurredColor = blurredSum / totalWeight;

		finalColor = mixOklabVec4(originalColor, blurredColor, normalizedOpacity);

		let emphasisFactor = uniforms.originalEmphasis * originalColor.a;
		let blendedRGB = mixOklab(finalColor.rgb, originalColor.rgb, emphasisFactor);
		finalColor = vec4f(blendedRGB, finalColor.a);
	}

	return finalColor;
}

${includeOklabMix()}
`;

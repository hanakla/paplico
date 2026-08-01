import { includeOklabMix } from "./wgsl-includes";

export const HK_COLOR_REPLACEMENT_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	preserveLuminance: i32,
	sourceR: f32,
	sourceG: f32,
	sourceB: f32,
	sourceA: f32,
	replacementR: f32,
	replacementG: f32,
	replacementB: f32,
	replacementA: f32,
	featherEdges: f32,
	previewMask: i32,
	mix_amount: f32,
	tolerance: f32,
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

// NOTE: The matrix constants below are written in row-major (reference)
// order, but WGSL matrix constructors are column-major. Multiplying with
// the vector on the LEFT (v * M) applies the transposed matrix, which
// yields the intended row-major math.
fn rgbToOklch(rgb: vec3<f32>) -> vec3<f32> {
	let linearColor = vec3<f32>(
		select(rgb.r / 12.92, pow((rgb.r + 0.055) / 1.055, 2.4), rgb.r <= 0.04045),
		select(rgb.g / 12.92, pow((rgb.g + 0.055) / 1.055, 2.4), rgb.g <= 0.04045),
		select(rgb.b / 12.92, pow((rgb.b + 0.055) / 1.055, 2.4), rgb.b <= 0.04045),
	);

	let lms = linearColor * mat3x3<f32>(
		0.4122214708, 0.5363325363, 0.0514459929,
		0.2119034982, 0.6806995451, 0.1073969566,
		0.0883024619, 0.2817188376, 0.6299787005,
	);

	let lms_pow = vec3<f32>(pow(lms.x, 1.0 / 3.0), pow(lms.y, 1.0 / 3.0), pow(lms.z, 1.0 / 3.0));

	let oklabMatrix = mat3x3<f32>(
		0.2104542553, 0.7936177850, -0.0040720468,
		1.9779984951, -2.4285922050, 0.4505937099,
		0.0259040371, 0.7827717662, -0.8086757660,
	);

	let oklab = lms_pow * oklabMatrix;

	let L = oklab.x;
	let C = sqrt(oklab.y * oklab.y + oklab.z * oklab.z);
	let H = atan2(oklab.z, oklab.y);

	return vec3<f32>(L, C, H);
}

fn oklchToRgb(lch: vec3<f32>) -> vec3<f32> {
	let L = lch.x;
	let C = lch.y;
	let H = lch.z;

	let a = C * cos(H);
	let b = C * sin(H);

	let oklabInverseMatrix = mat3x3<f32>(
		1.0, 0.3963377774, 0.2158037573,
		1.0, -0.1055613458, -0.0638541728,
		1.0, -0.0894841775, -1.2914855480,
	);

	let lms_pow = vec3<f32>(L, a, b) * oklabInverseMatrix;
	// Plain cubing: pow() is undefined for negative bases, which occur when
	// offset-adjusted colors fall out of gamut
	let lms = lms_pow * lms_pow * lms_pow;

	let lmsToRgbMatrix = mat3x3<f32>(
		4.0767416621, -3.3077115913, 0.2309699292,
		-1.2684380046, 2.6097574011, -0.3413193965,
		-0.0041960863, -0.7034186147, 1.7076147010,
	);

	let linearRgb = lms * lmsToRgbMatrix;

	let rgbResult = vec3<f32>(
		select(12.92 * linearRgb.r, 1.055 * pow(linearRgb.r, 1.0 / 2.4) - 0.055, linearRgb.r <= 0.0031308),
		select(12.92 * linearRgb.g, 1.055 * pow(linearRgb.g, 1.0 / 2.4) - 0.055, linearRgb.g <= 0.0031308),
		select(12.92 * linearRgb.b, 1.055 * pow(linearRgb.b, 1.0 / 2.4) - 0.055, linearRgb.b <= 0.0031308),
	);

	return clamp(rgbResult, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn oklchToOklab(lch: vec3<f32>) -> vec3<f32> {
	return vec3<f32>(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z));
}

// Match by perceptual (OKLab) distance from the source color. tolerance is
// the distance where the match ends; featherAmount (0..1) softens the edge
// inward as a fraction of tolerance.
fn calculateMatchFactor(oklch: vec3f, featherAmount: f32) -> f32 {
	let sourceOklch = rgbToOklch(vec3f(uniforms.sourceR, uniforms.sourceG, uniforms.sourceB));
	let dist = distance(oklchToOklab(oklch), oklchToOklab(sourceOklch));

	// Slider 0..1 maps to OKLab distance 0..0.5: chroma tops out around
	// ~0.33, so a full-scale tolerance would match nearly everything
	let tolerance = max(uniforms.tolerance * 0.5, 1e-4);
	let featherWidth = tolerance * clamp(featherAmount, 0.0, 1.0);
	let innerEdge = tolerance - max(featherWidth, 1e-4);

	return 1.0 - smoothstep(innerEdge, tolerance, dist);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;
	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	if (originalColor.a < 0.01) {
		return originalColor;
	}

	let originalOklch = rgbToOklch(originalColor.rgb);
	let matchFactor = calculateMatchFactor(originalOklch, uniforms.featherEdges);
	var maskColor = vec3f(matchFactor);

	var finalColor = originalColor.rgb;

	if (matchFactor > 0.0) {
		let sourceOklch = rgbToOklch(vec3f(uniforms.sourceR, uniforms.sourceG, uniforms.sourceB));
		let replacementRgb = vec3f(uniforms.replacementR, uniforms.replacementG, uniforms.replacementB);
		let replacementOklch = rgbToOklch(replacementRgb);

		// Recolor to the replacement hue while carrying the pixel's offsets
		// from the source color, so shading and texture survive the swap
		var newOklch = originalOklch;
		newOklch.z = replacementOklch.z;
		newOklch.y = max(originalOklch.y + (replacementOklch.y - sourceOklch.y), 0.0);

		if (uniforms.preserveLuminance == 0) {
			newOklch.x = clamp(originalOklch.x + (replacementOklch.x - sourceOklch.x), 0.0, 1.0);
		}

		let replacedColor = oklchToRgb(newOklch);

		finalColor = mixOklab(originalColor.rgb, replacedColor, uniforms.mix_amount * matchFactor);
	}

	if (uniforms.previewMask != 0) {
		return vec4f(maskColor, originalColor.a);
	} else {
		return vec4f(finalColor, originalColor.a);
	}
}

${includeOklabMix()}
`;

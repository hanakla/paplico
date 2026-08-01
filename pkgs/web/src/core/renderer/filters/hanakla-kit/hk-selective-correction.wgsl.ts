import { includeOklabMix } from "./wgsl-includes";

export const HK_SELECTIVE_CORRECTION_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	blendMode: i32,
	featherEdges: f32,
	previewMask: i32,
	mix_amount: f32,
	useCondition: i32,
	targetHue: f32,
	hueRange: f32,
	saturationMin: f32,
	saturationMax: f32,
	brightnessMin: f32,
	brightnessMax: f32,
	hueShift: f32,
	saturationScale: f32,
	vibrance: f32,
	brightnessScale: f32,
	contrast: f32,
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

fn rgb2hsv(rgb: vec3f) -> vec3f {
	let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
	let p = mix(vec4f(rgb.bg, K.wz), vec4f(rgb.gb, K.xy), step(rgb.b, rgb.g));
	let q = mix(vec4f(p.xyw, rgb.r), vec4f(rgb.r, p.yzx), step(p.x, rgb.r));

	let d = q.x - min(q.w, q.y);
	let e = 1.0e-10;

	return vec3f(
		abs(q.z + (q.w - q.y) / (6.0 * d + e)),
		d / (q.x + e),
		q.x,
	);
}

fn hsv2rgb(hsv: vec3f) -> vec3f {
	let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
	let p = abs(fract(hsv.xxx + K.xyz) * 6.0 - K.www);

	return hsv.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), hsv.y);
}

fn calculateMatchFactor(hsv: vec3f, featherAmount: f32) -> f32 {
	let isFullHueRange = uniforms.hueRange >= 180.0;

	var hueMatch = 0.0;
	if (isFullHueRange) {
		hueMatch = 1.0;
	} else {
		let targetHueNorm = uniforms.targetHue / 360.0;
		let hueRangeNorm = uniforms.hueRange / 360.0;

		var hueDist = abs(hsv.x - targetHueNorm);
		hueDist = min(hueDist, 1.0 - hueDist);

		if (hueDist <= hueRangeNorm) {
			if (featherAmount > 0.0) {
				let featherEdge = hueRangeNorm * featherAmount;
				let innerEdge = hueRangeNorm - featherEdge;

				if (hueDist <= innerEdge) {
					hueMatch = 1.0;
				} else {
					hueMatch = 1.0 - smoothstep(innerEdge, hueRangeNorm, hueDist);
				}
			} else {
				hueMatch = 1.0;
			}
		}
	}

	let isFullSatRange = uniforms.saturationMin <= 0.01 && uniforms.saturationMax >= 0.99;
	var satMatch = 0.0;

	if (isFullSatRange) {
		satMatch = 1.0;
	} else if (hsv.y >= uniforms.saturationMin && hsv.y <= uniforms.saturationMax) {
		let satLowerDist = hsv.y - uniforms.saturationMin;
		let satUpperDist = uniforms.saturationMax - hsv.y;
		let satEdge = (uniforms.saturationMax - uniforms.saturationMin) * featherAmount * 0.5;

		if (satLowerDist >= satEdge && satUpperDist >= satEdge) {
			satMatch = 1.0;
		} else {
			satMatch = min(
				smoothstep(0.0, satEdge, satLowerDist),
				smoothstep(0.0, satEdge, satUpperDist),
			);
		}
	}

	let isFullBrightRange = uniforms.brightnessMin <= 0.01 && uniforms.brightnessMax >= 0.99;
	var brightMatch = 0.0;

	if (isFullBrightRange) {
		brightMatch = 1.0;
	} else if (hsv.z >= uniforms.brightnessMin && hsv.z <= uniforms.brightnessMax) {
		let brightLowerDist = hsv.z - uniforms.brightnessMin;
		let brightUpperDist = uniforms.brightnessMax - hsv.z;
		let brightEdge = (uniforms.brightnessMax - uniforms.brightnessMin) * featherAmount * 0.5;

		if (brightLowerDist >= brightEdge && brightUpperDist >= brightEdge) {
			brightMatch = 1.0;
		} else {
			brightMatch = min(
				smoothstep(0.0, brightEdge, brightLowerDist),
				smoothstep(0.0, brightEdge, brightUpperDist),
			);
		}
	}

	return hueMatch * satMatch * brightMatch;
}

fn adjustColor(hsv: vec3f) -> vec3f {
	var adjustedHsv = hsv;

	// Shift hue
	adjustedHsv.x = fract(adjustedHsv.x + uniforms.hueShift / 360.0);

	// Saturation (neutral at 1.0)
	if (uniforms.saturationScale < 1.0) {
		adjustedHsv.y = adjustedHsv.y * uniforms.saturationScale;
	} else if (uniforms.saturationScale > 1.0) {
		let saturationIncrease = (uniforms.saturationScale - 1.0);
		adjustedHsv.y = adjustedHsv.y + (1.0 - adjustedHsv.y) * saturationIncrease;
	}

	// Vibrance (neutral at 0.0): boosts dull colors more than already-vivid
	// ones, so nothing clips into full saturation
	if (uniforms.vibrance != 0.0) {
		adjustedHsv.y = clamp(
			adjustedHsv.y * (1.0 + uniforms.vibrance * (1.0 - adjustedHsv.y)),
			0.0,
			1.0,
		);
	}

	// Brightness (neutral at 1.0)
	if (uniforms.brightnessScale < 1.0) {
		adjustedHsv.z = adjustedHsv.z * uniforms.brightnessScale;
	} else if (uniforms.brightnessScale > 1.0) {
		let brightnessIncrease = (uniforms.brightnessScale - 1.0);
		adjustedHsv.z = adjustedHsv.z + (1.0 - adjustedHsv.z) * brightnessIncrease;
	}

	var rgb = hsv2rgb(adjustedHsv);

	// Contrast (neutral at 1.0)
	if (uniforms.contrast != 1.0) {
		let mid = vec3f(0.5);
		rgb = mix(mid, rgb, uniforms.contrast);
	}

	return rgb;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;
	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	let originalHsv = rgb2hsv(originalColor.rgb);

	var finalColor = originalColor.rgb;
	var matchFactor = 1.0;

	if (uniforms.useCondition != 0) {
		matchFactor = calculateMatchFactor(originalHsv, uniforms.featherEdges);
	}

	var maskColor = vec3f(0.0);

	if (matchFactor > 0.0) {
		let adjustedRgb = adjustColor(originalHsv);

		if (uniforms.blendMode == 0) {
			// Normal
			finalColor = mix(originalColor.rgb, adjustedRgb, matchFactor);
		} else {
			// Multiply
			var currentColor = originalColor.rgb;
			currentColor = mix(currentColor, adjustedRgb, matchFactor * 0.5);

			let secondHsv = rgb2hsv(currentColor);
			let secondAdjusted = adjustColor(secondHsv);
			finalColor = mix(currentColor, secondAdjusted, matchFactor * 0.5);
		}

		maskColor = vec3f(matchFactor);
	}

	if (uniforms.previewMask != 0) {
		return vec4f(maskColor, originalColor.a);
	} else {
		let mixedColor = mixOklab(originalColor.rgb, finalColor, uniforms.mix_amount);
		return vec4f(mixedColor, originalColor.a);
	}
}

${includeOklabMix()}
`;

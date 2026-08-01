export const HK_COMIC_TONE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	toneType: f32,
	colorMode: f32,
	size: f32,
	spacing: f32,
	angle: f32,
	threshold: f32,
	reversePattern: f32,
	showOriginalUnderDots: f32,
	useLuminance: f32,
	luminanceStrength: f32,
	invertDotSize: f32,
	toneColorR: f32,
	toneColorG: f32,
	toneColorB: f32,
	toneColorA: f32,
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

// Constants for tone type
const TONE_DOT = 0;
const TONE_LINE = 1;
const TONE_CROSSHATCH = 2;

// Constants for color mode
const COLOR_ORIGINAL = 0;
const COLOR_MONOCHROME = 1;

fn mod_f32(x: f32, y: f32) -> f32 {
	return x - y * floor(x / y);
}

fn createLinePattern(pos: vec2f, size: f32, spacing: f32, angleRad: f32) -> f32 {
	let rotatedPos = vec2f(
		pos.x * cos(angleRad) - pos.y * sin(angleRad),
		pos.x * sin(angleRad) + pos.y * cos(angleRad)
	);
	let modPos = abs(mod_f32(rotatedPos.y, spacing));
	return smoothstep(size, size - 1.0, modPos);
}

fn createCrosshatchPattern(pos: vec2f, size: f32, spacing: f32, angleRad: f32) -> f32 {
	let pattern1 = createLinePattern(pos, size, spacing, angleRad);
	let pattern2 = createLinePattern(pos, size, spacing, angleRad + 1.5708);
	return max(pattern1, pattern2);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	// Handle straight alpha
	var straightRgb = originalColor.rgb;
	if (originalColor.a > 0.001) {
		straightRgb = straightRgb / originalColor.a;
	}

	// Calculate brightness using straight RGB
	let brightness = (straightRgb.r + straightRgb.g + straightRgb.b) / 3.0;

	// Apply DPI scaling to size and spacing
	var scaledSize = uniforms.size * dpiScale;
	let scaledSpacing = uniforms.spacing * dpiScale;

	// Adjust size based on luminance if enabled
	if (uniforms.useLuminance > 0.5) {
		var luminanceEffect = brightness;

		if (uniforms.invertDotSize > 0.5) {
			luminanceEffect = 1.0 - luminanceEffect;
		}

		let sizeFactor = mix(0.2, 2.0, luminanceEffect);
		scaledSize = scaledSize * mix(1.0, sizeFactor, uniforms.luminanceStrength);
	}

	let angleRad = uniforms.angle * 3.14159265359 / 180.0;
	let pixelPos = texCoord * dims;

	let toneTypeInt = i32(uniforms.toneType + 0.5);
	let colorModeInt = i32(uniforms.colorMode + 0.5);
	let toneColor = vec4f(uniforms.toneColorR, uniforms.toneColorG, uniforms.toneColorB, uniforms.toneColorA);

	// Generate tone pattern
	var pattern = 0.0;

	if (toneTypeInt == TONE_LINE) {
		pattern = createLinePattern(pixelPos, scaledSize, scaledSpacing, angleRad);
	} else if (toneTypeInt == TONE_CROSSHATCH) {
		pattern = createCrosshatchPattern(pixelPos, scaledSize, scaledSpacing, angleRad);
	}

	// Apply tone value
	var toneValue = pattern;

	if (uniforms.reversePattern > 0.5) {
		toneValue = 1.0 - toneValue;
	}

	// Skip drawing pattern where brightness >= threshold
	if (brightness >= uniforms.threshold) {
		toneValue = 0.0;
	}

	var finalColor: vec4f;

	if (toneTypeInt == TONE_DOT) {
		// Dot pattern processing
		let scaledPos = pixelPos / scaledSpacing;
		let cell = floor(scaledPos);
		let cellCenter = (cell + 0.5) * scaledSpacing;

		let distToDotCenter = distance(pixelPos, cellCenter);
		let baseRadius = scaledSize * 0.5;

		// Sample at dot center
		let dotCenterTexCoord = cellCenter / dims;
		let clampedDotCenter = clamp(dotCenterTexCoord, vec2f(0.0), vec2f(1.0));
		let sampledDotCenter = textureSample(inputTexture, inputSampler, clampedDotCenter);
		let dotInBounds = dotCenterTexCoord.x >= 0.0 && dotCenterTexCoord.x <= 1.0 && dotCenterTexCoord.y >= 0.0 && dotCenterTexCoord.y <= 1.0;

		var finalDotRadius = baseRadius;
		var skipDot = false;
		var dotCenterColor = vec4f(0.0, 0.0, 0.0, 1.0);
		var straightDotRgb = vec3f(0.0);
		var dotCenterBrightness = 0.0;

		if (dotInBounds) {
			dotCenterColor = sampledDotCenter;

			straightDotRgb = dotCenterColor.rgb;
			if (dotCenterColor.a > 0.001) {
				straightDotRgb = straightDotRgb / dotCenterColor.a;
			}

			dotCenterBrightness = (straightDotRgb.r + straightDotRgb.g + straightDotRgb.b) / 3.0;

			if (dotCenterBrightness >= uniforms.threshold) {
				skipDot = true;
			}

			if (!skipDot && uniforms.useLuminance > 0.5) {
				var luminanceEffect = dotCenterBrightness;

				if (uniforms.invertDotSize > 0.5) {
					luminanceEffect = 1.0 - luminanceEffect;
				}

				let sizeFactor = mix(0.5, 1.5, luminanceEffect);
				finalDotRadius = baseRadius * mix(1.0, sizeFactor, uniforms.luminanceStrength);
			}
		}

		let isInsideDot = !skipDot && distToDotCenter < finalDotRadius;

		if (isInsideDot) {
			if (colorModeInt == COLOR_ORIGINAL) {
				var resultAlpha = dotCenterColor.a;
				var resultRgb = vec3f(0.0);

				if (originalColor.a > 0.001 && dotCenterColor.a > 0.001) {
					resultRgb = straightDotRgb * straightRgb;
				}

				finalColor = vec4f(resultRgb * resultAlpha, resultAlpha);
			} else {
				finalColor = vec4f(toneColor.rgb * dotCenterColor.a, dotCenterColor.a);
			}
		} else {
			if (uniforms.showOriginalUnderDots > 0.5) {
				finalColor = originalColor;
			} else {
				finalColor = vec4f(0.0, 0.0, 0.0, 0.0);
			}
		}
	} else {
		// Line / Crosshatch patterns
		let alpha = originalColor.a;

		if (colorModeInt == COLOR_ORIGINAL) {
			if (toneValue > 0.5) {
				finalColor = vec4f(alpha, alpha, alpha, alpha);
			} else {
				finalColor = originalColor;
			}
		} else {
			if (toneValue > 0.5) {
				finalColor = vec4f(alpha, alpha, alpha, alpha);
			} else {
				finalColor = vec4f(toneColor.rgb * alpha, alpha);
			}
		}
	}

	// Apply alpha cutoff from original image
	if (originalColor.a < 0.01) {
		finalColor = vec4f(0.0, 0.0, 0.0, 0.0);
	}

	return finalColor;
}
`;

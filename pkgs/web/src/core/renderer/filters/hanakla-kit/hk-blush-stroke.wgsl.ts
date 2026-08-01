export const HK_BLUSH_STROKE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	angle: f32,
	brushSize: f32,
	strokeLength: f32,
	strokeDensity: f32,
	randomStrength: f32,
	randomSeed: f32,
	blendWithOriginal: f32,
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

fn hash(n: f32) -> f32 {
	return fract(sin(n) * 43758.5453);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	// Original image color
	let originalColor = textureSample(inputTexture, inputSampler, texCoord);

	// Final color (initialized to original)
	var finalColor = originalColor;

	// Random seed
	let seed = uniforms.randomSeed;

	// Convert angle to radians
	let baseAngleRad = uniforms.angle * 3.14159265359 / 180.0;

	// Physical dimension based calculation (DPI-aware)
	let onTex1PxFactor = 1.0 / dpiScale;

	// Grid structure
	let physicalBrushSize = uniforms.brushSize;
	let physicalCellSize = sqrt(physicalBrushSize) * 5.0;

	// Different densities for horizontal and vertical directions
	let baseDensity = 1.0 / (physicalCellSize * dpiScale);
	let densityX = baseDensity;
	let densityY = baseDensity * uniforms.strokeDensity * 1.5;

	// Calculate grid coordinates with different densities
	let gridCoordX = floor(texCoord.x * dims.x * densityX);
	let gridCoordY = floor(texCoord.y * dims.y * densityY);
	let gridCoord = vec2f(gridCoordX, gridCoordY);

	// Scan from bottom to top so upper strokes overwrite lower ones
	for (var dy = -1; dy <= 1; dy++) {
		for (var dx = -1; dx <= 1; dx++) {
			let cellPos = gridCoord + vec2f(f32(dx), f32(dy));

			// Per-stroke random value
			let cellHash = fract(sin(dot(cellPos, vec2f(12.9898, 78.233)) + seed * 0.01) * 43758.5453);

			// Decide whether to draw this cell (density control)
			let cellDrawProb = min(0.95, 0.7 + physicalBrushSize * 0.015) * uniforms.strokeDensity;

			// Pre-compute cellCenter and sample unconditionally (textureSample requires uniform control flow)
			let densityVec = vec2f(densityX, densityY);
			let cellCenter = (cellPos + vec2f(0.5)) / (dims * densityVec);
			let sampledColor = textureSample(inputTexture, inputSampler, cellCenter);

			if (cellHash < cellDrawProb) {

				// Per-cell angle variation
				let angleJitter = (cellHash * 2.0 - 1.0) * 0.6;
				let strokeAngle = baseAngleRad + (angleJitter * uniforms.randomStrength);
				let strokeDir = vec2f(cos(strokeAngle), sin(strokeAngle));

				// Stroke length - constant in physical units
				let physicalStrokeLength = uniforms.strokeLength;
				let pixelStrokeLength = physicalStrokeLength * dpiScale;
				let strokeLen = (pixelStrokeLength * 0.3) / dims.x;

				// Stroke as independent short line segment
				let halfLen = strokeLen * 0.5;
				let strokeStart = cellCenter - strokeDir * halfLen;
				let strokeEnd = cellCenter + strokeDir * halfLen;

				// Distance from pixel to stroke
				let toPixel = texCoord - strokeStart;
				let projLen = dot(toPixel, strokeDir);
				let paramT = clamp(projLen / (strokeLen), 0.0, 1.0);

				// Closest point on stroke
				let closestPt = strokeStart + strokeDir * paramT * strokeLen;

				// Distance to stroke line in physical units
				let distToLine = distance(texCoord, closestPt) * dims.x * onTex1PxFactor;

				// End cap rounding distance
				let distToEnds = min(
					distance(texCoord, strokeStart),
					distance(texCoord, strokeEnd)
				) * dims.x * onTex1PxFactor;

				// Brush width in physical units
				let brushWidth = physicalBrushSize * 0.4;

				// End cap blending
				let endCapT = 0.1;
				let endCapBlend = step(endCapT, paramT) * step(endCapT, 1.0 - paramT);

				// Distance for rounded ends
				let finalDist = mix(distToEnds, distToLine, endCapBlend);

				// Brush shape weight
				let weight = 1.0 - step(brushWidth, finalDist);

				var strokeColor = sampledColor;

				// Subtle color variation
				let colorShift = (fract(cellHash * 456.789) - 0.5) * 0.05;
				strokeColor = vec4f(
					clamp(strokeColor.r + colorShift, 0.0, 1.0),
					clamp(strokeColor.g + colorShift, 0.0, 1.0),
					clamp(strokeColor.b + colorShift, 0.0, 1.0),
					strokeColor.a
				);

				// Blend based on weight
				if (weight > 0.01 && strokeColor.a > 0.001) {
					let opacity = weight * strokeColor.a;
					let newAlpha = opacity + finalColor.a * (1.0 - opacity);

					if (newAlpha > 0.001) {
						let blendedRGB = (strokeColor.rgb * opacity + finalColor.rgb * finalColor.a * (1.0 - opacity)) / newAlpha;
						finalColor = vec4f(blendedRGB, newAlpha);
					}
				}
			}
		}
	}

	// Blend stroke effect with original image
	let blendFactor = uniforms.blendWithOriginal;

	if (blendFactor > 0.001) {
		let targetAlpha = mix(finalColor.a, originalColor.a, blendFactor);

		if (targetAlpha > 0.001) {
			let blendedRgb = mix(finalColor.rgb, originalColor.rgb, blendFactor);
			finalColor = vec4f(blendedRgb, targetAlpha);
		} else {
			finalColor = vec4f(0.0, 0.0, 0.0, 0.0);
		}
	}

	if (finalColor.a < 0.001) {
		if (blendFactor > 0.9) {
			finalColor = originalColor;
		}
	}

	return finalColor;
}
`;

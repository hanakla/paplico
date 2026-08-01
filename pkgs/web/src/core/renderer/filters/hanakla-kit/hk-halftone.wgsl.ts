export const HK_HALFTONE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	size: f32,
	angle: f32,
	placementPattern: f32,
	invertDotSize: f32,
	opaqueOnly: f32,
	colorR: f32,
	colorG: f32,
	colorB: f32,
	colorA: f32,
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

fn rgbToGray(color: vec3f, alpha: f32) -> f32 {
	return dot(color.rgb, vec3f(0.299, 0.587, 0.114)) * alpha;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	let currentPixel = texCoord * dims;

	// Calculate rotation matrices
	let radians = uniforms.angle * 3.14159265359 / 180.0;
	let cosTheta = cos(radians);
	let sinTheta = sin(radians);

	let rotMatrix = mat2x2f(
		cosTheta, sinTheta,
		-sinTheta, cosTheta
	);

	let invRotMatrix = mat2x2f(
		cosTheta, -sinTheta,
		sinTheta, cosTheta
	);

	// Center and rotate current pixel
	let center = dims * 0.5;
	let centered = currentPixel - center;
	let rotated = rotMatrix * centered;
	let rotatedPixel = rotated + center;

	// Calculate cell size in pixels
	let dotSizeScaled = uniforms.size * dpiScale;
	let cellSize = vec2f(dotSizeScaled, dotSizeScaled);

	// Calculate cell coordinates
	let baseCell = rotatedPixel / cellSize;
	var cellX = floor(baseCell.x);
	let cellY = floor(baseCell.y);

	// Apply staggered pattern offset for odd rows
	if (uniforms.placementPattern > 0.5) {
		let isOddRow = (cellY % 2.0) == 1.0;
		if (isOddRow) {
			cellX = floor(baseCell.x + 0.5);
		}
	}

	// Calculate cell origin and position within cell
	let cellOrigin = vec2f(cellX, cellY) * cellSize;
	let posInCell = (rotatedPixel - cellOrigin) / cellSize;

	// Calculate cell center
	let cellCenter = cellOrigin + cellSize * 0.5;

	// Transform cell center back to original space for sampling
	let centeredCellCenter = cellCenter - center;
	let originalCellCenter = invRotMatrix * centeredCellCenter;
	let samplePoint = originalCellCenter + center;

	// Sample original image
	let sampleTexCoord = samplePoint / dims;
	let origColor = textureSample(inputTexture, inputSampler, sampleTexCoord);
	let grayscale = rgbToGray(origColor.rgb, origColor.a);

	// Adjust brightness and calculate dot size
	var toneLevel = grayscale;
	if (uniforms.invertDotSize > 0.5) {
		toneLevel = 1.0 - toneLevel;
	}
	let brightness = clamp(pow(toneLevel, 0.7), 0.0, 0.95);
	let dotScale = 0.4;
	let dotRadius = (1.0 - brightness) * dotScale;
	let minDotRadius = 0.05;
	let finalDotRadius = max(dotRadius, minDotRadius);

	// Calculate distance from center of cell
	let distToCenter = length(posInCell - vec2f(0.5, 0.5));

	// Create circular dot with anti-aliased edge
	let edgeWidth = 0.01;
	let alpha = 1.0 - smoothstep(finalDotRadius - edgeWidth, finalDotRadius + edgeWidth, distToCenter);

	let dotColor = vec3f(uniforms.colorR, uniforms.colorG, uniforms.colorB);
	let dotAlpha = uniforms.colorA;

	// Apply final color
	var finalAlpha = 0.02;
	if (alpha > 0.01) {
		finalAlpha = alpha * dotAlpha;
	}

	// Restrict the tone to the source's opaque coverage
	let sourceAlpha = textureSample(inputTexture, inputSampler, texCoord).a;
	finalAlpha = finalAlpha * mix(1.0, sourceAlpha, uniforms.opaqueOnly);

	return vec4f(dotColor, finalAlpha);
}
`;

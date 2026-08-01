export const HK_WAVE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	amplitude: f32,
	frequency: f32,
	angleRad: f32,
	crossWave: f32,
	time: f32,
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

fn rotate2DAroundOrigin(coord: vec2f, angle: f32) -> vec2f {
	let sinVal = sin(angle);
	let cosVal = cos(angle);
	return vec2f(
		coord.x * cosVal - coord.y * sinVal,
		coord.x * sinVal + coord.y * cosVal,
	);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	// Amplitude scaled by DPI
	let pixelNorm = vec2f(1.0) / dims;
	let amplitudeNorm = pixelNorm * vec2f(uniforms.amplitude * dpiScale);
	let frequency = uniforms.frequency * 3.14159;

	// Normalize coordinates to center
	let centerCoord = texCoord * 2.0 - 1.0;

	// Calculate main wave based on angle
	let rotatedCoord = rotate2DAroundOrigin(centerCoord, uniforms.angleRad);

	// Wave phases
	let wavePhase = rotatedCoord.x * frequency;
	let crossWavePhase = rotatedCoord.y * frequency;

	// Pixel-unit amplitude normalized and applied
	let distortion = sin(wavePhase + uniforms.time * 0.1) * amplitudeNorm.y;
	let distortedY = rotatedCoord.y + distortion;

	// Cross wave
	let crossDistortion = sin(crossWavePhase + uniforms.time * 0.1) * amplitudeNorm.x * uniforms.crossWave;
	let distortedX = rotatedCoord.x + crossDistortion;

	// Distorted coordinate
	let distortedCoord = vec2f(distortedX, distortedY);

	// Rotate back to original orientation
	let finalRotatedCoord = rotate2DAroundOrigin(distortedCoord, -uniforms.angleRad);

	// Convert back to texture coordinates
	let finalCoord = (finalRotatedCoord + 1.0) * 0.5;

	// Clamp coordinates to prevent sampling outside texture bounds
	let clampedCoord = clamp(finalCoord, vec2f(0.0), vec2f(1.0));

	return textureSample(inputTexture, inputSampler, clampedCoord);
}
`;

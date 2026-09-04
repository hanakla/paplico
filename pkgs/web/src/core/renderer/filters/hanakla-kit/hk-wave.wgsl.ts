export const HK_WAVE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	contentOffset: vec2f,
	worldOrigin: vec2f,
	elementSize: vec2f,
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

// World-anchored position: the editor clamps the bake to the viewport, so
// texCoord 0 is not the element corner and the texture scale follows the live
// zoom. Mapping back through contentOffset/dpiScale and shifting by
// worldOrigin anchors the wave phase to the full element rect, keeping it
// fixed while zooming or panning.
fn waveWorldPos(texCoord: vec2f) -> vec2f {
	return (texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.worldOrigin;
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

	// Center-normalized coordinates of the FULL element rect, so the wave
	// phase stays anchored to the element instead of the bake rect
	let stableUV = waveWorldPos(texCoord) / uniforms.elementSize;
	let centerCoord = stableUV * 2.0 - 1.0;

	// Calculate main wave based on angle
	let rotatedCoord = rotate2DAroundOrigin(centerCoord, uniforms.angleRad);

	// Wave phases
	let wavePhase = rotatedCoord.x * frequency;
	let crossWavePhase = rotatedCoord.y * frequency;

	// Pixel-unit amplitude normalized and applied
	let distortion = sin(wavePhase + uniforms.time * 0.1) * amplitudeNorm.y;

	// Cross wave
	let crossDistortion = sin(crossWavePhase + uniforms.time * 0.1) * amplitudeNorm.x * uniforms.crossWave;

	// The displacement is a pure offset: rotate it back into texture axes and
	// apply it to the real bake UV. The 0.5 factor maps the [-1, 1] space the
	// distortion is computed in onto UV, the magnitude saved documents were
	// authored with.
	let offsetUV = rotate2DAroundOrigin(vec2f(crossDistortion, distortion), -uniforms.angleRad) * 0.5;

	// Clamp coordinates to prevent sampling outside texture bounds
	let clampedCoord = clamp(texCoord + offsetUV, vec2f(0.0), vec2f(1.0));

	return textureSample(inputTexture, inputSampler, clampedCoord);
}
`;

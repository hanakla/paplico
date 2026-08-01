export const HK_SPRAYING_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	strength: f32,
	seed: f32,
	blockSize: f32,
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

fn hash(p: vec2u, seed: u32) -> u32 {
	var state = p.x ^ (p.y << 8u) ^ seed;
	state = state ^ (state >> 16u);
	state = state * 0x45d9f3bu;
	state = state ^ (state >> 16u);
	state = state * 0x45d9f3bu;
	state = state ^ (state >> 16u);
	return state;
}

fn hashToFloat(h: u32) -> f32 {
	return f32(h) / 4294967295.0;
}

fn randomOffset(coord: vec2u, seed: u32, strength: f32) -> vec2f {
	let h1 = hash(coord, seed);
	let h2 = hash(coord + vec2u(1u, 0u), seed);

	let angle = hashToFloat(h1) * 6.28318530718;
	let radius = hashToFloat(h2) * strength;

	return vec2f(cos(angle) * radius, sin(angle) * radius);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;

	let dpiScale = uniforms.dpiScale;

	let pixelCoord = vec2u(vec2f(texCoord * dims));
	let seed = u32(uniforms.seed);

	let blockSize = uniforms.blockSize * dpiScale;
	let blockCoord = vec2u(vec2f(pixelCoord) / blockSize);
	let strengthInCurrentPixels = uniforms.strength * dpiScale;

	let blockOffset = randomOffset(blockCoord, seed, strengthInCurrentPixels);
	let pixelOffset = randomOffset(pixelCoord, seed + 12345u, strengthInCurrentPixels * 0.3);
	let totalOffset = blockOffset + pixelOffset;

	let sourceCoord = (vec2f(pixelCoord) + totalOffset) / dims;

	let clampedCoord = clamp(sourceCoord, vec2f(0.0), vec2f(1.0));
	let sampledColor = textureSample(inputTexture, inputSampler, clampedCoord);
	let inBounds = f32(sourceCoord.x >= 0.0 && sourceCoord.x <= 1.0 && sourceCoord.y >= 0.0 && sourceCoord.y <= 1.0);
	return vec4f(sampledColor.rgb * inBounds, sampledColor.a * inBounds);
}
`;

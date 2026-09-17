export const NOISE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	// Fractional texel position of the content's top-left inside the texture.
	contentOffset: vec2f,
	// Captured source position within the unclipped effect region in world px.
	sourceOffset: vec2f,
	dpiScale: f32,
	mixRate: f32,
	seed: u32,
	// Halvings of the 1 world px base cell that the rasterization DPI can resolve.
	levels: u32,
	// 0: monochrome, 1: color
	colorMode: u32,
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

fn pcg(v: u32) -> u32 {
	let state = v * 747796405u + 2891336453u;
	let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
	return (word >> 22u) ^ word;
}

fn cellHash(cell: vec2i, level: u32, channel: u32) -> f32 {
	let h = pcg(uniforms.seed ^ pcg((level * 4u + channel) ^ pcg(bitcast<u32>(cell.x) ^ pcg(bitcast<u32>(cell.y)))));
	return f32(h) / 4294967295.0;
}

// The 1 world px (72 dpi) cell fixes the value. Each finer level splits a cell
// into 2x2 children whose offsets sum to zero and are bounded by the parent's
// headroom to [0, 1], so every level area-averages back to the 72 dpi image.
fn noiseChannel(world: vec2f, channel: u32) -> f32 {
	var value = cellHash(vec2i(floor(world)), 0u, channel);
	for (var level = 1u; level <= uniforms.levels; level++) {
		let child = vec2i(floor(world * f32(1u << level)));
		let origin = (child >> vec2u(1u)) * 2;
		let siblingMean = (
			cellHash(origin, level, channel)
			+ cellHash(origin + vec2i(1, 0), level, channel)
			+ cellHash(origin + vec2i(0, 1), level, channel)
			+ cellHash(origin + vec2i(1, 1), level, channel)
		) * 0.25;
		value += (cellHash(child, level, channel) - siblingMean) * min(value, 1.0 - value);
	}
	return value;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let source = textureSample(inputTexture, inputSampler, input.texCoord);

	// Anchored in world px like pixelate.wgsl.ts so the cells stay put across DPI.
	let world = (input.texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.sourceOffset;

	let r = noiseChannel(world, 0u);
	var noise = vec3f(r);
	if (uniforms.colorMode == 1u) {
		noise = vec3f(r, noiseChannel(world, 1u), noiseChannel(world, 2u));
	}

	return vec4f(mix(source.rgb, noise * source.a, uniforms.mixRate), source.a);
}
`;

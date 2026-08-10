import { WORLD_CELL_HASH_WGSL } from "../../shaders/worldCellHash.wgsl";

export const HK_SPRAYING_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	contentOffset: vec2f,
	worldOrigin: vec2f,
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

${WORLD_CELL_HASH_WGSL}

fn randomOffset(coord: vec2u, seed: u32, strength: f32) -> vec2f {
	let h1 = hash(coord, seed);
	let h2 = hash(coord + vec2u(1u, 0u), seed);

	let angle = hashToFloat(h1) * 6.28318530718;
	let radius = hashToFloat(h2) * strength;

	return vec2f(cos(angle) * radius, sin(angle) * radius);
}

// World-anchored scatter position: the editor clamps the bake to the viewport
// and scales it with the live zoom, so texel-indexed hashes re-roll the
// pattern on every zoom or pan. Mapping back through contentOffset/dpiScale
// and shifting by worldOrigin anchors the scatter grids to the full element
// rect.
fn sprayingWorldPos(texCoord: vec2f) -> vec2f {
	return (texCoord * uniforms.resolution - uniforms.contentOffset) / uniforms.dpiScale
		+ uniforms.worldOrigin;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let dims = uniforms.resolution;
	let texCoord = input.texCoord;
	let seed = u32(uniforms.seed);

	// Draw the scatter offsets in world px on world-anchored cells (blockSize
	// and strength are stored in world px), then convert to bake UV.
	let worldPos = sprayingWorldPos(texCoord);
	let blockCell = worldCell(worldPos, uniforms.blockSize);
	let pixelCell = worldCell(worldPos, 1.0);

	let blockOffset = randomOffset(blockCell, seed, uniforms.strength);
	let pixelOffset = randomOffset(pixelCell, seed + 12345u, uniforms.strength * 0.3);
	let totalOffset = (blockOffset + pixelOffset) * uniforms.dpiScale;

	let sourceCoord = texCoord + totalOffset / dims;

	let clampedCoord = clamp(sourceCoord, vec2f(0.0), vec2f(1.0));
	let sampledColor = textureSample(inputTexture, inputSampler, clampedCoord);
	let inBounds = f32(sourceCoord.x >= 0.0 && sourceCoord.x <= 1.0 && sourceCoord.y >= 0.0 && sourceCoord.y <= 1.0);
	return vec4f(sampledColor.rgb * inBounds, sampledColor.a * inBounds);
}
`;

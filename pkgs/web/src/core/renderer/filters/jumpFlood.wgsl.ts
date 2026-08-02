// Jump-flood distance field over an alpha silhouette, shared by filters that
// need distance-to-contour (outline ring, drop-shadow spread, ...). Seeds are
// texel coordinates; a sentinel x <= -1e5 marks "no seed within reach".

const FULLSCREEN_VERTEX = /* wgsl */ `
struct VertexOutput {
	@builtin(position) position: vec4f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
	var output: VertexOutput;
	let x = f32((vertexIndex & 1u) << 1u);
	let y = f32(vertexIndex & 2u);
	output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
	return output;
}
`;

/** Seed pass — pixels matching the wanted polarity (covered for distance-to-
 *  silhouette, uncovered for distance-to-background) store their own texel
 *  coordinate. */
export const JUMP_FLOOD_SEED_SHADER = /* wgsl */ `
struct Uniforms {
	seedInside: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

${FULLSCREEN_VERTEX}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec2f {
	let p = vec2i(input.position.xy);
	let covered = textureLoad(inputTexture, p, 0).a >= 0.5;
	if (covered == (uniforms.seedInside > 0.5)) {
		return input.position.xy;
	}
	return vec2f(-1e6, -1e6);
}
`;

/** Flood pass — adopt the neighbour seed (at ±step) closest to this pixel.
 *  Run with halving steps until step = 1. */
export const JUMP_FLOOD_JUMP_SHADER = /* wgsl */ `
struct Uniforms {
	step: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var coordTexture: texture_2d<f32>;

${FULLSCREEN_VERTEX}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec2f {
	let dims = vec2i(textureDimensions(coordTexture, 0));
	let selfPos = input.position.xy;
	let step = i32(uniforms.step);

	var best = vec2f(-1e6, -1e6);
	var bestDist = 1e12;
	for (var j = -1; j <= 1; j++) {
		for (var i = -1; i <= 1; i++) {
			let q = clamp(
				vec2i(selfPos) + vec2i(i, j) * step,
				vec2i(0, 0),
				dims - vec2i(1, 1)
			);
			let seed = textureLoad(coordTexture, q, 0).xy;
			if (seed.x > -1e5) {
				let d = distance(seed, selfPos);
				if (d < bestDist) {
					bestDist = d;
					best = seed;
				}
			}
		}
	}
	return best;
}
`;

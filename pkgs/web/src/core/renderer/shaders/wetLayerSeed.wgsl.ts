// Wet layer simulation seeding.
//
// Turns the dab pass's accumulated seed targets into the first state of the
// ping-pong fields. Picking up the backdrop belongs to the mix pass, so this
// is only a change of representation:
//
//   pigment  passes through as-is (already density-encoded by the dab)
//   moisture rg <- the accumulated direction normalized by coverage
//            b  <- water, a <- pooling
//
// The fields run on a grid `scale` times coarser than the seeds (the diffusion reaches its distance through the grid spacing, not through a
// widened stencil), so each output texel averages the scale x scale block of
// seed texels it stands for. Averaging is what makes the coarse grid a
// down-sampling rather than a point-sampling: dropping seed texels here would
// lose thin strokes entirely.
export const WET_LAYER_SEED_SHADER = /* wgsl */ `
struct SeedUniforms {
	/** Coarse field resolution — the dispatch grid. */
	resolution: vec2f,
	/** Seed (fine) resolution the block loop is bounded by. */
	seedResolution: vec2f,
	/** Seed texels per field texel. */
	scale: f32,
	pad0: f32,
	pad1: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: SeedUniforms;
@group(0) @binding(1) var pigmentSeed: texture_2d<f32>;
@group(0) @binding(2) var fluidVelocitySeed: texture_2d<f32>;
@group(0) @binding(3) var moistureSeed: texture_2d<f32>;
@group(0) @binding(4) var pigmentOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var moistureOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	if (gid.x >= u32(uniforms.resolution.x) || gid.y >= u32(uniforms.resolution.y)) {
		return;
	}

	let scale = max(1, i32(uniforms.scale));
	let origin = vec2i(gid.xy) * scale;
	let seedMax = vec2i(uniforms.seedResolution) - vec2i(1);

	// Pigment is an optical density: two dabs stack by adding, but a block
	// that is half covered and half bare averages by what it lets through, not
	// by its densities — averaging those would read the bare half as opaque
	// too and turn every wash solid. So the block is averaged as coverage and
	// re-encoded, while colour rides along weighted by the coverage carrying
	// it. Water, pooling and direction are plain amounts and just average.
	var coverageSum = 0.0;
	var colorSum = vec3f(0.0);
	var velocity = vec4f(0.0);
	var moisture = vec4f(0.0);
	var taps = 0.0;
	for (var by = 0; by < scale; by = by + 1) {
		for (var bx = 0; bx < scale; bx = bx + 1) {
			let coord = origin + vec2i(bx, by);
			if (coord.x > seedMax.x || coord.y > seedMax.y) {
				continue;
			}
			let seed = max(textureLoad(pigmentSeed, coord, 0), vec4f(0.0));
			let coverage = 1.0 - exp(-seed.a);
			coverageSum += coverage;
			colorSum += seed.rgb / max(seed.a, 1e-5) * coverage;
			velocity += textureLoad(fluidVelocitySeed, coord, 0);
			moisture += textureLoad(moistureSeed, coord, 0);
			taps += 1.0;
		}
	}
	if (taps <= 0.0) {
		textureStore(pigmentOut, gid.xy, vec4f(0.0));
		textureStore(moistureOut, gid.xy, vec4f(0.0));
		return;
	}
	velocity /= taps;
	moisture /= taps;

	let meanCoverage = clamp(coverageSum / taps, 0.0, 0.999);
	let density = -log(max(1.0 - meanCoverage, 0.001));
	let color = colorSum / max(coverageSum, 1e-5);
	let pigment = vec4f(color * density, density);

	// The dab pass accumulated direction * coverage; dividing by the coverage
	// it also accumulated gives the mean direction over the dabs that landed.
	let carriedFlow = velocity.rg / max(velocity.b, 1e-5);

	textureStore(pigmentOut, gid.xy, pigment);
	textureStore(
		moistureOut,
		gid.xy,
		vec4f(carriedFlow, max(moisture.b, 0.0), max(moisture.a, 0.0)),
	);
}
`;

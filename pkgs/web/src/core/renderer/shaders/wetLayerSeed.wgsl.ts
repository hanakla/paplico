// Wet layer simulation seeding, v2.
//
// Turns the dab pass's accumulated seed targets into the first state of the
// ping-pong fields. v1 did far more here — it also gathered a pickup colour
// from the layer underneath — but in v2 picking up the backdrop belongs to
// the mix pass (design §13-4), so this is only a change of representation:
//
//   pigment  passes through as-is (already density-encoded by the dab)
//   moisture rg <- the accumulated direction normalized by coverage
//            b  <- water, a <- pooling
export const WET_LAYER_SEED_SHADER = /* wgsl */ `
struct SeedUniforms {
	resolution: vec2f,
	pad0: vec2f,
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

	let coord = vec2i(gid.xy);
	let pigment = textureLoad(pigmentSeed, coord, 0);
	let velocity = textureLoad(fluidVelocitySeed, coord, 0);
	let moisture = textureLoad(moistureSeed, coord, 0);

	// The dab pass accumulated direction * coverage; dividing by the coverage
	// it also accumulated gives the mean direction over the dabs that landed.
	let carriedFlow = velocity.rg / max(velocity.b, 1e-5);

	textureStore(pigmentOut, gid.xy, max(pigment, vec4f(0.0)));
	textureStore(
		moistureOut,
		gid.xy,
		vec4f(carriedFlow, max(moisture.b, 0.0), max(moisture.a, 0.0)),
	);
}
`;

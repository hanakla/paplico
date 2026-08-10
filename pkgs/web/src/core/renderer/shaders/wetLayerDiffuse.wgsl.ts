// Wet layer diffusion step, v2 (design §13-2).
//
// Same physics as the v1 wet-ink kernel — one dt-normalized explicit-Euler
// iteration of water diffusion, semi-Lagrangian pigment advection and drying
// — with one structural change: every coefficient is read per texel instead
// of from a stroke-wide uniform, so a single stroke can dry faster where it
// slowed, granulate only where it pooled, and bleed softly at one end while
// staying sharp at the other.
//
// Where each coefficient comes from:
// - absorption, granulation, bleedSoftness
//                         the seed pass's coefficient targets, blended by
//                         coverage so the covering dab's value wins
// - edgeDarkening, edgeRoughness
//                         also seeded, but consumed by the finish pass only
// - wetness               moistureSeed.z / coverage — the seed wrote
//                         coverage * wetness, so dividing recovers it
// - directionality        |velocitySeed.rg| / velocitySeed.b — likewise
//
// The seed targets are read-only for the whole iteration loop (only pigment
// and moisture ping-pong), so recovering the seeds from them stays valid as
// the field evolves. They stay at the seed resolution while the fields run on
// a coarser grid, so every seed read averages the block of seed texels the
// field texel stands for.
//
// Field semantics are inherited from v1 with the v2 names: the velocity field
// is `fluidVelocity` (v1 `flow`) and the water/pooling field is `moisture`
// (v1 `fluid`). pigment holds rgb = color * density, a = density, in the same
// log space the seed encodes and the finish pass decodes.
export const WET_LAYER_DIFFUSE_SHADER = /* wgsl */ `
struct DiffuseUniforms {
	resolution: vec2f,
	paperScale: f32,
	randomSeed: f32,
	// 1 / iterationCount, so the total effect is iteration-count independent.
	dt: f32,
	// Brush radius in seed-resolution pixels (advection reach reference).
	brushRadiusPx: f32,
	// Bleed radius as a ratio of the brush size (WetConfig, stroke level).
	bleedRadius: f32,
	/** Seed texels per field texel. Distances below are in field texels, so
	 *  anything expressed in seed texels divides by this. */
	scale: f32,
	/** Seed resolution, to bound the block reads. */
	seedResolution: vec2f,
	pad0: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: DiffuseUniforms;
@group(0) @binding(1) var srcPigment: texture_2d<f32>;
@group(0) @binding(2) var srcMoisture: texture_2d<f32>;
@group(0) @binding(3) var fluidVelocitySeed: texture_2d<f32>;
@group(0) @binding(4) var moistureSeed: texture_2d<f32>;
@group(0) @binding(5) var absorptionGranulation: texture_2d<f32>;
@group(0) @binding(6) var softnessEdgeDarkening: texture_2d<f32>;
@group(0) @binding(7) var dstPigment: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var dstMoisture: texture_storage_2d<rgba16float, write>;

fn hash21(p: vec2f) -> f32 {
	let q = fract(p * vec2f(127.1, 311.7));
	let r = q + dot(q, q + vec2f(74.7, 42.3));
	return fract(r.x * r.y);
}

fn valueNoise(p: vec2f) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let u = f * f * (vec2f(3.0) - 2.0 * f);
	let seed = vec2f(uniforms.randomSeed, uniforms.randomSeed * 1.913);
	let a = hash21(i + seed);
	let b = hash21(i + vec2f(1.0, 0.0) + seed);
	let c = hash21(i + vec2f(0.0, 1.0) + seed);
	let d = hash21(i + vec2f(1.0, 1.0) + seed);
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn clampCoord(coord: vec2i) -> vec2i {
	return clamp(
		coord,
		vec2i(0),
		vec2i(i32(uniforms.resolution.x) - 1, i32(uniforms.resolution.y) - 1),
	);
}

fn samplePigment(coord: vec2i) -> vec4f {
	return textureLoad(srcPigment, clampCoord(coord), 0);
}

/** Bilinear pigment sample for sub-pixel advection; storage-written textures
 *  have no sampler, so this is a clamped 4-tap mix. */
fn samplePigmentBilinear(pos: vec2f) -> vec4f {
	let base = floor(pos);
	let f = pos - base;
	let bi = vec2i(base);
	let p00 = samplePigment(bi);
	let p10 = samplePigment(bi + vec2i(1, 0));
	let p01 = samplePigment(bi + vec2i(0, 1));
	let p11 = samplePigment(bi + vec2i(1, 1));
	return mix(mix(p00, p10, f.x), mix(p01, p11, f.x), f.y);
}

fn sampleMoisture(coord: vec2i) -> vec4f {
	return textureLoad(srcMoisture, clampCoord(coord), 0);
}

/** Mean of a seed texture over the block one field texel covers. Four
 *  quarter-points stand in for the whole block: the seeds vary on the scale of
 *  a dab, so a point sample would step the coefficients in blocks the size of
 *  the field grid and print that grid onto the result. */
fn sampleSeed(tex: texture_2d<f32>, coord: vec2i) -> vec4f {
	let scale = max(1.0, uniforms.scale);
	let base = vec2f(coord) * scale;
	let seedMax = uniforms.seedResolution - vec2f(1.0);
	let q = scale * 0.25;
	var sum = vec4f(0.0);
	for (var i = 0; i < 4; i = i + 1) {
		let offset = vec2f(
			select(q, scale - q, i == 1 || i == 3),
			select(q, scale - q, i >= 2),
		);
		let at = vec2i(clamp(base + offset, vec2f(0.0), seedMax));
		sum += textureLoad(tex, at, 0);
	}
	return sum * 0.25;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	if (gid.x >= u32(uniforms.resolution.x) || gid.y >= u32(uniforms.resolution.y)) {
		return;
	}

	let coord = vec2i(gid.xy);

	// The neighbours are the immediate ones. Reaching further by stepping the
	// taps out instead splits the grid into that many independent lattices —
	// a texel would only ever exchange with texels a whole step away and never
	// with the one beside it — and the lattices settle at different densities,
	// which prints as a grid of blobs. The distance comes from the grid
	// spacing instead: the field runs on a grid that many times coarser than
	// the seeds, so the same iterations carry paint that many times further.
	let centerPigment = samplePigment(coord);
	let leftPigment = samplePigment(coord + vec2i(-1, 0));
	let rightPigment = samplePigment(coord + vec2i(1, 0));
	let downPigment = samplePigment(coord + vec2i(0, -1));
	let upPigment = samplePigment(coord + vec2i(0, 1));

	let centerMoisture = sampleMoisture(coord);
	let leftMoisture = sampleMoisture(coord + vec2i(-1, 0));
	let rightMoisture = sampleMoisture(coord + vec2i(1, 0));
	let downMoisture = sampleMoisture(coord + vec2i(0, -1));
	let upMoisture = sampleMoisture(coord + vec2i(0, 1));

	let seedMoisture = sampleSeed(moistureSeed, coord);
	let seedVelocity = sampleSeed(fluidVelocitySeed, coord);

	let pigmentNeighborhood =
		centerPigment.a + leftPigment.a + rightPigment.a + downPigment.a + upPigment.a;
	let moistureNeighborhood =
		centerMoisture.b + leftMoisture.b + rightMoisture.b + downMoisture.b + upMoisture.b;
	if (
		pigmentNeighborhood <= 0.00001 &&
		moistureNeighborhood <= 0.00001 &&
		seedVelocity.b <= 0.00001 &&
		seedMoisture.b <= 0.00001 &&
		dot(abs(seedVelocity.rg), vec2f(1.0)) <= 0.00001
	) {
		textureStore(dstPigment, gid.xy, vec4f(0.0));
		textureStore(dstMoisture, gid.xy, vec4f(0.0));
		return;
	}

	// Coverage is the velocity seed's accumulated weight; motion divides back
	// out of the moisture seed, and the edge factor is a pure function of
	// coverage so the seed never stored it.
	let coverage = clamp(seedVelocity.b, 0.0, 1.0);
	let sourceEdge =
		smoothstep(0.02, 0.35, coverage) * (1.0 - smoothstep(0.58, 0.98, coverage));
	let speed = clamp(seedMoisture.r / max(coverage, 1e-5), 0.0, 1.0);
	let accel = clamp(seedMoisture.g / max(coverage, 1e-5), 0.0, 1.0);
	let slowWet = 1.0 - speed;
	let pooling = max(centerMoisture.a, seedMoisture.a);
	let water = max(centerMoisture.b, 0.0);
	let cornerBrake = clamp(1.0 - accel * (0.46 + sourceEdge * 0.34), 0.24, 1.0);

	// --- per-texel coefficients ------------------------------------------
	let absorptionGranulationValue = sampleSeed(absorptionGranulation, coord);
	let absorption = clamp(absorptionGranulationValue.r, 0.0, 1.0);
	let granulation = clamp(absorptionGranulationValue.g, 0.0, 1.0);
	let bleedSoftness = clamp(
		sampleSeed(softnessEdgeDarkening, coord).r,
		0.0,
		1.0,
	);
	// The seed wrote coverage * wetness and coverage * directionality, so the
	// ratios recover what the curve produced for the dab that landed here.
	let wetness = clamp(seedMoisture.b / max(coverage, 1e-5), 0.0, 1.5);
	let directionality = clamp(
		length(seedVelocity.rg) / max(seedVelocity.b, 1e-5),
		0.0,
		1.0,
	);
	// v1 pre-baked these on the CPU from the single stroke-level absorption.
	let absorbLambda = -log(max(1.0 - 0.85 * absorption, 1e-4));
	let poolStepRetention = pow(0.75 - 0.35 * absorption, uniforms.dt);

	let noisePos =
		vec2f(gid.xy) * max(1.0, uniforms.scale) /
		max(0.0001, uniforms.paperScale * 16.0);
	let grain = valueNoise(noisePos);
	let permeability = mix(1.25, 0.45, granulation * grain);

	// Water drying as exponential retention: the retained fraction after unit
	// time is exp(-dryLambda), independent of the iteration count.
	let dryLambda = min(3.0, absorbLambda * permeability * (0.35 + 0.65 * coverage));
	let retention = exp(-dryLambda * uniforms.dt);

	// Directionality only mildly damps isotropic spread; it must not kill the
	// bleed itself.
	let isotropicScale = 1.0 - directionality * 0.35;

	let lapWater =
		(leftMoisture.b + rightMoisture.b + downMoisture.b + upMoisture.b) - water * 4.0;
	// Explicit-Euler coefficient; the 0.23 cap keeps it below the 0.25
	// stability limit at the parameter maxima.
	let waterDiffusion = min(
		0.23,
		7.3 * (0.25 + 0.75 * bleedSoftness) * (0.3 + 0.7 * uniforms.bleedRadius) *
			(0.7 + 0.3 * wetness) * isotropicScale * uniforms.dt,
	);
	let nextWaterAmount = max(0.0, (water + lapWater * waterDiffusion) * retention);

	let velocityAvg = seedVelocity.rg / max(seedVelocity.b, 1e-5);
	let velocityLen = length(velocityAvg);
	let velocityDir = select(
		vec2f(0.0),
		velocityAvg / max(velocityLen, 1e-5),
		velocityLen > 1e-5,
	);
	let flow = (velocityDir + centerMoisture.rg) * cornerBrake;
	let flowLen = length(flow);
	let flowDir = select(vec2f(0.0), flow / max(flowLen, 1e-5), flowLen > 1e-5);

	// Advection reach is brush-relative; the per-step displacement is capped
	// at 1.5px and dt bounds the total by ~reachPx.
	let reachPx =
		clamp(uniforms.bleedRadius * uniforms.brushRadiusPx * 1.5, 2.0, 32.0) /
		max(1.0, uniforms.scale);
	let flowBoost = nextWaterAmount * (0.65 + slowWet * 0.25 + pooling * 0.4);
	let advectStep = min(
		1.5,
		directionality * reachPx * flowBoost * cornerBrake * uniforms.dt,
	);
	// Gather-type semi-Lagrangian advection loses ~3% per advected pixel;
	// this correction keeps 32 iterations within 0.85..1.02x of the initial
	// pigment (pinned by the shader tests).
	let directionalFade = 1.0 - advectStep * 0.03;
	// flowDir is world-space (Y-up) but texture rows grow downward.
	let advectedPigment =
		samplePigmentBilinear(vec2f(gid.xy) - vec2f(flowDir.x, -flowDir.y) * advectStep) *
		directionalFade;

	let lapPigment =
		(leftPigment + rightPigment + downPigment + upPigment) - centerPigment * 4.0;
	let pigmentMobility = clamp(nextWaterAmount * (0.35 + wetness), 0.0, 1.0);
	let granulationHold = 1.0 - granulation * grain * (0.35 + coverage * 0.45);
	let pigmentDiffusion = min(0.23, waterDiffusion * 0.6 * pigmentMobility * granulationHold);
	var nextPigment = advectedPigment + lapPigment * pigmentDiffusion;
	nextPigment = max(nextPigment, vec4f(0.0));

	// Carried flow aligns toward the current target at a dt-normalized rate;
	// saturating its magnitude keeps the feedback gain below 1.
	let alignRate = 1.0 - exp(-(2.0 + directionality * 4.0) * uniforms.dt);
	let carriedTarget = velocityDir + flowDir * nextWaterAmount;
	let carriedRaw = mix(centerMoisture.rg, carriedTarget, alignRate) * cornerBrake;
	let carriedLen = length(carriedRaw);
	let carriedFlow = carriedRaw * (min(carriedLen, 1.0) / max(carriedLen, 1e-5));
	let nextPooling = max(0.0, pooling * poolStepRetention);

	textureStore(dstPigment, gid.xy, nextPigment);
	textureStore(dstMoisture, gid.xy, vec4f(carriedFlow, nextWaterAmount, nextPooling));
}
`;

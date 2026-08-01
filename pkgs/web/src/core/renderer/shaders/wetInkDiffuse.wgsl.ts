// Wet-ink diffusion compute step (one dt-normalized iteration).
//
// Field semantics:
// - srcWater/dstWater: rg = carried flow, a raw accumulated flow-bias vector in
//   world space (Y-up). It is NOT divergence-free; its magnitude is saturated
//   to <= 1 and the per-step advection displacement is capped at 1.5px with the
//   total displacement bounded by a brush-relative reach, so distortion from
//   field divergence is structurally limited. b = water amount, a = pooling.
// - srcPigment/dstPigment: rgb = color * density, a = pigment density. The seed
//   pass encodes density = -log(1 - coverage) and the finish pass decodes
//   alpha = 1 - exp(-density * pigmentLoad), which round-trips (alpha ~= cov)
//   at pigmentLoad = 1. Diffusion/advection act as linear combinations of the
//   density, which is not physically exact in this log space, but monotonicity
//   and boundedness are preserved.
// - dt normalization: uniforms.dt = 1 / iterationCount, so running the fixed
//   iteration count yields an iteration-count-independent total effect.
export const WET_INK_DIFFUSE_SHADER = /* wgsl */ `
struct DiffuseUniforms {
	resolution: vec2f,
	bleedWidth: f32,
	directionality: f32,
	wetness: f32,
	accelInfluence: f32,
	speedInfluence: f32,
	// Raw absorption. Pre-baked into absorbLambda/poolStepRetention on the CPU;
	// kept in the ABI so u[0..10] indices stay stable.
	absorption: f32,
	granulation: f32,
	paperScale: f32,
	randomSeed: f32,
	// 1 / iterationCount. Normalizes every rate so the total effect is
	// independent of the iteration count.
	dt: f32,
	// Brush radius in simulation-domain pixels (advection reach reference).
	brushRadiusPx: f32,
	// Bleed softness (schema "diffusion"): 0 = granular, 1 = soft.
	softness: f32,
	// -ln(1 - 0.85 * absorption): total water removal over unit time is 85%
	// at absorption = 1 (never 100%).
	absorbLambda: f32,
	// pow(0.75 - 0.35 * absorption, dt): per-step pooling retention.
	poolStepRetention: f32,
}

@group(0) @binding(0) var<uniform> uniforms: DiffuseUniforms;
@group(0) @binding(1) var srcPigment: texture_2d<f32>;
@group(0) @binding(2) var srcWater: texture_2d<f32>;
@group(0) @binding(3) var flowMRT: texture_2d<f32>;
@group(0) @binding(4) var fluidMRT: texture_2d<f32>;
@group(0) @binding(5) var maskMRT: texture_2d<f32>;
@group(0) @binding(6) var inputSampler: sampler;
@group(0) @binding(7) var dstPigment: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var dstWater: texture_storage_2d<rgba16float, write>;

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

// Bilinear pigment sample for sub-pixel semi-Lagrangian advection. No sampler
// binding is available for storage-written textures, so this is a 4-tap mix of
// clamped samplePigment loads. Reduces to samplePigment at integer positions.
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

fn sampleWater(coord: vec2i) -> vec4f {
	return textureLoad(srcWater, clampCoord(coord), 0);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	if (gid.x >= u32(uniforms.resolution.x) || gid.y >= u32(uniforms.resolution.y)) {
		return;
	}

	let coord = vec2i(gid.xy);

	let centerPigment = samplePigment(coord);
	let leftPigment = samplePigment(coord + vec2i(-1, 0));
	let rightPigment = samplePigment(coord + vec2i(1, 0));
	let downPigment = samplePigment(coord + vec2i(0, -1));
	let upPigment = samplePigment(coord + vec2i(0, 1));

	let centerWater = sampleWater(coord);
	let leftWater = sampleWater(coord + vec2i(-1, 0));
	let rightWater = sampleWater(coord + vec2i(1, 0));
	let downWater = sampleWater(coord + vec2i(0, -1));
	let upWater = sampleWater(coord + vec2i(0, 1));

	let fluid = textureLoad(fluidMRT, coord, 0);
	let mask = textureLoad(maskMRT, coord, 0);
	let pigmentNeighborhood =
		centerPigment.a + leftPigment.a + rightPigment.a + downPigment.a + upPigment.a;
	let waterNeighborhood =
		centerWater.b + leftWater.b + rightWater.b + downWater.b + upWater.b;
	if (
		pigmentNeighborhood <= 0.00001 &&
		waterNeighborhood <= 0.00001 &&
		mask.r <= 0.00001 &&
		fluid.b <= 0.00001 &&
		dot(abs(textureLoad(flowMRT, coord, 0).rg), vec2f(1.0)) <= 0.00001
	) {
		textureStore(dstPigment, gid.xy, vec4f(0.0));
		textureStore(dstWater, gid.xy, vec4f(0.0));
		return;
	}
	let coverage = clamp(mask.r, 0.0, 1.0);
	let sourceEdge = clamp(mask.g, 0.0, 1.0);
	let speed = clamp(mask.b, 0.0, 1.0);
	let accel = clamp(mask.a, 0.0, 1.0);
	let slowWet = 1.0 - speed;
	let pooling = max(centerWater.a, fluid.a);
	let water = max(centerWater.b, 0.0);
	let cornerBrake = clamp(1.0 - accel * (0.46 + sourceEdge * 0.34), 0.24, 1.0);

	let noisePos = vec2f(gid.xy) / max(0.0001, uniforms.paperScale * 16.0);
	let grain = valueNoise(noisePos);
	let permeability = mix(1.25, 0.45, uniforms.granulation * grain);

	// Water drying as exponential retention: the total retained fraction after
	// unit time is exp(-dryLambda), independent of the iteration count.
	let dryLambda = min(
		3.0,
		uniforms.absorbLambda * permeability * (0.35 + 0.65 * coverage) +
			uniforms.speedInfluence * speed * 1.2,
	);
	let retention = exp(-dryLambda * uniforms.dt);

	// Directionality only mildly damps isotropic spread; it must not kill the
	// bleed itself.
	let isotropicScale = 1.0 - uniforms.directionality * 0.35;

	let lapWater = (leftWater.b + rightWater.b + downWater.b + upWater.b) - water * 4.0;
	// Explicit-Euler diffusion coefficient. The 0.23 cap keeps it structurally
	// below the 0.25 stability limit (7.3 * dt = 0.228 at the parameter maxima).
	let waterDiffusion = min(
		0.23,
		7.3 * (0.25 + 0.75 * uniforms.softness) * (0.3 + 0.7 * uniforms.bleedWidth) *
			(0.7 + 0.3 * uniforms.wetness) * isotropicScale * uniforms.dt,
	);
	let nextWaterAmount = max(0.0, (water + lapWater * waterDiffusion) * retention);

	let flowFieldRaw = textureLoad(flowMRT, coord, 0);
	let flowFieldAvg = flowFieldRaw.rg / max(flowFieldRaw.b, 1e-5);
	let flowFieldLen = length(flowFieldAvg);
	let flowFieldDir = select(vec2f(0.0), flowFieldAvg / max(flowFieldLen, 1e-5), flowFieldLen > 1e-5);
	let flow = (flowFieldDir + centerWater.rg) * cornerBrake;
	let flowLen = length(flow);
	let flowDir = select(vec2f(0.0), flow / max(flowLen, 1e-5), flowLen > 1e-5);

	// Advection reach is brush-relative; per-step displacement is capped at
	// 1.5px and the dt factor bounds the total displacement by ~reachPx.
	let reachPx = clamp(uniforms.bleedWidth * uniforms.brushRadiusPx * 1.5, 2.0, 32.0);
	let flowBoost =
		nextWaterAmount *
		(0.65 + slowWet * 0.25 + pooling * (0.4 + uniforms.accelInfluence * 0.5));
	let advectStep = min(
		1.5,
		uniforms.directionality * reachPx * flowBoost * cornerBrake * uniforms.dt,
	);
	// Correction for the non-conservative drift of gather-type semi-Lagrangian
	// advection: ~3% pigment loss per advected pixel. Calibrated so that
	// 32 iterations keep the total pigment within 0.85..1.02x of the initial
	// amount (verified by the shader unit tests).
	let directionalFade = 1.0 - advectStep * 0.03;
	// flowDir is world-space (Y-up); texture rows grow downward, hence the Y
	// flip when converting the displacement to texture space.
	let advectedPigment =
		samplePigmentBilinear(vec2f(gid.xy) - vec2f(flowDir.x, -flowDir.y) * advectStep) *
		directionalFade;

	let lapPigment = (leftPigment + rightPigment + downPigment + upPigment) - centerPigment * 4.0;
	let pigmentMobility = clamp(nextWaterAmount * (0.35 + uniforms.wetness), 0.0, 1.0);
	let granulationHold = 1.0 - uniforms.granulation * grain * (0.35 + coverage * 0.45);
	let pigmentDiffusion = min(0.23, waterDiffusion * 0.6 * pigmentMobility * granulationHold);
	// Semi-Lagrangian translation plus explicit diffusion. advectedPigment
	// reduces to centerPigment when advectStep = 0, and a sub-pixel bilinear
	// shift is mass-preserving, so the old advect-mix feedback amplification
	// mechanism no longer exists.
	var nextPigment = advectedPigment + lapPigment * pigmentDiffusion;
	nextPigment = max(nextPigment, vec4f(0.0));

	// Carried flow aligns toward the current flow target at a dt-normalized
	// rate; magnitude saturation (<= 1) keeps the feedback loop gain below 1.
	let alignRate = 1.0 - exp(-(2.0 + uniforms.directionality * 4.0) * uniforms.dt);
	let carriedTarget = flowFieldDir + flowDir * nextWaterAmount;
	let carriedRaw = mix(centerWater.rg, carriedTarget, alignRate) * cornerBrake;
	let carriedLen = length(carriedRaw);
	let carriedFlow = carriedRaw * (min(carriedLen, 1.0) / max(carriedLen, 1e-5));
	let nextPooling = max(0.0, pooling * uniforms.poolStepRetention);

	textureStore(dstPigment, gid.xy, nextPigment);
	textureStore(dstWater, gid.xy, vec4f(carriedFlow, nextWaterAmount, nextPooling));
}
`;

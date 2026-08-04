import { COLOR_MIX_WGSL } from "./colorMix.wgsl";

export const WET_INK_DIFFUSE_SEED_SHADER = /* wgsl */ `
struct SeedUniforms {
	domainResolution: vec2f,
	targetResolution: vec2f,
	domainWorldOrigin: vec2f,
	targetWorldOrigin: vec2f,
	targetWorldPerPixel: f32,
	domainWorldPerPixel: f32,
	wetness: f32,
	pigmentLoad: f32,
	pickupEnabled: f32,
	pickupStrength: f32,
	brushRadiusPx: f32,
	bleedWidth: f32,
	pickupDecay: f32,
	pickupBlendMode: f32,
	pad0: f32,
	pad1: f32,
}

@group(0) @binding(0) var<uniform> uniforms: SeedUniforms;
@group(0) @binding(1) var pigmentMRT: texture_2d<f32>;
@group(0) @binding(2) var flowMRT: texture_2d<f32>;
@group(0) @binding(3) var fluidMRT: texture_2d<f32>;
@group(0) @binding(4) var maskMRT: texture_2d<f32>;
@group(0) @binding(5) var renderBuffer: texture_2d<f32>;
@group(0) @binding(6) var inputSampler: sampler;
@group(0) @binding(7) var pigmentOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var waterOut: texture_storage_2d<rgba16float, write>;

fn sampleRenderBuffer(uv: vec2f) -> vec4f {
	return select(
		vec4f(0.0),
		textureSampleLevel(renderBuffer, inputSampler, uv, 0.0),
		all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)),
	);
}

fn clampDomainCoord(coord: vec2i) -> vec2i {
	return clamp(
		coord,
		vec2i(0),
		vec2i(i32(uniforms.domainResolution.x) - 1, i32(uniforms.domainResolution.y) - 1),
	);
}

${COLOR_MIX_WGSL}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	if (gid.x >= u32(uniforms.domainResolution.x) || gid.y >= u32(uniforms.domainResolution.y)) {
		return;
	}

	let domainPx = vec2f(gid.xy) + vec2f(0.5);
	let coord = vec2i(gid.xy);
	let pigment = textureLoad(pigmentMRT, coord, 0);
	let fluid = textureLoad(fluidMRT, coord, 0);
	let mask = textureLoad(maskMRT, coord, 0);

	let coverage = clamp(mask.r, 0.0, 1.0);
	let pigmentMass = max(pigment.a, 0.0);
	let water = max(fluid.b, coverage * uniforms.wetness);
	let pooling = max(fluid.a, coverage * 0.25);
	let flowSample = textureLoad(flowMRT, coord, 0);
	let flowCovSum = max(flowSample.b, 1e-5);
	let centerFlow = flowSample.rg / flowCovSum;
	if (uniforms.pickupEnabled <= 0.0 || uniforms.pickupStrength <= 0.0) {
		textureStore(
			pigmentOut,
			gid.xy,
			vec4f(max(pigment.rgb, vec3f(0.0)), pigmentMass),
		);
		textureStore(
			waterOut,
			gid.xy,
			vec4f(centerFlow, max(water, 0.0), max(pooling, 0.0)),
		);
		return;
	}
	let worldPos = vec2f(
		uniforms.domainWorldOrigin.x + domainPx.x * uniforms.domainWorldPerPixel,
		uniforms.domainWorldOrigin.y - domainPx.y * uniforms.domainWorldPerPixel,
	);
	let targetPx = vec2f(
		(worldPos.x - uniforms.targetWorldOrigin.x) / uniforms.targetWorldPerPixel,
		(uniforms.targetWorldOrigin.y - worldPos.y) / uniforms.targetWorldPerPixel,
	);
	let targetUv = (targetPx + vec2f(0.5)) / uniforms.targetResolution;
	let pickupDirs = array<vec2f, 16>(
		vec2f(1.0, 0.0),
		vec2f(0.9239, 0.3827),
		vec2f(0.7071, 0.7071),
		vec2f(0.3827, 0.9239),
		vec2f(0.0, 1.0),
		vec2f(-0.3827, 0.9239),
		vec2f(-0.7071, 0.7071),
		vec2f(-0.9239, 0.3827),
		vec2f(-1.0, 0.0),
		vec2f(-0.9239, -0.3827),
		vec2f(-0.7071, -0.7071),
		vec2f(-0.3827, -0.9239),
		vec2f(0.0, -1.0),
		vec2f(0.3827, -0.9239),
		vec2f(0.7071, -0.7071),
		vec2f(0.9239, -0.3827),
	);
	let pickupReach = max(
		1.0,
		uniforms.brushRadiusPx *
			(0.35 + uniforms.bleedWidth * 0.85 + uniforms.wetness * 0.45),
	);
	let localCoverageScale = 0.25 + 0.75 * smoothstep(0.0, 0.15, coverage);
	let effectiveReach = pickupReach * localCoverageScale;
	var sourceWeight = coverage;
	var sourcePigment = pigment.rgb * max(coverage, 0.0001);
	var sourceMass = pigmentMass * max(coverage, 0.0001);
	let centerFlowLen = length(centerFlow);
	let centerFlowDir = select(vec2f(0.0), centerFlow / max(centerFlowLen, 1e-5), centerFlowLen > 1e-5);
	var sourceFlow = centerFlowDir * max(coverage, 0.0001);
	var sourceWater = water * max(coverage, 0.0001);

	for (var i = 0u; i < 16u; i = i + 1u) {
		let dir = pickupDirs[i];
		for (var step = 1u; step <= 6u; step = step + 1u) {
			let distanceRate = f32(step) / 6.0;
			let sampleCoord = clampDomainCoord(vec2i(round(vec2f(coord) - dir * effectiveReach * distanceRate)));
			let sampleMask = textureLoad(maskMRT, sampleCoord, 0);
			let sampleCoverage = clamp(sampleMask.r, 0.0, 1.0);
			let sampleFluid = textureLoad(fluidMRT, sampleCoord, 0);
			let sampleFlowRaw = textureLoad(flowMRT, sampleCoord, 0);
			let sampleFlowNorm = sampleFlowRaw.rg / max(sampleFlowRaw.b, 1e-5);
			let sampleFlowLen = length(sampleFlowNorm);
			let sampleFlowDir = select(vec2f(0.0), sampleFlowNorm / max(sampleFlowLen, 1e-5), sampleFlowLen > 1e-5);
			let alignment = pow(clamp(dot(sampleFlowDir, vec2f(dir.x, -dir.y)), 0.0, 1.0), 2.0);
			let distanceFade = exp(-distanceRate * 2.5);
			let candidateWeight = sampleCoverage * alignment * distanceFade;
			let samplePigment = textureLoad(pigmentMRT, sampleCoord, 0);
			sourceWeight += candidateWeight;
			sourcePigment += samplePigment.rgb * candidateWeight;
			sourceMass += max(samplePigment.a, 0.0) * candidateWeight;
			sourceFlow += sampleFlowDir * candidateWeight;
			sourceWater += max(sampleFluid.b, sampleCoverage * uniforms.wetness) * candidateWeight;
		}
	}

	let sourceDenom = max(sourceWeight, 1e-5);
	let sourceMassAvg = sourceMass / sourceDenom;
	let sourceFlowAvg = sourceFlow / sourceDenom;
	let sourceWaterAvg = max(sourceWater / sourceDenom, water);
	let sourceFlowLen = length(sourceFlowAvg);
	let pickupDir = select(vec2f(0.0), sourceFlowAvg / max(sourceFlowLen, 1e-5), sourceFlowLen > 1e-5);
	let pickupDirUV = vec2f(pickupDir.x, -pickupDir.y);
	let haloInfluence = clamp(max(coverage, (sourceWeight - coverage) * 0.65), 0.0, 1.0);
	let targetTexel = 1.0 / max(uniforms.targetResolution, vec2f(1.0));
	let domainToTargetPx = uniforms.domainWorldPerPixel / max(uniforms.targetWorldPerPixel, 1e-5);
	let decaySign = select(1.0, -1.0, uniforms.pickupDecay < 0.0);
	let decayAbs = max(abs(uniforms.pickupDecay), 0.01);
	let baseReachTargetPx =
		pickupReach *
		domainToTargetPx *
		(1.15 + uniforms.wetness * 1.15);
	let targetPickupReach = baseReachTargetPx;
	let targetBrushHalfWidth = uniforms.brushRadiusPx * domainToTargetPx * 0.72;
	let pickupPerp = vec2f(-pickupDirUV.y, pickupDirUV.x);
	let sideOffsets = array<f32, 3>(0.0, -0.58, 0.58);
	let sideWeights = array<f32, 3>(1.0, 0.42, 0.42);
	var pickedPigment = vec3f(0.0);
	var pickedColorWeight = 0.0;
	var pickupDistanceSignal = 0.0;
	for (var step = 0u; step < 6u; step = step + 1u) {
		let distanceRate = f32(step) / 5.0;
		let carryFade = exp(-distanceRate * 3.0 / decayAbs);
		let historyUv = targetUv - pickupDirUV * decaySign * targetTexel * targetPickupReach * distanceRate;
		for (var side = 0u; side < 3u; side = side + 1u) {
			let sideWeight = sideWeights[side];
			let renderBufferSample = sampleRenderBuffer(
				historyUv + pickupPerp * targetTexel * targetBrushHalfWidth * sideOffsets[side],
			);
			let sampleAlpha = clamp(renderBufferSample.a, 0.0, 0.999);
			let sampleSignal = sampleAlpha * carryFade * sideWeight;
			pickedPigment += (renderBufferSample.rgb / max(sampleAlpha, 1e-5)) * sampleSignal;
			pickedColorWeight += sampleSignal;
			pickupDistanceSignal = max(pickupDistanceSignal, sampleSignal);
		}
	}
	let renderBufferPigment = pickedPigment / max(pickedColorWeight, 1e-5);
	let pickupSourceSignal = clamp(pickupDistanceSignal, 0.0, 0.999);
	let brushPigmentActive = smoothstep(0.0001, 0.02, sourceMassAvg);
	let waterOnlyActivity = smoothstep(0.001, 0.05, coverage * sourceWaterAvg);
	let pickupActivity = max(brushPigmentActive, waterOnlyActivity);
	let wetPickupMask = clamp(max(haloInfluence * sourceWaterAvg, coverage), 0.0, 1.0);
	let pickupSignal = clamp(
		pickupSourceSignal *
		sourceWaterAvg *
		pickupActivity *
		max(uniforms.pickupStrength, 0.0) *
		uniforms.pickupEnabled,
		0.0,
		1.0,
	);
	let bodyPickupMask = smoothstep(0.12, 0.85, coverage);
	let pickupRamp = smoothstep(0.0, 0.15, pickupSignal);
	let colorPickupBlend = clamp(
		pow(pickupSignal, 0.65) *
		pickupRamp *
		mix(0.75, 1.0, bodyPickupMask),
		0.0,
		0.7,
	);
	let waterOnlyBlend = (1.0 - brushPigmentActive) * 0.92;
	let pigmentBlend = max(colorPickupBlend, waterOnlyBlend);
	let brushColor = sourcePigment / max(sourceMass, 1e-5);
	let vividMix = mixOklchPigmentColor(brushColor, renderBufferPigment, pigmentBlend);
	let mutedMix = mixOklabPigmentColor(brushColor, renderBufferPigment, pigmentBlend);
	let mixedPigmentColor = mix(vividMix, mutedMix, clamp(uniforms.pickupBlendMode, 0.0, 1.0));
	let waterBrushMass = (1.0 - brushPigmentActive) * pickupSourceSignal * coverage;
	let pickupMassMix = max(pickupSignal, waterBrushMass);
	let effectiveMassBase = max(sourceMassAvg, waterBrushMass * 0.5);
	let pickupMassRate = mix(0.12, 0.8, 1.0 - brushPigmentActive);
	let carriedHaloMass = effectiveMassBase * wetPickupMask * pickupMassMix * (1.0 - coverage) * 0.18;
	let mixedPigmentMass = max(pigmentMass + effectiveMassBase * pickupMassMix * wetPickupMask * pickupMassRate, carriedHaloMass);

	textureStore(
		pigmentOut,
		gid.xy,
		vec4f(
			max(mixedPigmentColor * mixedPigmentMass, vec3f(0.0)),
			mixedPigmentMass,
		),
	);
	let pickupWaterBoost = pickupMassMix * sourceWaterAvg * 0.35;
	let outputWater = max(water, water + pickupWaterBoost);
	textureStore(
		waterOut,
		gid.xy,
		vec4f(sourceFlowAvg, max(outputWater, 0.0), max(pooling, 0.0)),
	);
}
`;

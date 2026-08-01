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

fn srgbToLinear(c: f32) -> f32 {
	if c <= 0.04045 {
		return c / 12.92;
	}
	return pow((c + 0.055) / 1.055, 2.4);
}

fn linearToSrgb(c: f32) -> f32 {
	if c <= 0.0031308 {
		return c * 12.92;
	}
	return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

fn srgbToOklab(c: vec3f) -> vec3f {
	let rgb = clamp(c, vec3f(0.0), vec3f(1.0));
	let r = srgbToLinear(rgb.x);
	let g = srgbToLinear(rgb.y);
	let b = srgbToLinear(rgb.z);
	let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
	let l_ = pow(max(l, 0.0), 1.0 / 3.0);
	let m_ = pow(max(m, 0.0), 1.0 / 3.0);
	let s_ = pow(max(s, 0.0), 1.0 / 3.0);
	return vec3f(
		0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
		1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
		0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
	);
}

fn oklabToSrgb(lab: vec3f) -> vec3f {
	let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
	let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
	let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
	let l = l_ * l_ * l_;
	let m = m_ * m_ * m_;
	let s = s_ * s_ * s_;
	let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	let b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
	return vec3f(
		linearToSrgb(clamp(r, 0.0, 1.0)),
		linearToSrgb(clamp(g, 0.0, 1.0)),
		linearToSrgb(clamp(b, 0.0, 1.0)),
	);
}

fn srgbToOklch(rgb: vec3f) -> vec3f {
	let lab = srgbToOklab(rgb);
	return vec3f(lab.x, sqrt(lab.y * lab.y + lab.z * lab.z), atan2(lab.z, lab.y));
}

fn oklchToSrgb(lch: vec3f) -> vec3f {
	return oklabToSrgb(vec3f(lch.x, cos(lch.z) * lch.y, sin(lch.z) * lch.y));
}

fn mixOklchHue(a: vec3f, b: vec3f, t: f32) -> f32 {
	const PI: f32 = 3.141592653589793;
	const TAU: f32 = 6.283185307179586;
	var fromHue = a.z;
	var toHue = b.z;
	if a.y < 0.0001 {
		fromHue = toHue;
	}
	if b.y < 0.0001 {
		toHue = fromHue;
	}
	var delta = toHue - fromHue;
	if delta > PI {
		delta -= TAU;
	}
	if delta < -PI {
		delta += TAU;
	}
	return fromHue + delta * t;
}

fn mixOklchPigmentColor(a: vec3f, b: vec3f, t: f32) -> vec3f {
	let labA = srgbToOklab(a);
	let labB = srgbToOklab(b);
	let labMixed = mix(labA, labB, t);
	let chromaA = sqrt(labA.y * labA.y + labA.z * labA.z);
	let chromaB = sqrt(labB.y * labB.y + labB.z * labB.z);
	let targetChroma = mix(chromaA, chromaB, t);
	let mixedChroma = sqrt(labMixed.y * labMixed.y + labMixed.z * labMixed.z);
	let rawScale = targetChroma / max(mixedChroma, 1e-5);
	let chromaBlend = smoothstep(0.0, 0.015, mixedChroma);
	let scale = mix(1.0, min(rawScale, 4.0), chromaBlend);
	return oklabToSrgb(vec3f(labMixed.x, labMixed.y * scale, labMixed.z * scale));
}

fn mixOklabPigmentColor(a: vec3f, b: vec3f, t: f32) -> vec3f {
	let labA = srgbToOklab(a);
	let labB = srgbToOklab(b);
	return oklabToSrgb(mix(labA, labB, t));
}

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

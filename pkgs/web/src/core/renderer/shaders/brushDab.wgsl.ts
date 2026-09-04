/**
 * Brush dab shader (v2) — single template source (design §15).
 *
 * One template generates every tip variant, so the gradient sampling switch
 * exists exactly once. The DabInstance struct is generated from
 * DabInstanceLayout so the CPU writer and the shader cannot drift. Per-dab
 * extras (packed color, hardness layer, grain strength, wet seeds) are read
 * from the storage buffer in the fragment stage via one flat instance index
 * instead of burning inter-stage locations.
 */

import { generateDabInstanceWgsl } from "../canvas/pipeline/brush/DabInstanceLayout";
import {
	STAMP_META_INDEX_MASK,
	STAMP_TEXTURE_LAYER_SHIFT,
} from "../canvas/pipeline/brush/StampPacking";
import { buildDabColorWgsl, PATH_META_WGSL } from "./dabColor.wgsl";
import { GRADIENT_COMMON_WGSL } from "./gradientCommon.wgsl";
import { MASK_COMMON_WGSL } from "./maskCommon.wgsl";
import { STROKE_WIDTH_COMMON_WGSL } from "./strokeWidthCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

/** Overlapping dabs add up, as the density encoding expects. */
const WET_FIELD_BLEND: GPUBlendState = {
	color: { srcFactor: "one", dstFactor: "one", operation: "add" },
	alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
};

/** dst = mix(dst, value, coverage): the covering dab's coefficient wins. */
const WET_COEFFICIENT_BLEND: GPUBlendState = {
	color: {
		srcFactor: "src-alpha",
		dstFactor: "one-minus-src-alpha",
		operation: "add",
	},
	alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
};

/**
 * Colour attachments of the wet seed pass, in location order.
 *
 * Sized against the 32-byte-per-sample floor every WebGPU adapter
 * guarantees: rgba8unorm costs 8 bytes, not 4, so three float fields plus a
 * single rgba8unorm would already sit at the ceiling. Splitting the
 * coefficients across narrow rg8unorm/r8unorm targets costs 5 bytes for all
 * five of them and — the reason for the split — lets each target carry its
 * own blend state. The fields accumulate additively while the
 * coefficients blend by coverage, so where dabs overlap the later one wins in
 * proportion to how much it covers (design §13-2's recency weighting) instead
 * of summing into saturation.
 */
export const WET_SEED_TARGETS: readonly GPUColorTargetState[] = [
	// pigment: rgb = color * density, a = density (unbounded above)
	{ format: "rgba16float", blend: WET_FIELD_BLEND },
	// fluidVelocity: rg = direction * coverage * directionality, b = coverage
	{ format: "rgba16float", blend: WET_FIELD_BLEND },
	// moisture: r = speed * cov, g = accel * cov, b = water, a = pooling
	{ format: "rgba16float", blend: WET_FIELD_BLEND },
	// absorption, granulation
	{ format: "rg8unorm", blend: WET_COEFFICIENT_BLEND },
	// bleedSoftness, edgeDarkening
	{ format: "rg8unorm", blend: WET_COEFFICIENT_BLEND },
	// edgeRoughness
	{ format: "r8unorm", blend: WET_COEFFICIENT_BLEND },
];

export const DAB_TIP_MODES = ["procedural", "image", "imageArray"] as const;
export type DabTipMode = (typeof DAB_TIP_MODES)[number];

export interface BrushDabShaderOptions {
	tipMode: DabTipMode;
	/** Emit the wet layer's seed MRT (fs_wet) alongside the normal fragment
	 *  entry point. Only the wet route builds a pipeline against it. */
	wetSeed?: boolean;
	/** Mixing route: per-dab resolved colors from the chunked mix pass
	 *  override the gradient/solid color (group(1) binding(2), indexed by the
	 *  flat instance index — the mix route draws from stroke-local buffers). */
	mixedColors?: boolean;
}

export function buildBrushDabShader({
	tipMode,
	mixedColors = false,
	wetSeed = false,
}: BrushDabShaderOptions): string {
	const tipBindings =
		tipMode === "procedural"
			? /* wgsl */ `
@group(0) @binding(2) var falloffLut: texture_2d_array<f32>;
@group(0) @binding(3) var tipSampler: sampler;`
			: tipMode === "image"
				? /* wgsl */ `
@group(0) @binding(2) var brushTexture: texture_2d<f32>;
@group(0) @binding(3) var tipSampler: sampler;`
				: /* wgsl */ `
@group(0) @binding(2) var brushTexture: texture_2d_array<f32>;
@group(0) @binding(3) var tipSampler: sampler;`;

	const tipSample =
		tipMode === "procedural"
			? /* wgsl */ `
	// Procedural tip: squared distance in tip space -> falloff LUT layer,
	// with a 1px analytic AA ramp at the rim (RENDER_SAMPLE_COUNT is 1).
	let centered = (in.uv - vec2f(0.5, 0.5)) * 2.0;
	let rr = dot(centered, centered);
	let dist = sqrt(rr);
	let aa = clamp((1.0 - dist) / max(fwidth(dist), 1e-4), 0.0, 1.0);
	let layer = i32(dab.hardnessLutIndex + 0.5);
	let lutAlpha = textureSample(falloffLut, tipSampler, vec2f(clamp(rr, 0.0, 1.0), 0.5), layer).r;
	let texAlpha = lutAlpha * aa;
	let texRgb = vec3f(0.0);
	let colorMode = 0u; // procedural tips are always tinted`
			: /* wgsl */ `
	${
		tipMode === "image"
			? "let texColor = textureSample(brushTexture, tipSampler, in.uv);"
			: "let texColor = textureSample(brushTexture, tipSampler, in.uv, i32(textureLayerOf(dab)));"
	}
	let colorMode = (pm.gradientMode >> 16u) & 1u;
	var texAlpha: f32;
	var texRgb: vec3f;
	if colorMode == 1u {
		texAlpha = texColor.a;
		texRgb = texColor.rgb;
	} else {
		texAlpha = (texColor.r + texColor.g + texColor.b) / 3.0;
		texRgb = vec3f(0.0);
	}`;

	return /* wgsl */ `
struct Uniforms {
	viewportX: f32,
	viewportY: f32,
	zoom: f32,
	canvasWidth: f32,
	canvasHeight: f32,
	rotSin: f32,
	rotCos: f32,
}

${generateDabInstanceWgsl("DabInstance")}

${TRANSFORM_COMMON_WGSL}

${GRADIENT_COMMON_WGSL}

${STROKE_WIDTH_COMMON_WGSL}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabInstance>;
${tipBindings}
@group(0) @binding(4) var grainTexture: texture_2d<f32>;
@group(0) @binding(5) var grainSampler: sampler;

@group(1) @binding(0) var<storage, read> pathMetas: array<PathMeta>;
@group(1) @binding(1) var<storage, read> colorStops: array<ColorStop>;
${
	mixedColors
		? /* wgsl */ `
@group(1) @binding(2) var<storage, read> mixedColors: array<vec4<f32>>;`
		: ""
}

@group(2) @binding(0) var<storage, read> transforms: array<ElementTransform>;

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

${PATH_META_WGSL}
${buildDabColorWgsl(STAMP_META_INDEX_MASK)}

fn textureLayerOf(dab: DabInstance) -> u32 {
	return dab.packedMeta >> ${STAMP_TEXTURE_LAYER_SHIFT}u;
}

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) uv: vec2f,
	@location(1) alpha: f32,
	@location(2) pathT: f32,
	@location(3) worldPos: vec2f,
	@location(4) @interpolate(flat) instanceIndex: u32,
	@location(5) side1Width: f32,
	@location(6) side2Width: f32,
	@location(7) transformedWorldPos: vec2f,
	@location(8) normalizedStrokeDistance: f32,
	@location(9) @interpolate(flat) maskIndex: u32,
	@location(10) maskBoundsMin: vec2f,
	@location(11) maskBoundsMax: vec2f,
}

@vertex
fn vs_main(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> VertexOutput {
	let quadVertices = array<vec2f, 6>(
		vec2f(-0.5, -0.5),
		vec2f(0.5, -0.5),
		vec2f(-0.5, 0.5),
		vec2f(-0.5, 0.5),
		vec2f(0.5, -0.5),
		vec2f(0.5, 0.5),
	);

	let dab = dabs[instanceIndex];
	let localPos = quadVertices[vertexIndex];

	// Keep dabs visible at low zoom; size-0 dabs must stay invisible.
	var effectiveSize = dab.sizeX;
	var effectiveSizeY = dab.sizeY;
	if dab.sizeX > 0.0 {
		let minWorldSize = 1.0 / uniforms.zoom;
		effectiveSize = max(dab.sizeX, minWorldSize);
		effectiveSizeY = max(dab.sizeY, minWorldSize);
	}
	let scaledPos = vec2f(localPos.x * effectiveSize, localPos.y * effectiveSizeY);

	let cos_r = cos(dab.rotation);
	let sin_r = sin(dab.rotation);
	let rotatedPos = vec2f(
		scaledPos.x * cos_r - scaledPos.y * sin_r,
		scaledPos.x * sin_r + scaledPos.y * cos_r
	);

	let dabWorldPos = vec2f(dab.positionX, dab.positionY) + rotatedPos;

	let pm = pathMetas[pathIndexOf(dab)];
	let et = transforms[pm.transformIndex];
	let worldPos = applyElementTransform(dabWorldPos, et);

	let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
	let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
	let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
	let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;
	let ndcX = rotX / (uniforms.canvasWidth * 0.5);
	let ndcY = rotY / (uniforms.canvasHeight * 0.5);

	var out: VertexOutput;
	out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
	out.uv = localPos + 0.5;
	out.alpha = dab.alpha;
	out.pathT = dab.pathT;
	out.worldPos = applyElementTransform(vec2f(dab.positionX, dab.positionY), et);
	out.instanceIndex = instanceIndex;
	out.side1Width = dab.side1Width;
	out.side2Width = dab.side2Width;
	out.transformedWorldPos = worldPos;
	out.normalizedStrokeDistance = normalizedStampNormalDistance(
		rotatedPos,
		vec2f(dab.normalX, dab.normalY),
		vec2f(effectiveSize, effectiveSizeY) * 0.5,
		dab.rotation,
	);
	out.maskIndex = et.maskIndex;
	out.maskBoundsMin = et.maskBoundsMin;
	out.maskBoundsMax = et.maskBoundsMax;
	return out;
}

${MASK_COMMON_WGSL}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
	let dab = dabs[in.instanceIndex];
	let pm = pathMetas[pathIndexOf(dab)];
${tipSample}

	let resolved = resolveDabColor(
		dab,
		pm,
		in.worldPos,
		in.pathT,
		in.normalizedStrokeDistance,
	);
	var color = resolved.rgb;
	var colorA = resolved.a;

${
	mixedColors
		? /* wgsl */ `
	// Mixing: the chunked mix pass resolved this dab's color already.
	let mixed = mixedColors[in.instanceIndex];
	color = mixed.rgb;
	colorA = mixed.a;`
		: ""
}
	// Paper grain (design §11): sampled at a canvas-fixed UV so the texture
	// stays put under the stroke instead of travelling with each dab.
	// Sampled unconditionally: implicit derivatives need uniform control
	// flow, and a grain-less stroke binds a 1x1 white texture anyway.
	let grainUv = in.transformedWorldPos / max(pm.grainScale, 1e-4) + pm.grainOffset;
	let grainValue = textureSample(grainTexture, grainSampler, grainUv).r;
	let grainStrength = clamp(dab.grainStrength, 0.0, 1.0);
	var grainedAlpha = texAlpha;
	if pm.grainMode == 1u {
		grainedAlpha = texAlpha * mix(1.0, grainValue, grainStrength);
	} else if pm.grainMode == 2u {
		grainedAlpha = max(0.0, texAlpha - (1.0 - grainValue) * grainStrength);
	}

	let widthFade = strokeWidthCoverage(
		in.normalizedStrokeDistance,
		in.side1Width,
		in.side2Width,
	);

	var finalColor: vec3f;
	var finalAlpha: f32;
	if colorMode == 1u {
		finalAlpha = grainedAlpha * in.alpha * widthFade;
		finalColor = texRgb;
	} else {
		finalAlpha = grainedAlpha * in.alpha * colorA * widthFade;
		finalColor = color;
	}

	let result = vec4f(finalColor * finalAlpha, finalAlpha);
	return applyClipMask(result, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}
${wetSeed ? buildWetSeedWgsl(tipSample, mixedColors) : ""}
`;
}

/**
 * Wet layer seed targets (design §13-2). The velocity field is
 * `fluidVelocity` (not `flow`, which is the flow brush property) and the
 * water/pooling field is `moisture`.
 *
 * Wetness / directionality / grain ride in on each dab, so a curve can
 * modulate them along the stroke instead of one value covering it.
 */
function buildWetSeedWgsl(tipSample: string, mixedColors: boolean): string {
	return /* wgsl */ `
struct WetSeedOutput {
	@location(0) pigment: vec4f,
	@location(1) fluidVelocity: vec4f,
	@location(2) moisture: vec4f,
	/** Coefficients carry coverage in alpha to drive their blend factor; the
	 *  narrow formats ignore the channels past their own. */
	@location(3) absorptionGranulation: vec4f,
	@location(4) softnessEdgeDarkening: vec4f,
	@location(5) edgeRoughness: vec4f,
}

struct WetCoefficients {
	absorption: f32,
	granulation: f32,
	bleedSoftness: f32,
	edgeDarkening: f32,
	edgeRoughness: f32,
}

/** Five 6-bit coefficients out of the dab's one spare slot, lowest first. */
fn unpackWetCoefficients(packed: f32) -> WetCoefficients {
	let bits = bitcast<u32>(packed);
	var out: WetCoefficients;
	out.absorption = f32(bits & 63u) / 63.0;
	out.granulation = f32((bits >> 6u) & 63u) / 63.0;
	out.bleedSoftness = f32((bits >> 12u) & 63u) / 63.0;
	out.edgeDarkening = f32((bits >> 18u) & 63u) / 63.0;
	out.edgeRoughness = f32((bits >> 24u) & 63u) / 63.0;
	return out;
}

/** Coverage -> optical density, so overlapping dabs add instead of saturate. */
fn encodeWetPigmentMass(premultiplied: vec4f) -> vec4f {
	let coverage = clamp(premultiplied.a, 0.0, 0.999);
	let density = -log(max(1.0 - coverage, 0.001));
	let color = premultiplied.rgb / max(coverage, 1e-5);
	return vec4f(color * density, density);
}

@fragment
fn fs_wet(in: VertexOutput) -> WetSeedOutput {
	let dab = dabs[in.instanceIndex];
	let pm = pathMetas[pathIndexOf(dab)];
	var resolved = resolveDabColor(
		dab,
		pm,
		in.worldPos,
		in.pathT,
		in.normalizedStrokeDistance,
	);
${
	mixedColors
		? /* wgsl */ `
	// Seeded with what the dab picked up, not the brush colour: this is how a
	// mixing stroke's pigment reaches the simulation and spreads.
	resolved = mixedColors[in.instanceIndex];`
		: ""
}
${tipSample}
	let widthFade = strokeWidthCoverage(
		in.normalizedStrokeDistance,
		in.side1Width,
		in.side2Width,
	);
	let coverage = clamp(
		texAlpha * in.alpha * resolved.a * widthFade,
		0.0,
		1.0,
	);
	let premultiplied = applyClipMask(
		vec4f(resolved.rgb * coverage, coverage),
		in.maskIndex,
		in.maskBoundsMin,
		in.maskBoundsMax,
		in.transformedWorldPos,
	);
	let cov = clamp(premultiplied.a, 0.0, 1.0);

	let dir = normalize(vec2f(dab.strokeDirX, dab.strokeDirY) + vec2f(1e-6, 0.0));
	let speed = clamp(dab.motionSpeed, 0.0, 1.0);
	let accel = clamp(dab.motionAccel, 0.0, 1.0);

	// Per-dab seeds.
	let wetness = max(dab.wetness, 0.0);
	let directionality = clamp(dab.directionality, 0.0, 1.0);
	let coefficients = unpackWetCoefficients(dab.packedWetCoefficients);

	var out: WetSeedOutput;
	out.pigment = encodeWetPigmentMass(premultiplied);
	out.fluidVelocity = vec4f(dir * cov * directionality, cov, 0.0);
	// Motion rides in the spare channels; coverage divides back out in the
	// kernel. Edge is a pure function of coverage, so it is recomputed
	// there rather than stored.
	out.moisture = vec4f(
		speed * cov,
		accel * cov,
		cov * wetness,
		cov * (0.18 + wetness * 0.35),
	);
	out.absorptionGranulation = vec4f(
		coefficients.absorption,
		coefficients.granulation,
		0.0,
		cov,
	);
	out.softnessEdgeDarkening = vec4f(
		coefficients.bleedSoftness,
		coefficients.edgeDarkening,
		0.0,
		cov,
	);
	out.edgeRoughness = vec4f(coefficients.edgeRoughness, 0.0, 0.0, cov);
	return out;
}
`;
}

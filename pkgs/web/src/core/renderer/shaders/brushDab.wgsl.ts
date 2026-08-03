/**
 * Brush dab shader (v2) — single template source (design §15).
 *
 * One template generates every tip variant, replacing the duplicated
 * BRUSH_STAMP_SHADER / BRUSH_STAMP_ARRAY_SHADER pair; the gradient sampling
 * switch exists exactly once. The DabInstance struct is generated from
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
import { GRADIENT_COMMON_WGSL } from "./gradientCommon.wgsl";
import { MASK_COMMON_WGSL } from "./maskCommon.wgsl";
import { STROKE_WIDTH_COMMON_WGSL } from "./strokeWidthCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

export const DAB_TIP_MODES = ["procedural", "image", "imageArray"] as const;
export type DabTipMode = (typeof DAB_TIP_MODES)[number];

export interface BrushDabShaderOptions {
	tipMode: DabTipMode;
}

export function buildBrushDabShader({ tipMode }: BrushDabShaderOptions): string {
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

struct PathMeta {
	colorR: f32,
	colorG: f32,
	colorB: f32,
	colorA: f32,
	gradientMode: u32,
	stopCount: u32,
	stopOffset: u32,
	transformIndex: u32,
	linearStart: vec2f,
	linearEnd: vec2f,
	boundsMin: vec2f,
	boundsMax: vec2f,
}

${TRANSFORM_COMMON_WGSL}

${GRADIENT_COMMON_WGSL}

${STROKE_WIDTH_COMMON_WGSL}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabInstance>;
${tipBindings}

@group(1) @binding(0) var<storage, read> pathMetas: array<PathMeta>;
@group(1) @binding(1) var<storage, read> colorStops: array<ColorStop>;

@group(2) @binding(0) var<storage, read> transforms: array<ElementTransform>;

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

fn pathIndexOf(dab: DabInstance) -> u32 {
	return dab.packedMeta & ${STAMP_META_INDEX_MASK}u;
}

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

// OKLab perceptual gradient stop sampling — the ONE copy in this shader.
fn sampleGradientStops(t: f32, pm: PathMeta) -> vec4f {
	let ct = clamp(t, 0.0, 1.0);
	let count = pm.stopCount;
	let baseOffset = pm.stopOffset;

	if count == 0u {
		return vec4f(0.0, 0.0, 0.0, 1.0);
	}
	if count == 1u {
		let s = colorStops[baseOffset];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	if ct <= colorStops[baseOffset].offset {
		let s = colorStops[baseOffset];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	let lastIdx = count - 1u;
	if ct >= colorStops[baseOffset + lastIdx].offset {
		let s = colorStops[baseOffset + lastIdx];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	for (var i = 0u; i < lastIdx; i = i + 1u) {
		let s0 = colorStops[baseOffset + i];
		let s1 = colorStops[baseOffset + i + 1u];
		if ct >= s0.offset && ct <= s1.offset {
			let range = s1.offset - s0.offset;
			var f = 0.0;
			if range > 0.0 {
				f = remapGradientT((ct - s0.offset) / range, s0.midpoint);
			}
			let lab0 = srgbToOklab(vec3f(s0.r, s0.g, s0.b));
			let lab1 = srgbToOklab(vec3f(s1.r, s1.g, s1.b));
			let rgb = oklabToSrgb(mix(lab0, lab1, f));
			return vec4f(rgb, mix(s0.a, s1.a, f));
		}
	}

	let s = colorStops[baseOffset + lastIdx];
	return vec4f(s.r, s.g, s.b, s.a);
}

${MASK_COMMON_WGSL}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
	let dab = dabs[in.instanceIndex];
	let pm = pathMetas[pathIndexOf(dab)];
	let gradientMode = pm.gradientMode & 0xFFFFu;
${tipSample}

	var color: vec3f;
	var colorA: f32;

	switch gradientMode {
		// Solid color
		case 0u: {
			color = vec3f(pm.colorR, pm.colorG, pm.colorB);
			colorA = pm.colorA;
		}
		// Within: bbox-based linear gradient
		case 1u: {
			let boundsSize = pm.boundsMax - pm.boundsMin;
			let uv = (in.worldPos - pm.boundsMin) / boundsSize;
			let dir = pm.linearEnd - pm.linearStart;
			let lenSq = dot(dir, dir);
			var t = 0.0;
			if lenSq > 0.0 {
				t = dot(uv - pm.linearStart, dir) / lenSq;
			}
			let sampled = sampleGradientStops(t, pm);
			color = sampled.rgb;
			colorA = sampled.a;
		}
		// Along the path
		case 2u: {
			let sampled = sampleGradientStops(in.pathT, pm);
			color = sampled.rgb;
			colorA = sampled.a;
		}
		// Across the stroke width
		case 3u: {
			let sampled = sampleGradientStops(
				strokeWidthAcrossUV(in.normalizedStrokeDistance),
				pm,
			);
			color = sampled.rgb;
			colorA = sampled.a;
		}
		default: {
			color = vec3f(0.0, 0.0, 0.0);
			colorA = 1.0;
		}
	}

	let widthFade = strokeWidthCoverage(
		in.normalizedStrokeDistance,
		in.side1Width,
		in.side2Width,
	);

	var finalColor: vec3f;
	var finalAlpha: f32;
	if colorMode == 1u {
		finalAlpha = texAlpha * in.alpha * widthFade;
		finalColor = texRgb;
	} else {
		finalAlpha = texAlpha * in.alpha * colorA * widthFade;
		finalColor = color;
	}

	let result = vec4f(finalColor * finalAlpha, finalAlpha);
	return applyClipMask(result, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}
`;
}

/**
 * Brush Stamp Shader - スタンプベースのブラシ描画用シェーダー
 *
 * インスタンシングでストローク上に配置されたスタンプを描画する。
 * 各スタンプは位置、サイズ、不透明度、回転、パス上位置(pathT)を持つ。
 * ストロークグラデーション（within/along/across）に対応。
 */

import {
	STAMP_META_INDEX_MASK,
	STAMP_TEXTURE_LAYER_SHIFT,
} from "../canvas/pipeline/brush/StampPacking";
import { GRADIENT_COMMON_WGSL } from "./gradientCommon.wgsl";
import { MASK_COMMON_WGSL } from "./maskCommon.wgsl";
import { STROKE_WIDTH_COMMON_WGSL } from "./strokeWidthCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

export const BRUSH_STAMP_SHADER = /* wgsl */ `
struct Uniforms {
	viewportX: f32,
	viewportY: f32,
	zoom: f32,
	canvasWidth: f32,
	canvasHeight: f32,
	rotSin: f32,
	rotCos: f32,
}

struct StampInstance {
	positionX: f32,
	positionY: f32,
	size: f32,
	opacity: f32,
	rotation: f32,
	pathT: f32,
	pathIndex: u32,
	sizeY: f32,
	side1Width: f32,
	side2Width: f32,
	normalX: f32,
	normalY: f32,
	flowX: f32,
	flowY: f32,
	motionSpeed: f32,
	motionAccel: f32,
}

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
@group(0) @binding(1) var<storage, read> stamps: array<StampInstance>;
@group(0) @binding(2) var brushTexture: texture_2d<f32>;
@group(0) @binding(3) var brushSampler: sampler;

@group(1) @binding(0) var<storage, read> pathMetas: array<PathMeta>;
@group(1) @binding(1) var<storage, read> colorStops: array<ColorStop>;

@group(2) @binding(0) var<storage, read> transforms: array<ElementTransform>;

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) uv: vec2f,
	@location(1) opacity: f32,
	@location(2) pathT: f32,
	@location(3) worldPos: vec2f,
	@location(5) @interpolate(flat) pathIndex: u32,
	@location(6) side1Width: f32,
	@location(7) side2Width: f32,
	@location(8) transformedWorldPos: vec2f,
	@location(12) pathNormal: vec2f,
	@location(13) normalizedStrokeDistance: f32,
	@location(9) @interpolate(flat) maskIndex: u32,
	@location(10) maskBoundsMin: vec2f,
	@location(11) maskBoundsMax: vec2f,
	@location(14) flowVector: vec2f,
	@location(15) motion: vec2f,
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

	let stamp = stamps[instanceIndex];
	let localPos = quadVertices[vertexIndex];

	// Guarantee minimum screen size so stamps remain visible at low zoom.
	// Only apply when stamp has nonzero size (width=0 strokes must stay invisible).
	var effectiveSize = stamp.size;
	var effectiveSizeY = stamp.sizeY;
	if stamp.size > 0.0 {
		let minWorldSize = 1.0 / uniforms.zoom;
		effectiveSize = max(stamp.size, minWorldSize);
		effectiveSizeY = max(stamp.sizeY, minWorldSize);
	}
	let scaledPos = vec2f(localPos.x * effectiveSize, localPos.y * effectiveSizeY);

	let cos_r = cos(stamp.rotation);
	let sin_r = sin(stamp.rotation);
	let rotatedPos = vec2f(
		scaledPos.x * cos_r - scaledPos.y * sin_r,
		scaledPos.x * sin_r + scaledPos.y * cos_r
	);

	// Stamp local → stamp world position
	let stampWorldPos = vec2f(stamp.positionX, stamp.positionY) + rotatedPos;

	// Apply element transform via PathMeta's transformIndex
	let pm = pathMetas[stamp.pathIndex];
	let et = transforms[pm.transformIndex];
	let worldPos = applyElementTransform(stampWorldPos, et);

	let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
	let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
	let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
	let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;
	let ndcX = rotX / (uniforms.canvasWidth * 0.5);
	let ndcY = rotY / (uniforms.canvasHeight * 0.5);

	var out: VertexOutput;
	out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
	out.uv = localPos + 0.5;
	out.opacity = stamp.opacity;
	out.pathT = stamp.pathT;
	out.worldPos = applyElementTransform(vec2f(stamp.positionX, stamp.positionY), et);
	out.pathIndex = stamp.pathIndex;
	out.side1Width = stamp.side1Width;
	out.side2Width = stamp.side2Width;
	out.transformedWorldPos = worldPos;
	out.pathNormal = transformElementDirection(vec2f(stamp.normalX, stamp.normalY), et);
	out.normalizedStrokeDistance = normalizedStampNormalDistance(
		rotatedPos,
		vec2f(stamp.normalX, stamp.normalY),
		vec2f(effectiveSize, effectiveSizeY) * 0.5,
		stamp.rotation,
	);
	out.maskIndex = et.maskIndex;
	out.maskBoundsMin = et.maskBoundsMin;
	out.maskBoundsMax = et.maskBoundsMax;
	out.flowVector = transformElementDirection(vec2f(stamp.flowX, stamp.flowY), et);
	out.motion = vec2f(stamp.motionSpeed, stamp.motionAccel);
	return out;
}

// OKLab perceptual色空間でグラデーションストップをサンプリング
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

	// Below first stop
	if ct <= colorStops[baseOffset].offset {
		let s = colorStops[baseOffset];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	// Above last stop
	let lastIdx = count - 1u;
	if ct >= colorStops[baseOffset + lastIdx].offset {
		let s = colorStops[baseOffset + lastIdx];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	// Find surrounding stops and interpolate in OKLab perceptual space
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

	// Fallback: return last stop
	let s = colorStops[baseOffset + lastIdx];
	return vec4f(s.r, s.g, s.b, s.a);
}

${MASK_COMMON_WGSL}

fn transformElementDirection(dir: vec2f, et: ElementTransform) -> vec2f {
	let mapped = vec2f(
		et.m00 * dir.x + et.m01 * dir.y,
		et.m10 * dir.x + et.m11 * dir.y,
	);
	let len = length(mapped);
	return select(vec2f(0.0), mapped / max(len, 1e-5), len > 1e-5);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
	let pm = pathMetas[in.pathIndex];

	// ブラシテクスチャからサンプリング
	let texColor = textureSample(brushTexture, brushSampler, in.uv);

	// Unpack colorMode from upper bits of gradientMode (bit 16)
	let gradientMode = pm.gradientMode & 0xFFFFu;
	let colorMode = (pm.gradientMode >> 16u) & 1u;

	// Color mode branching:
	// 0 (tinting): luminance-based alpha, apply brush color
	// 1 (color): use texture RGB directly, texture alpha for transparency
	var texAlpha: f32;
	var texRgb: vec3f;
	if colorMode == 1u {
		texAlpha = texColor.a;
		texRgb = texColor.rgb;
	} else {
		texAlpha = (texColor.r + texColor.g + texColor.b) / 3.0;
		texRgb = vec3f(0.0); // will be overwritten by gradient/solid color
	}

	var color: vec3f;
	var colorA: f32;

	switch gradientMode {
		// Solid color（既存動作）
		case 0u: {
			color = vec3f(pm.colorR, pm.colorG, pm.colorB);
			colorA = pm.colorA;
		}
		// Within: BBoxベースのグラデーション（線にグラデーションを適用）
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
		// Along: パスに沿ったグラデーション
		case 2u: {
			let sampled = sampleGradientStops(in.pathT, pm);
			color = sampled.rgb;
			colorA = sampled.a;
		}
		// Across: パスに交差するグラデーション（線幅方向）
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

	// Uses world-space normal direction so it is independent of stamp rotation.
	let widthFade = strokeWidthCoverage(
		in.normalizedStrokeDistance,
		in.side1Width,
		in.side2Width,
	);

	// Final alpha and color depend on color mode
	var finalColor: vec3f;
	var finalAlpha: f32;
	if colorMode == 1u {
		// Color mode: use texture RGB directly, texture alpha controls transparency
		finalAlpha = texAlpha * in.opacity * widthFade;
		finalColor = texRgb;
	} else {
		// Tinting mode (default): luminance alpha, brush color
		finalAlpha = texAlpha * in.opacity * colorA * widthFade;
		finalColor = color;
	}

	// プリマルチプライドアルファで出力
	let result = vec4f(finalColor * finalAlpha, finalAlpha);
	return applyClipMask(result, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}

struct WetFragmentOutput {
	@location(0) pigment: vec4f,
	@location(1) flow: vec4f,
	@location(2) fluid: vec4f,
	@location(3) mask: vec4f,
}

struct WetPigmentSample {
	pigment: vec4f,
	coverage: f32,
}

fn computeWetPigment(in: VertexOutput) -> WetPigmentSample {
	let pm = pathMetas[in.pathIndex];

	let texColor = textureSample(brushTexture, brushSampler, in.uv);

	let gradientMode = pm.gradientMode & 0xFFFFu;
	let colorMode = (pm.gradientMode >> 16u) & 1u;

	var texAlpha: f32;
	var texRgb: vec3f;
	if colorMode == 1u {
		texAlpha = texColor.a;
		texRgb = texColor.rgb;
	} else {
		texAlpha = (texColor.r + texColor.g + texColor.b) / 3.0;
		texRgb = vec3f(0.0);
	}

	var color: vec3f;
	var colorA: f32;

	switch gradientMode {
		case 0u: {
			color = vec3f(pm.colorR, pm.colorG, pm.colorB);
			colorA = pm.colorA;
		}
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
		case 2u: {
			let sampled = sampleGradientStops(in.pathT, pm);
			color = sampled.rgb;
			colorA = sampled.a;
		}
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

	let shapeCoverage = texAlpha * in.opacity * widthFade;

	var finalColor: vec3f;
	var pigmentAlpha: f32;
	if colorMode == 1u {
		pigmentAlpha = shapeCoverage;
		finalColor = texRgb;
	} else {
		pigmentAlpha = shapeCoverage * colorA;
		finalColor = color;
	}

	let clippedPigment = applyClipMask(vec4f(finalColor * pigmentAlpha, pigmentAlpha), in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
	let clippedCoverage = applyClipMask(vec4f(vec3f(shapeCoverage), shapeCoverage), in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos).a;
	return WetPigmentSample(clippedPigment, clippedCoverage);
}

fn encodeWetPigmentMass(premultiplied: vec4f) -> vec4f {
	let coverage = clamp(premultiplied.a, 0.0, 0.999);
	let density = -log(max(1.0 - coverage, 0.001));
	let color = premultiplied.rgb / max(coverage, 1e-5);
	return vec4f(color * density, density);
}

@fragment
fn fs_wet(in: VertexOutput) -> WetFragmentOutput {
	let wet = computeWetPigment(in);
	let cov = clamp(wet.coverage, 0.0, 1.0);
	let fallbackFlow = vec2f(in.pathNormal.y, -in.pathNormal.x);
	let fallbackLen = length(fallbackFlow);
	let flowLen = length(in.flowVector);
	let dir = select(
		select(vec2f(1.0, 0.0), fallbackFlow / max(fallbackLen, 1e-5), fallbackLen > 1e-5),
		in.flowVector / max(flowLen, 1e-5),
		flowLen > 1e-5,
	);
	let edge = smoothstep(0.02, 0.35, cov) * (1.0 - smoothstep(0.58, 0.98, cov));
	let speed = clamp(in.motion.x, 0.0, 1.0);
	let accel = clamp(in.motion.y, 0.0, 1.0);
	let slowWet = 1.0 - speed;
	let cornerBrake = clamp(1.0 - accel * (0.42 + edge * 0.28), 0.28, 1.0);
	let water = cov * (0.75 + slowWet * 0.25 + accel * 0.28);
	let flowStrength = water * (0.65 + slowWet * 0.25) * cornerBrake;
	let pooling = cov * (0.18 + slowWet * 0.35 + accel * 0.85);
	var out: WetFragmentOutput;
	out.pigment = encodeWetPigmentMass(wet.pigment);
	out.flow = vec4f(dir * cov, cov, 0.0);
	out.fluid = vec4f(0.0, 0.0, water, pooling);
	out.mask = vec4f(cov, edge, speed, accel);
	return out;
}
`;

/**
 * Scatter variant: uses texture_2d_array instead of texture_2d.
 * textureLayer is unpacked from the upper 11 bits of pathIndex.
 */
export const BRUSH_STAMP_ARRAY_SHADER = /* wgsl */ `
struct Uniforms {
	viewportX: f32,
	viewportY: f32,
	zoom: f32,
	canvasWidth: f32,
	canvasHeight: f32,
	rotSin: f32,
	rotCos: f32,
}

struct StampInstance {
	positionX: f32,
	positionY: f32,
	size: f32,
	opacity: f32,
	rotation: f32,
	pathT: f32,
	pathIndex: u32, // upper 11 bits = textureLayer, lower 21 bits = pathIndex
	sizeY: f32,
	side1Width: f32,
	side2Width: f32,
	normalX: f32,
	normalY: f32,
	flowX: f32,
	flowY: f32,
	motionSpeed: f32,
	motionAccel: f32,
}

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
@group(0) @binding(1) var<storage, read> stamps: array<StampInstance>;
@group(0) @binding(2) var brushTexture: texture_2d_array<f32>;
@group(0) @binding(3) var brushSampler: sampler;

@group(1) @binding(0) var<storage, read> pathMetas: array<PathMeta>;
@group(1) @binding(1) var<storage, read> colorStops: array<ColorStop>;

@group(2) @binding(0) var<storage, read> transforms: array<ElementTransform>;

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) uv: vec2f,
	@location(1) opacity: f32,
	@location(2) pathT: f32,
	@location(3) worldPos: vec2f,
	@location(5) @interpolate(flat) pathIndex: u32,
	@location(6) side1Width: f32,
	@location(7) side2Width: f32,
	@location(8) transformedWorldPos: vec2f,
	@location(12) pathNormal: vec2f,
	@location(13) normalizedStrokeDistance: f32,
	@location(9) @interpolate(flat) maskIndex: u32,
	@location(10) maskBoundsMin: vec2f,
	@location(11) maskBoundsMax: vec2f,
	@location(14) flowVector: vec2f,
	@location(15) motion: vec2f,
	// Slot 4 is the only free location: 0..15 is the WebGPU inter-stage limit.
	@location(4) @interpolate(flat) textureLayer: u32,
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

	let stamp = stamps[instanceIndex];
	let localPos = quadVertices[vertexIndex];

	// Unpack textureLayer (upper 11 bits) and pathIndex (lower 21 bits)
	let packedPathIndex = stamp.pathIndex;
	let actualPathIndex = packedPathIndex & ${STAMP_META_INDEX_MASK}u;
	let textureLayer = packedPathIndex >> ${STAMP_TEXTURE_LAYER_SHIFT}u;

	var effectiveSize = stamp.size;
	var effectiveSizeY = stamp.sizeY;
	if stamp.size > 0.0 {
		let minWorldSize = 1.0 / uniforms.zoom;
		effectiveSize = max(stamp.size, minWorldSize);
		effectiveSizeY = max(stamp.sizeY, minWorldSize);
	}
	let scaledPos = vec2f(localPos.x * effectiveSize, localPos.y * effectiveSizeY);

	let cos_r = cos(stamp.rotation);
	let sin_r = sin(stamp.rotation);
	let rotatedPos = vec2f(
		scaledPos.x * cos_r - scaledPos.y * sin_r,
		scaledPos.x * sin_r + scaledPos.y * cos_r
	);

	let stampWorldPos = vec2f(stamp.positionX, stamp.positionY) + rotatedPos;

	let pm = pathMetas[actualPathIndex];
	let et = transforms[pm.transformIndex];
	let worldPos = applyElementTransform(stampWorldPos, et);

	let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
	let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
	let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
	let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;
	let ndcX = rotX / (uniforms.canvasWidth * 0.5);
	let ndcY = rotY / (uniforms.canvasHeight * 0.5);

	var out: VertexOutput;
	out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
	out.uv = localPos + 0.5;
	out.opacity = stamp.opacity;
	out.pathT = stamp.pathT;
	out.worldPos = applyElementTransform(vec2f(stamp.positionX, stamp.positionY), et);
	out.pathIndex = actualPathIndex;
	out.side1Width = stamp.side1Width;
	out.side2Width = stamp.side2Width;
	out.transformedWorldPos = worldPos;
	out.pathNormal = transformElementDirection(vec2f(stamp.normalX, stamp.normalY), et);
	out.normalizedStrokeDistance = normalizedStampNormalDistance(
		rotatedPos,
		vec2f(stamp.normalX, stamp.normalY),
		vec2f(effectiveSize, effectiveSizeY) * 0.5,
		stamp.rotation,
	);
	out.maskIndex = et.maskIndex;
	out.maskBoundsMin = et.maskBoundsMin;
	out.maskBoundsMax = et.maskBoundsMax;
	out.flowVector = transformElementDirection(vec2f(stamp.flowX, stamp.flowY), et);
	out.motion = vec2f(stamp.motionSpeed, stamp.motionAccel);
	out.textureLayer = textureLayer;
	return out;
}

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

fn transformElementDirection(dir: vec2f, et: ElementTransform) -> vec2f {
	let mapped = vec2f(
		et.m00 * dir.x + et.m01 * dir.y,
		et.m10 * dir.x + et.m11 * dir.y,
	);
	let len = length(mapped);
	return select(vec2f(0.0), mapped / max(len, 1e-5), len > 1e-5);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
	let pm = pathMetas[in.pathIndex];

	// Sample from texture array with layer index
	let texColor = textureSample(brushTexture, brushSampler, in.uv, in.textureLayer);

	let gradientMode = pm.gradientMode & 0xFFFFu;
	let colorMode = (pm.gradientMode >> 16u) & 1u;

	var texAlpha: f32;
	var texRgb: vec3f;
	if colorMode == 1u {
		texAlpha = texColor.a;
		texRgb = texColor.rgb;
	} else {
		texAlpha = (texColor.r + texColor.g + texColor.b) / 3.0;
		texRgb = vec3f(0.0);
	}

	var color: vec3f;
	var colorA: f32;

	switch gradientMode {
		case 0u: {
			color = vec3f(pm.colorR, pm.colorG, pm.colorB);
			colorA = pm.colorA;
		}
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
		case 2u: {
			let sampled = sampleGradientStops(in.pathT, pm);
			color = sampled.rgb;
			colorA = sampled.a;
		}
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
		finalAlpha = texAlpha * in.opacity * widthFade;
		finalColor = texRgb;
	} else {
		finalAlpha = texAlpha * in.opacity * colorA * widthFade;
		finalColor = color;
	}

	let result = vec4f(finalColor * finalAlpha, finalAlpha);
	return applyClipMask(result, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}

struct WetFragmentOutput {
	@location(0) pigment: vec4f,
	@location(1) flow: vec4f,
	@location(2) fluid: vec4f,
	@location(3) mask: vec4f,
}

struct WetPigmentSample {
	pigment: vec4f,
	coverage: f32,
}

fn computeWetPigment(in: VertexOutput) -> WetPigmentSample {
	let pm = pathMetas[in.pathIndex];

	let texColor = textureSample(brushTexture, brushSampler, in.uv, in.textureLayer);

	let gradientMode = pm.gradientMode & 0xFFFFu;
	let colorMode = (pm.gradientMode >> 16u) & 1u;

	var texAlpha: f32;
	var texRgb: vec3f;
	if colorMode == 1u {
		texAlpha = texColor.a;
		texRgb = texColor.rgb;
	} else {
		texAlpha = (texColor.r + texColor.g + texColor.b) / 3.0;
		texRgb = vec3f(0.0);
	}

	var color: vec3f;
	var colorA: f32;

	switch gradientMode {
		case 0u: {
			color = vec3f(pm.colorR, pm.colorG, pm.colorB);
			colorA = pm.colorA;
		}
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
		case 2u: {
			let sampled = sampleGradientStops(in.pathT, pm);
			color = sampled.rgb;
			colorA = sampled.a;
		}
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

	let shapeCoverage = texAlpha * in.opacity * widthFade;

	var finalColor: vec3f;
	var pigmentAlpha: f32;
	if colorMode == 1u {
		pigmentAlpha = shapeCoverage;
		finalColor = texRgb;
	} else {
		pigmentAlpha = shapeCoverage * colorA;
		finalColor = color;
	}

	let clippedPigment = applyClipMask(vec4f(finalColor * pigmentAlpha, pigmentAlpha), in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
	let clippedCoverage = applyClipMask(vec4f(vec3f(shapeCoverage), shapeCoverage), in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos).a;
	return WetPigmentSample(clippedPigment, clippedCoverage);
}

fn encodeWetPigmentMass(premultiplied: vec4f) -> vec4f {
	let coverage = clamp(premultiplied.a, 0.0, 0.999);
	let density = -log(max(1.0 - coverage, 0.001));
	let color = premultiplied.rgb / max(coverage, 1e-5);
	return vec4f(color * density, density);
}

@fragment
fn fs_wet(in: VertexOutput) -> WetFragmentOutput {
	let wet = computeWetPigment(in);
	let cov = clamp(wet.coverage, 0.0, 1.0);
	let fallbackFlow = vec2f(in.pathNormal.y, -in.pathNormal.x);
	let fallbackLen = length(fallbackFlow);
	let flowLen = length(in.flowVector);
	let dir = select(
		select(vec2f(1.0, 0.0), fallbackFlow / max(fallbackLen, 1e-5), fallbackLen > 1e-5),
		in.flowVector / max(flowLen, 1e-5),
		flowLen > 1e-5,
	);
	let edge = smoothstep(0.02, 0.35, cov) * (1.0 - smoothstep(0.58, 0.98, cov));
	let speed = clamp(in.motion.x, 0.0, 1.0);
	let accel = clamp(in.motion.y, 0.0, 1.0);
	let slowWet = 1.0 - speed;
	let cornerBrake = clamp(1.0 - accel * (0.42 + edge * 0.28), 0.28, 1.0);
	let water = cov * (0.75 + slowWet * 0.25 + accel * 0.28);
	let flowStrength = water * (0.65 + slowWet * 0.25) * cornerBrake;
	let pooling = cov * (0.18 + slowWet * 0.35 + accel * 0.85);
	var out: WetFragmentOutput;
	out.pigment = encodeWetPigmentMass(wet.pigment);
	out.flow = vec4f(dir * cov, cov, 0.0);
	out.fluid = vec4f(0.0, 0.0, water, pooling);
	out.mask = vec4f(cov, edge, speed, accel);
	return out;
}
`;

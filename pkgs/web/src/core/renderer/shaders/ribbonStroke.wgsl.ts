/**
 * Ribbon Stroke Shader - UV-mapped texture along bezier curves.
 *
 * Uses bezier segment instancing: GPU vertex shader evaluates bezier position
 * and normal, then applies UV mapping based on arc-length prefix sums.
 * Texture repeats seamlessly along the path using addressModeU: "repeat".
 *
 * Vertex buffer 0: [t, side] per vertex (static unit buffer, same as bezierPath)
 * Instance data: storage buffer with per-segment metadata (24 floats)
 */

import { GRADIENT_COMMON_WGSL } from "./gradientCommon.wgsl";
import { MASK_COMMON_WGSL } from "./maskCommon.wgsl";
import { STROKE_WIDTH_COMMON_WGSL } from "./strokeWidthCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

export const RIBBON_STROKE_SHADER = /* wgsl */ `
struct Uniforms {
	viewportX: f32,
	viewportY: f32,
	zoom: f32,
	canvasWidth: f32,
	canvasHeight: f32,
	rotSin: f32,
	rotCos: f32,
}

struct RibbonInstance {
	p0x: f32,
	p0y: f32,
	cp1x: f32,
	cp1y: f32,
	cp2x: f32,
	cp2y: f32,
	p1x: f32,
	p1y: f32,
	halfWidth0: f32,
	halfWidth1: f32,
	side1Width0: f32,
	side1Width1: f32,
	side2Width0: f32,
	side2Width1: f32,
	arcLengthOffset: f32,
	segmentArcLength: f32,
	pathT0: f32,
	pathT1: f32,
	pathIndex: u32,
	totalArcLength: f32,
	opacity: f32,
	colorModeBit: f32,
	joinAngle0: f32,
	joinAngle1: f32,
	uvModeBit: u32,    // 0 = repeat (pattern), 1 = stretch (art)
	flipBits: u32,     // bit0 = flipU, bit1 = flipV
	tileSpacing: f32,
	reserved: f32,
}

struct RibbonParams {
	ribbonStretch: f32,
	uvOffset: f32,
	textureAspectRatio: f32,
	stampAngle: f32,
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
@group(0) @binding(1) var<storage, read> instances: array<RibbonInstance>;
@group(0) @binding(2) var ribbonTexture: texture_2d<f32>;
@group(0) @binding(3) var ribbonSampler: sampler;
@group(0) @binding(4) var<uniform> ribbonParams: RibbonParams;

@group(1) @binding(0) var<storage, read> pathMetas: array<PathMeta>;
@group(1) @binding(1) var<storage, read> colorStops: array<ColorStop>;

@group(2) @binding(0) var<storage, read> transforms: array<ElementTransform>;

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

struct VertexInput {
	@location(0) tAndSide: vec2f,
}

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) ribbonUV: vec2f,
	@location(1) pathT: f32,
	@location(2) opacity: f32,
	@location(3) worldPos: vec2f,
	@location(4) @interpolate(flat) pathIndex: u32,
	@location(5) side1Width: f32,
	@location(6) side2Width: f32,
	@location(7) transformedWorldPos: vec2f,
	@location(8) side: f32,
	@location(9) halfWidth: f32,
	@location(10) @interpolate(flat) colorMode: u32,
	@location(11) @interpolate(flat) maskIndex: u32,
	@location(12) maskBoundsMin: vec2f,
	@location(13) maskBoundsMax: vec2f,
	@location(14) @interpolate(flat) uvModeBit: u32,
	@location(15) tileSpacing: f32,
}

@vertex
fn vs_main(
	vertex: VertexInput,
	@builtin(instance_index) instanceIndex: u32
) -> VertexOutput {
	let inst = instances[instanceIndex];
	let t = vertex.tAndSide.x;
	let side = vertex.tAndSide.y;

	let p0 = vec2f(inst.p0x, inst.p0y);
	let cp1 = vec2f(inst.cp1x, inst.cp1y);
	let cp2 = vec2f(inst.cp2x, inst.cp2y);
	let p1 = vec2f(inst.p1x, inst.p1y);

	// Cubic bezier evaluation
	let mt = 1.0 - t;
	let mt2 = mt * mt;
	let mt3 = mt2 * mt;
	let t2 = t * t;
	let t3 = t2 * t;
	let pos = mt3 * p0 + 3.0 * mt2 * t * cp1 + 3.0 * mt * t2 * cp2 + t3 * p1;

	// Tangent and normal
	let tang = mt2 * (cp1 - p0) + 2.0 * mt * t * (cp2 - cp1) + t2 * (p1 - cp2);
	var tangFinal = tang;
	if length(tang) < 0.00001 {
		tangFinal = p1 - p0;
	}
	let finalLen = length(tangFinal);
	var normal = vec2f(0.0, 0.0);
	if finalLen > 0.00001 {
		normal = vec2f(-tangFinal.y, tangFinal.x) / finalLen;
	}

	// Junction normal blending at segment boundaries
	let rawAngle = atan2(tangFinal.y, tangFinal.x);
	let hasJoin0 = inst.joinAngle0 < 1e20;
	let hasJoin1 = inst.joinAngle1 < 1e20;

	let blend0 = select(0.0, 1.0 - smoothstep(0.0, 0.15, t), hasJoin0);
	let blend1 = select(0.0, smoothstep(0.85, 1.0, t), hasJoin1);

	var finalAngle = rawAngle;
	if blend0 > 0.0 {
		var d0 = rawAngle - inst.joinAngle0;
		if d0 > 3.14159 { d0 -= 6.28318; }
		if d0 < -3.14159 { d0 += 6.28318; }
		finalAngle = inst.joinAngle0 + d0 * (1.0 - blend0);
	}
	if blend1 > 0.0 {
		var d1 = inst.joinAngle1 - finalAngle;
		if d1 > 3.14159 { d1 -= 6.28318; }
		if d1 < -3.14159 { d1 += 6.28318; }
		finalAngle = finalAngle + d1 * blend1;
	}

	if blend0 > 0.0 || blend1 > 0.0 {
		normal = vec2f(-sin(finalAngle), cos(finalAngle));
	}

	// Interpolate half-width and stroke width profile
	let hw = mix(inst.halfWidth0, inst.halfWidth1, t);
	let s1w = mix(inst.side1Width0, inst.side1Width1, t);
	let s2w = mix(inst.side2Width0, inst.side2Width1, t);

	// Preserve the original cross-stroke coordinate while clipping the visible interval.
	let normalizedSide = strokeWidthPosition(side, s1w, s2w);
	let localPos = pos + normal * hw * normalizedSide;

	// Apply element transform
	let pm = pathMetas[inst.pathIndex];
	let et = transforms[pm.transformIndex];
	let worldPos = applyElementTransform(localPos, et);

	// World → NDC
	let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
	let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
	let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
	let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;
	let ndcX = rotX / (uniforms.canvasWidth * 0.5);
	let ndcY = rotY / (uniforms.canvasHeight * 0.5);

	// UV mapping
	//   stretch (art): U = arcPos / totalArcLength (single tile spans the path)
	//   repeat (pattern): U = arcPos / actualTileWidth (tiles wrap via sampler)
	// V is always side-based (-1..+1 → 0..1).
	let arcPos = inst.arcLengthOffset + t * inst.segmentArcLength;
	let naturalTileWidth = inst.halfWidth0 * 2.0 * ribbonParams.textureAspectRatio;
	let actualTileWidth = naturalTileWidth * max(1.0 + ribbonParams.ribbonStretch, 0.1);
	var ribbonU: f32;
	if inst.uvModeBit == 1u {
		// stretch: U = arc-length normalized over the whole path
		let total = max(inst.totalArcLength, 0.001);
		ribbonU = clamp(arcPos / total, 0.0, 1.0);
	} else {
		ribbonU = arcPos / max(actualTileWidth, 0.001) + ribbonParams.uvOffset;
	}
	var ribbonV = strokeWidthAcrossUV(normalizedSide);

	// Per-instance flip flags (only meaningful in stretch mode)
	if inst.uvModeBit == 1u {
		if ((inst.flipBits & 1u) != 0u) {
			ribbonU = 1.0 - ribbonU;
		}
		if ((inst.flipBits & 2u) != 0u) {
			ribbonV = 1.0 - ribbonV;
		}
	}

	let pathT = mix(inst.pathT0, inst.pathT1, t);

	var out: VertexOutput;
	out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
	out.ribbonUV = vec2f(ribbonU, ribbonV);
	out.uvModeBit = inst.uvModeBit;
	out.tileSpacing = inst.tileSpacing;
	out.pathT = pathT;
	out.opacity = inst.opacity;
	out.worldPos = applyElementTransform(pos, et);
	out.pathIndex = inst.pathIndex;
	out.side1Width = s1w;
	out.side2Width = s2w;
	out.transformedWorldPos = worldPos;
	out.side = side;
	out.halfWidth = hw;
	out.colorMode = u32(inst.colorModeBit);
	out.maskIndex = et.maskIndex;
	out.maskBoundsMin = et.maskBoundsMin;
	out.maskBoundsMax = et.maskBoundsMax;
	return out;
}

fn sampleGradientStops(t: f32, pm: PathMeta) -> vec4f {
	let ct = clamp(t, 0.0, 1.0);
	let count = pm.stopCount;
	let baseOffset = pm.stopOffset;

	if count == 0u { return vec4f(0.0, 0.0, 0.0, 1.0); }
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
			if range > 0.0 { f = remapGradientT((ct - s0.offset) / range, s0.midpoint); }
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
	let pm = pathMetas[in.pathIndex];

	// Rotate UV by stampAngle around (0.5, 0.5) center
	let angle = ribbonParams.stampAngle;
	let cosA = cos(angle);
	let sinA = sin(angle);
	var sampleU = in.ribbonUV.x;
	var gapMask: f32 = 1.0;
	if in.uvModeBit == 0u && in.tileSpacing > 0.0 {
		// Repeat with gap: each tile occupies the [0, 1] portion of a period of
		// (1 + tileSpacing). The fragment is in a gap when fract(u) > 1 / period.
		let period = 1.0 + in.tileSpacing;
		let phase = sampleU - floor(sampleU / period) * period;
		if phase > 1.0 {
			gapMask = 0.0;
		}
		sampleU = phase;
	}
	let centered = vec2f(sampleU, in.ribbonUV.y) - vec2f(0.5, 0.5);
	let rotated = vec2f(
		centered.x * cosA - centered.y * sinA,
		centered.x * sinA + centered.y * cosA,
	) + vec2f(0.5, 0.5);

	// Sample ribbon texture (U repeats via sampler addressModeU)
	let texColor = textureSample(ribbonTexture, ribbonSampler, rotated);

	let gradientMode = pm.gradientMode & 0xFFFFu;

	var texAlpha: f32;
	var texRgb: vec3f;
	if in.colorMode == 1u {
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
			if lenSq > 0.0 { t = dot(uv - pm.linearStart, dir) / lenSq; }
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
			let sampled = sampleGradientStops(in.ribbonUV.y, pm);
			color = sampled.rgb;
			colorA = sampled.a;
		}
		default: {
			color = vec3f(0.0, 0.0, 0.0);
			colorA = 1.0;
		}
	}

	let normalizedSide = strokeWidthPosition(
		in.side,
		in.side1Width,
		in.side2Width,
	);
	var widthFade = strokeWidthCoverage(
		normalizedSide,
		in.side1Width,
		in.side2Width,
	);
	// Inter-tile gap mask (pattern mode only when tileSpacing > 0)
	widthFade = widthFade * gapMask;

	var finalColor: vec3f;
	var finalAlpha: f32;
	if in.colorMode == 1u {
		finalAlpha = texAlpha * in.opacity * widthFade;
		finalColor = texRgb;
	} else {
		finalAlpha = texAlpha * in.opacity * colorA * widthFade;
		finalColor = color;
	}

	let result = vec4f(finalColor * finalAlpha, finalAlpha);
	return applyClipMask(result, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}
`;

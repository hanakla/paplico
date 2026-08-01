/**
 * Unified Geometry Shader — handles solid fill, stroke, and gradient fill
 * in a single shader module via the `gradientType` uniform discriminator.
 *
 * Bind groups:
 *   BG0: Viewport uniforms (shared by all renderers)
 *   BG1: Element transforms storage buffer
 *   BG2: Gradient data (uniform + colorStops + free texture + sampler + mesh buffers)
 *        For solid fills, gradientType=0 and the fragment uses vertex color.
 *
 * This shader replaces the separate stroke.wgsl and gradientFill.wgsl,
 * enabling a single pipeline to render all geometry types.
 */

import { GRADIENT_COMMON_WGSL } from "./gradientCommon.wgsl";
import { MASK_COMMON_WGSL } from "./maskCommon.wgsl";
import { TRANSFORM_COMMON_WGSL } from "./transformCommon.wgsl";

export const UNIFIED_GEOMETRY_SHADER = /* wgsl */ `
struct Uniforms {
	viewportX: f32,
	viewportY: f32,
	zoom: f32,
	canvasWidth: f32,
	canvasHeight: f32,
	rotSin: f32,
	rotCos: f32,
}

struct GradientUniforms {
	gradientType: u32,
	stopCount: u32,
	meshFaceCount: u32,
	// StrokeGradientMode for geometric strokes: 0 = within (bounds-space),
	// 1 = along (sample stops at vertex t in color.r), 2 = across (vertex u
	// in color.g). Always 0 for fills.
	strokeGradientMode: u32,
	linearStart: vec2f,
	linearEnd: vec2f,
	radialCenter: vec2f,
	radialRadiusX: f32,
	radialRadiusY: f32,
	radialRotation: f32,
	boundsMin: vec2f,
	boundsMax: vec2f,
	// Pattern fill parameters (gradientType == 5). World-space transform applied
	// before sampling the tile texture; tile size determines the wrap period.
	patternOffset: vec2f,
	patternScale: vec2f,
	patternRotation: f32,
	patternTileWidth: f32,
	patternTileHeight: f32,
	_pad1: f32,
	// Tile-grid anchor: the element's tight geometry top-left in world space.
	// boundsMin/Max arrive fringe-expanded for fills, so the anchor is
	// carried separately.
	patternAnchor: vec2f,
}

struct MeshFace {
	faceType: u32,
	vertCount: u32,
	i0: u32,
	i1: u32,
	i2: u32,
	i3: u32,
	bboxMinX: f32,
	bboxMinY: f32,
	bboxMaxX: f32,
	bboxMaxY: f32,
	_pad1: u32,
	_pad2: u32,
}

struct MeshEdgeCurve {
	p0: vec2f,
	p1: vec2f,
	p2: vec2f,
	p3: vec2f,
}

struct MeshVertex {
	color: vec4f,
	pos: vec2f,
	_pad: vec2f,
}

${TRANSFORM_COMMON_WGSL}

${GRADIENT_COMMON_WGSL}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var<storage, read> transforms: array<ElementTransform>;

@group(2) @binding(0) var<uniform> gradient: GradientUniforms;
@group(2) @binding(1) var<storage, read> colorStops: array<ColorStop>;
@group(2) @binding(2) var meshTexture: texture_2d<f32>;
@group(2) @binding(3) var meshSampler: sampler;
@group(2) @binding(4) var<storage, read> meshVerts: array<MeshVertex>;
@group(2) @binding(5) var<storage, read> meshFaces: array<MeshFace>;
@group(2) @binding(6) var<storage, read> meshEdgeCurves: array<MeshEdgeCurve>;

@group(3) @binding(0) var maskAtlas: texture_2d<f32>;
@group(3) @binding(1) var maskSampler: sampler;

struct VertexInput {
	@location(0) position: vec2f,
	@location(1) color: vec4f,
	@location(2) offset: vec2f,
	@location(3) elementIndex: u32,
}

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) color: vec4f,
	@location(1) worldPos: vec2f,
	@location(2) @interpolate(flat) maskIndex: u32,
	@location(3) maskBoundsMin: vec2f,
	@location(4) maskBoundsMax: vec2f,
	@location(5) transformedWorldPos: vec2f,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
	var out: VertexOutput;
	let et = transforms[in.elementIndex];
	let transformed = applyElementTransform(in.position, et);
	let worldPos = transformed + in.offset * (1.0 / uniforms.zoom);
	let relX = (worldPos.x - uniforms.viewportX) * uniforms.zoom;
	let relY = (worldPos.y - uniforms.viewportY) * uniforms.zoom;
	let rotX = relX * uniforms.rotCos - relY * uniforms.rotSin;
	let rotY = relX * uniforms.rotSin + relY * uniforms.rotCos;
	let ndcX = rotX / (uniforms.canvasWidth * 0.5);
	let ndcY = rotY / (uniforms.canvasHeight * 0.5);
	out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
	out.color = in.color;
	// Pre-transform position for gradient UV calculation.
	// CPU-side boundsMin/boundsMax are in local (pre-transform) space.
	out.worldPos = in.position + in.offset * (1.0 / uniforms.zoom);
	out.maskIndex = et.maskIndex;
	out.maskBoundsMin = et.maskBoundsMin;
	out.maskBoundsMax = et.maskBoundsMax;
	// Post-transform world-space position for clip mask UV calculation.
	out.transformedWorldPos = worldPos;
	return out;
}

fn sampleGradientStops(t: f32) -> vec4f {
	let ct = clamp(t, 0.0, 1.0);
	let count = gradient.stopCount;

	if count == 0u {
		return vec4f(0.0, 0.0, 0.0, 1.0);
	}
	if count == 1u {
		let s = colorStops[0];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	// Below first stop
	if ct <= colorStops[0].offset {
		let s = colorStops[0];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	// Above last stop
	let lastIdx = count - 1u;
	if ct >= colorStops[lastIdx].offset {
		let s = colorStops[lastIdx];
		return vec4f(s.r, s.g, s.b, s.a);
	}

	// Find surrounding stops and interpolate in OKLab perceptual space
	for (var i = 0u; i < lastIdx; i = i + 1u) {
		let s0 = colorStops[i];
		let s1 = colorStops[i + 1u];
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
	let s = colorStops[lastIdx];
	return vec4f(s.r, s.g, s.b, s.a);
}

fn meshCubicBez(p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, t: f32) -> vec2f {
	let mt = 1.0 - t;
	let mt2 = mt * mt;
	let t2 = t * t;
	return mt2 * mt * p0 + 3.0 * mt2 * t * p1 + 3.0 * mt * t2 * p2 + t2 * t * p3;
}

fn rayCrossMeshBezierEdge(px: f32, py: f32, ec: MeshEdgeCurve) -> u32 {
	var crossings: u32 = 0u;
	let steps: u32 = 32u;
	var prevP = ec.p0;
	for (var i = 1u; i <= steps; i = i + 1u) {
		let t = f32(i) / f32(steps);
		let curP = meshCubicBez(ec.p0, ec.p1, ec.p2, ec.p3, t);
		if ((prevP.y <= py && curP.y > py) || (curP.y <= py && prevP.y > py)) {
			let frac = (py - prevP.y) / (curP.y - prevP.y);
			let ix = prevP.x + frac * (curP.x - prevP.x);
			if ix > px {
				crossings += 1u;
			}
		}
		prevP = curP;
	}
	return crossings;
}

fn pointInMeshFace(px: f32, py: f32, faceIdx: u32, face: MeshFace) -> bool {
	let edgeCount = select(3u, 4u, face.faceType == 0u);
	var crossings: u32 = 0u;
	for (var edgeIdx = 0u; edgeIdx < edgeCount; edgeIdx = edgeIdx + 1u) {
		crossings += rayCrossMeshBezierEdge(
			px,
			py,
			meshEdgeCurves[faceIdx * 4u + edgeIdx],
		);
	}
	return (crossings & 1u) == 1u;
}

fn bilinearUV(px: f32, py: f32, p00: vec2f, p10: vec2f, p11: vec2f, p01: vec2f) -> vec2f {
	let p = vec2f(px, py);
	let e = p10 - p00;
	let f = p01 - p00;
	let g = p00 - p10 + p11 - p01;
	let h = p - p00;

	let aq = f.x * g.y - f.y * g.x;
	let bq = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
	let cq = h.x * e.y - h.y * e.x;

	var bestU = 0.5f;
	var bestV = 0.5f;
	var bestErr = 1e10f;

	if abs(aq) < 1e-5 {
		if abs(bq) > 1e-10 {
			let v0 = -cq / bq;
			let denom = e.x + v0 * g.x;
			var u0 = 0.5f;
			if abs(denom) > 1e-10 {
				u0 = (h.x - v0 * f.x) / denom;
			} else {
				let denomY = e.y + v0 * g.y;
				if abs(denomY) > 1e-10 {
					u0 = (h.y - v0 * f.y) / denomY;
				}
			}
			bestU = u0;
			bestV = v0;
		}
	} else {
		let disc = bq * bq - 4.0 * aq * cq;
		if disc >= 0.0 {
			let sq = sqrt(disc);
			let v1 = (-bq + sq) / (2.0 * aq);
			let v2 = (-bq - sq) / (2.0 * aq);
			for (var vi = 0u; vi < 2u; vi = vi + 1u) {
				let vv = select(v2, v1, vi == 0u);
				let denom = e.x + vv * g.x;
				var uu = 0.5f;
				if abs(denom) > 1e-10 {
					uu = (h.x - vv * f.x) / denom;
				} else {
					let denomY = e.y + vv * g.y;
					if abs(denomY) > 1e-10 {
						uu = (h.y - vv * f.y) / denomY;
					}
				}
				let uc = clamp(uu, 0.0, 1.0);
				let vc = clamp(vv, 0.0, 1.0);
				let recon =
					(1.0 - uc) * (1.0 - vc) * p00 +
					uc * (1.0 - vc) * p10 +
					uc * vc * p11 +
					(1.0 - uc) * vc * p01;
				let er = dot(recon - p, recon - p);
				if er < bestErr {
					bestErr = er;
					bestU = uc;
					bestV = vc;
				}
			}
		}
	}
	return vec2f(clamp(bestU, 0.0, 1.0), clamp(bestV, 0.0, 1.0));
}

fn evalMeshFaceEdge(faceIdx: u32, edgeIdx: u32, t: f32) -> vec2f {
	let ec = meshEdgeCurves[faceIdx * 4u + edgeIdx];
	return meshCubicBez(ec.p0, ec.p1, ec.p2, ec.p3, t);
}

fn coonsMeshColor(faceIdx: u32, face: MeshFace, u: f32, v: f32) -> vec4f {
	let c00 = srgbToOklab(meshVerts[face.i0].color.xyz);
	let c10 = srgbToOklab(meshVerts[face.i1].color.xyz);
	let c11 = srgbToOklab(meshVerts[face.i2].color.xyz);
	let c01 = srgbToOklab(meshVerts[face.i3].color.xyz);
	let ec0 = c00 + (c10 - c00) * u;
	let ec1 = c01 + (c11 - c01) * u;
	let ed0 = c00 + (c01 - c00) * v;
	let ed1 = c10 + (c11 - c10) * v;
	let mu = 1.0 - u;
	let mv = 1.0 - v;
	let rgb = oklabToSrgb(
		mv * ec0 + v * ec1 + mu * ed0 + u * ed1 -
			mu * mv * c00 - u * mv * c10 - u * v * c11 - mu * v * c01,
	);
	let alpha =
		meshVerts[face.i0].color.w * (1.0 - u) * (1.0 - v) +
		meshVerts[face.i1].color.w * u * (1.0 - v) +
		meshVerts[face.i2].color.w * u * v +
		meshVerts[face.i3].color.w * (1.0 - u) * v;
	return vec4f(rgb, alpha);
}

fn sampleMeshGradient(uv: vec2f) -> vec4f {
	for (var faceIdx = 0u; faceIdx < gradient.meshFaceCount; faceIdx = faceIdx + 1u) {
		let face = meshFaces[faceIdx];
		if (
			uv.x < face.bboxMinX || uv.x > face.bboxMaxX ||
			uv.y < face.bboxMinY || uv.y > face.bboxMaxY
		) {
			continue;
		}
		if !pointInMeshFace(uv.x, uv.y, faceIdx, face) {
			continue;
		}

		if face.faceType == 0u {
			let p00 = meshVerts[face.i0].pos;
			let p10 = meshVerts[face.i1].pos;
			let p11 = meshVerts[face.i2].pos;
			let p01 = meshVerts[face.i3].pos;
			var bestU = 0.5f;
			var bestV = 0.5f;
			var bestErr = 1e10f;
			let bilinearSeed = bilinearUV(uv.x, uv.y, p00, p10, p11, p01);
			let seeds = array<vec2f, 6>(
				bilinearSeed,
				vec2f(0.5, 0.5),
				vec2f(0.25, 0.25),
				vec2f(0.75, 0.25),
				vec2f(0.75, 0.75),
				vec2f(0.25, 0.75),
			);
			for (var seedIdx = 0u; seedIdx < 6u; seedIdx = seedIdx + 1u) {
				var su = seeds[seedIdx].x;
				var sv = seeds[seedIdx].y;
				for (var iter = 0u; iter < 12u; iter = iter + 1u) {
					let c0 = evalMeshFaceEdge(faceIdx, 0u, su);
					let c1 = evalMeshFaceEdge(faceIdx, 2u, su);
					let d0 = evalMeshFaceEdge(faceIdx, 3u, sv);
					let d1 = evalMeshFaceEdge(faceIdx, 1u, sv);
					let mu = 1.0 - su;
					let mv = 1.0 - sv;
					let c =
						mv * c0 + sv * c1 + mu * d0 + su * d1 -
						mu * mv * p00 - su * mv * p10 - su * sv * p11 - mu * sv * p01;
					let e = c - uv;
					if dot(e, e) < 1e-10 {
						break;
					}
					let eps = 0.001;
					let cu0 = evalMeshFaceEdge(faceIdx, 0u, su + eps);
					let cu1 = evalMeshFaceEdge(faceIdx, 2u, su + eps);
					let cu =
						mv * cu0 + sv * cu1 + mu * d0 + (su + eps) * d1 -
						mu * mv * p00 - (su + eps) * mv * p10 -
						(su + eps) * sv * p11 - mu * sv * p01;
					let cv0 = evalMeshFaceEdge(faceIdx, 3u, sv + eps);
					let cv1 = evalMeshFaceEdge(faceIdx, 1u, sv + eps);
					let cv =
						(1.0 - sv - eps) * c0 + (sv + eps) * c1 + mu * cv0 + su * cv1 -
						mu * (1.0 - sv - eps) * p00 - su * (1.0 - sv - eps) * p10 -
						su * (sv + eps) * p11 - mu * (sv + eps) * p01;
					let dFu = (cu - c) / eps;
					let dFv = (cv - c) / eps;
					let det = dFu.x * dFv.y - dFu.y * dFv.x;
					if abs(det) < 1e-12 {
						break;
					}
					su += -(dFv.y * e.x - dFv.x * e.y) / det;
					sv += -(-dFu.y * e.x + dFu.x * e.y) / det;
				}
				let uc = clamp(su, 0.0, 1.0);
				let vc = clamp(sv, 0.0, 1.0);
				let fc0 = evalMeshFaceEdge(faceIdx, 0u, uc);
				let fc1 = evalMeshFaceEdge(faceIdx, 2u, uc);
				let fd0 = evalMeshFaceEdge(faceIdx, 3u, vc);
				let fd1 = evalMeshFaceEdge(faceIdx, 1u, vc);
				let mmu = 1.0 - uc;
				let mmv = 1.0 - vc;
				let fc =
					mmv * fc0 + vc * fc1 + mmu * fd0 + uc * fd1 -
					mmu * mmv * p00 - uc * mmv * p10 - uc * vc * p11 - mmu * vc * p01;
				let er = dot(fc - uv, fc - uv);
				if er < bestErr {
					bestErr = er;
					bestU = uc;
					bestV = vc;
				}
				if bestErr < 1e-10 {
					break;
				}
			}
			return coonsMeshColor(faceIdx, face, bestU, bestV);
		}

		let v0 = meshVerts[face.i0].pos;
		let v1 = meshVerts[face.i1].pos;
		let v2 = meshVerts[face.i2].pos;
		let d0 = v1 - v0;
		let d1 = v2 - v0;
		let d2 = uv - v0;
		let dd00 = dot(d0, d0);
		let dd01 = dot(d0, d1);
		let dd11 = dot(d1, d1);
		let dd20 = dot(d2, d0);
		let dd21 = dot(d2, d1);
		let denom = dd00 * dd11 - dd01 * dd01;
		if abs(denom) <= 1e-12 {
			return vec4f(0.0);
		}
		let l1 = (dd11 * dd20 - dd01 * dd21) / denom;
		let l2 = (dd00 * dd21 - dd01 * dd20) / denom;
		let l0 = 1.0 - l1 - l2;
		let c0 = srgbToOklab(meshVerts[face.i0].color.xyz);
		let c1 = srgbToOklab(meshVerts[face.i1].color.xyz);
		let c2 = srgbToOklab(meshVerts[face.i2].color.xyz);
		let w0 = max(l0, 0.0);
		let w1 = max(l1, 0.0);
		let w2 = max(l2, 0.0);
		let rgb = oklabToSrgb(w0 * c0 + w1 * c1 + w2 * c2);
		let alpha =
			w0 * meshVerts[face.i0].color.w +
			w1 * meshVerts[face.i1].color.w +
			w2 * meshVerts[face.i2].color.w;
		return vec4f(rgb, alpha);
	}
	return vec4f(0.0);
}

${MASK_COMMON_WGSL}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
	let opacity = clamp(in.color.a, 0.0, 1.0);
	let boundsSize = gradient.boundsMax - gradient.boundsMin;
	let uv = (in.worldPos - gradient.boundsMin) / boundsSize;

	var color: vec4f;

	switch gradient.gradientType {
		// Solid: use vertex color directly (premultiplied alpha)
		case 0u: {
			let solidA = in.color.a;
			let solid = vec4f(in.color.rgb * solidA, solidA);
			return applyClipMask(solid, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
		}
		// Linear gradient
		case 1u: {
			if gradient.strokeGradientMode == 1u {
				color = sampleGradientStops(in.color.r);
			} else if gradient.strokeGradientMode == 2u {
				color = sampleGradientStops(in.color.g);
			} else {
				let dir = gradient.linearEnd - gradient.linearStart;
				let lenSq = dot(dir, dir);
				var t = 0.0;
				if lenSq > 0.0 {
					t = dot(uv - gradient.linearStart, dir) / lenSq;
				}
				color = sampleGradientStops(t);
			}
		}
		// Radial gradient (ellipse with rotation)
		case 2u: {
			if gradient.strokeGradientMode == 1u {
				color = sampleGradientStops(in.color.r);
			} else if gradient.strokeGradientMode == 2u {
				color = sampleGradientStops(in.color.g);
			} else {
				let delta = uv - gradient.radialCenter;

				// Apply inverse rotation to align with axis
				let cosTheta = cos(-gradient.radialRotation);
				let sinTheta = sin(-gradient.radialRotation);
				let rotatedDelta = vec2f(
					delta.x * cosTheta - delta.y * sinTheta,
					delta.x * sinTheta + delta.y * cosTheta
				);

				// Ellipse distance calculation
				let normalizedDist = vec2f(
					rotatedDelta.x / max(gradient.radialRadiusX, 0.0001),
					rotatedDelta.y / max(gradient.radialRadiusY, 0.0001)
				);
				let t = length(normalizedDist);
				color = sampleGradientStops(t);
			}
		}
		// Free-form gradient
		case 3u: {
			let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
			color = textureSample(meshTexture, meshSampler, clampedUV);
		}
		// Mesh gradient
		case 4u: {
			let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
			color = sampleMeshGradient(clampedUV);
		}
		// Pattern fill — tile from the element's top-left corner.
		// Uses pre-transform local coords so the pattern moves with the object.
		case 5u: {
			let local = in.worldPos - gradient.patternAnchor;
			// Flip Y so screen-downward is positive (tile rows top→bottom)
			let objectRel = vec2f(local.x, -local.y) - gradient.patternOffset;
			let cosR = cos(-gradient.patternRotation);
			let sinR = sin(-gradient.patternRotation);
			let rotated = vec2f(
				objectRel.x * cosR - objectRel.y * sinR,
				objectRel.x * sinR + objectRel.y * cosR,
			);
			let sx = max(abs(gradient.patternScale.x), 1e-6);
			let sy = max(abs(gradient.patternScale.y), 1e-6);
			let scaled = vec2f(rotated.x / sx, rotated.y / sy);
			let tw = max(gradient.patternTileWidth, 1e-6);
			let th = max(gradient.patternTileHeight, 1e-6);
			let tileUV = vec2f(fract(scaled.x / tw), fract(scaled.y / th));
			let sampled = textureSampleLevel(meshTexture, meshSampler, tileUV, 0.0);
			if (sampled.a > 0.0) {
				color = vec4f(min(sampled.rgb / sampled.a, vec3f(1.0)), sampled.a);
			} else {
				color = vec4f(0.0);
			}
		}
		default: {
			let fallbackA = in.color.a;
			let fallback = vec4f(in.color.rgb * fallbackA, fallbackA);
			return applyClipMask(fallback, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
		}
	}

	// Output in premultiplied alpha format
	let outA = color.a * opacity;
	let result = vec4f(color.rgb * outA, outA);
	return applyClipMask(result, in.maskIndex, in.maskBoundsMin, in.maskBoundsMax, in.transformedWorldPos);
}
`;

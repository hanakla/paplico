/**
 * Compute shader for generating mesh-gradient textures via
 * "Bézier polygon hit test + Coons Patch color interpolation (no holes)".
 *
 * Ported from the prototype at pkgs/web/src/app/proto/mesh-gradient/page.tsx
 * (POLY_SHADER).
 *
 * ## Pipeline overview
 * 1. CPU packs vertices (color + bounds-relative position), faces
 *    (quad/tri metadata + bounding box), and per-face edge curves
 *    (4 cubic Béziers per quad face; 3 per tri face, last slot unused).
 * 2. Per pixel the shader iterates faces, skipping by bounding box.
 * 3. Ray crossing count through the face's Bézier edges (32 steps each)
 *    determines inside/outside.
 * 4. Quad: inverse Coons map via Newton iteration (bilinear seed +
 *    5 fallback seeds × 12 iterations) recovers (u, v). Color is the
 *    Coons Patch blend of corner/edge colors in OKLab space.
 *    Tri: barycentric coordinates directly blend corner colors.
 *
 * ## GPU inputs
 * - binding 0: Uniforms (width, height, faceCount, pad)
 * - binding 1: Vertex[] (color + bounds-relative position per vertex)
 * - binding 2: Face[] (12 u32 words per face: type, vertCount, i0..i3,
 *              bboxMinX, bboxMinY, bboxMaxX, bboxMaxY, pad0, pad1)
 * - binding 3: EdgeCurve[] (4 per face; 8 floats per curve — p0..p3)
 * - binding 4: output storage texture (rgba8unorm)
 */
export const MESH_GRADIENT_COMPUTE_SHADER = /* wgsl */ `
struct Uniforms { width: u32, height: u32, faceCount: u32, _pad: u32, }
struct Face { faceType: u32, vertCount: u32, i0: u32, i1: u32, i2: u32, i3: u32, bboxMinX: f32, bboxMinY: f32, bboxMaxX: f32, bboxMaxY: f32, _pad0: u32, _pad1: u32, }
struct EdgeCurve { p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, }
struct Vertex { color: vec4f, pos: vec2f, _pad: vec2f, }

@group(0) @binding(0) var<uniform> params: Uniforms;
@group(0) @binding(1) var<storage, read> verts: array<Vertex>;
@group(0) @binding(2) var<storage, read> faceData: array<Face>;
@group(0) @binding(3) var<storage, read> edgeCurves: array<EdgeCurve>;
@group(0) @binding(4) var output: texture_storage_2d<rgba8unorm, write>;

fn srgbToLinear(c: f32) -> f32 { if c <= 0.04045 { return c / 12.92; } return pow((c + 0.055) / 1.055, 2.4); }
fn linearToSrgb(c: f32) -> f32 { if c <= 0.0031308 { return c * 12.92; } return 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
fn toOklab(c: vec3f) -> vec3f {
	let r = srgbToLinear(c.x); let g = srgbToLinear(c.y); let b = srgbToLinear(c.z);
	let l = 0.4122214708*r + 0.5363325363*g + 0.0514459929*b;
	let m = 0.2119034982*r + 0.6806995451*g + 0.1073969566*b;
	let s = 0.0883024619*r + 0.2817188376*g + 0.6299787005*b;
	let l_ = pow(max(l,0.0), 1.0/3.0); let m_ = pow(max(m,0.0), 1.0/3.0); let s_ = pow(max(s,0.0), 1.0/3.0);
	return vec3f(0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_, 1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_, 0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_);
}
fn fromOklab(lab: vec3f) -> vec3f {
	let l_ = lab.x + 0.3963377774*lab.y + 0.2158037573*lab.z;
	let m_ = lab.x - 0.1055613458*lab.y - 0.0638541728*lab.z;
	let s_ = lab.x - 0.0894841775*lab.y - 1.2914855480*lab.z;
	let l = l_*l_*l_; let m = m_*m_*m_; let s = s_*s_*s_;
	return vec3f(linearToSrgb(clamp(4.0767416621*l - 3.3077115913*m + 0.2309699292*s, 0.0, 1.0)), linearToSrgb(clamp(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s, 0.0, 1.0)), linearToSrgb(clamp(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s, 0.0, 1.0)));
}

fn cubicBez(p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, t: f32) -> vec2f {
	let mt = 1.0 - t; let mt2 = mt*mt; let t2 = t*t;
	return mt2*mt*p0 + 3.0*mt2*t*p1 + 3.0*mt*t2*p2 + t2*t*p3;
}

fn rayCrossBezierEdge(px: f32, py: f32, ec: EdgeCurve) -> u32 {
	var crossings: u32 = 0u;
	let STEPS: u32 = 32u;
	var prevP = ec.p0;
	for (var i = 1u; i <= STEPS; i++) {
		let t = f32(i) / f32(STEPS);
		let curP = cubicBez(ec.p0, ec.p1, ec.p2, ec.p3, t);
		if ((prevP.y <= py && curP.y > py) || (curP.y <= py && prevP.y > py)) {
			let frac = (py - prevP.y) / (curP.y - prevP.y);
			let ix = prevP.x + frac * (curP.x - prevP.x);
			if ix > px { crossings += 1u; }
		}
		prevP = curP;
	}
	return crossings;
}

fn pointInFaceRC(px: f32, py: f32, fi: u32, face: Face) -> bool {
	let n = select(3u, 4u, face.faceType == 0u);
	var crossings: u32 = 0u;
	for (var e = 0u; e < n; e++) {
		crossings += rayCrossBezierEdge(px, py, edgeCurves[fi * 4u + e]);
	}
	return (crossings & 1u) == 1u;
}

// Inverse bilinear: P = (1-u)(1-v)*p00 + u(1-v)*p10 + uv*p11 + (1-u)v*p01
fn bilinearUV(px: f32, py: f32, p00: vec2f, p10: vec2f, p11: vec2f, p01: vec2f) -> vec2f {
	let p = vec2f(px, py);
	let e = p10 - p00;
	let f = p01 - p00;
	let g = p00 - p10 + p11 - p01;
	let h = p - p00;

	let Aq = f.x * g.y - f.y * g.x;
	let Bq = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
	let Cq = h.x * e.y - h.y * e.x;

	var bestU = 0.5f; var bestV = 0.5f; var bestErr = 1e10f;

	if abs(Aq) < 1e-5 {
		if abs(Bq) > 1e-10 {
			let v0 = -Cq / Bq;
			let denom = e.x + v0 * g.x;
			var u0 = 0.5f;
			if abs(denom) > 1e-10 {
				u0 = (h.x - v0 * f.x) / denom;
			} else {
				let denomY = e.y + v0 * g.y;
				if abs(denomY) > 1e-10 { u0 = (h.y - v0 * f.y) / denomY; }
			}
			bestU = u0; bestV = v0;
		}
	} else {
		let disc = Bq * Bq - 4.0 * Aq * Cq;
		if disc >= 0.0 {
			let sq = sqrt(disc);
			let v1 = (-Bq + sq) / (2.0 * Aq);
			let v2 = (-Bq - sq) / (2.0 * Aq);
			for (var vi = 0u; vi < 2u; vi++) {
				let vv = select(v2, v1, vi == 0u);
				let denom = e.x + vv * g.x;
				var uu = 0.5f;
				if abs(denom) > 1e-10 {
					uu = (h.x - vv * f.x) / denom;
				} else {
					let denomY = e.y + vv * g.y;
					if abs(denomY) > 1e-10 { uu = (h.y - vv * f.y) / denomY; }
				}
				let uc = clamp(uu, 0.0, 1.0); let vc = clamp(vv, 0.0, 1.0);
				let recon = (1.0-uc)*(1.0-vc)*p00 + uc*(1.0-vc)*p10 + uc*vc*p11 + (1.0-uc)*vc*p01;
				let er = dot(recon - p, recon - p);
				if er < bestErr { bestErr = er; bestU = uc; bestV = vc; }
			}
		}
	}
	return vec2f(clamp(bestU, 0.0, 1.0), clamp(bestV, 0.0, 1.0));
}

fn evalFaceEdge2(faceIdx: u32, edgeIdx: u32, t: f32) -> vec2f {
	let ec = edgeCurves[faceIdx * 4u + edgeIdx];
	return cubicBez(ec.p0, ec.p1, ec.p2, ec.p3, t);
}

fn coonsColor(faceIdx: u32, face: Face, u: f32, v: f32) -> vec3f {
	let c00 = toOklab(verts[face.i0].color.xyz);
	let c10 = toOklab(verts[face.i1].color.xyz);
	let c11 = toOklab(verts[face.i2].color.xyz);
	let c01 = toOklab(verts[face.i3].color.xyz);
	let ec0 = c00 + (c10 - c00) * u;
	let ec1 = c01 + (c11 - c01) * u;
	let ed0 = c00 + (c01 - c00) * v;
	let ed1 = c10 + (c11 - c10) * v;
	let mu = 1.0 - u; let mv = 1.0 - v;
	return mv*ec0 + v*ec1 + mu*ed0 + u*ed1 - mu*mv*c00 - u*mv*c10 - u*v*c11 - mu*v*c01;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	if gid.x >= params.width || gid.y >= params.height { return; }
	let uv = vec2f((f32(gid.x) + 0.5) / f32(params.width), (f32(gid.y) + 0.5) / f32(params.height));
	let pixel = vec2u(gid.x, gid.y);

	var finalColor = vec4f(0.0, 0.0, 0.0, 0.0);
	var hasHit = false;

	for (var fi = 0u; fi < params.faceCount; fi++) {
		if hasHit { continue; }
		let face = faceData[fi];
		if uv.x < face.bboxMinX || uv.x > face.bboxMaxX || uv.y < face.bboxMinY || uv.y > face.bboxMaxY { continue; }

		if !pointInFaceRC(uv.x, uv.y, fi, face) { continue; }

		if face.faceType == 0u {
			let tgt = uv;
			let p00 = verts[face.i0].pos; let p10 = verts[face.i1].pos;
			let p11 = verts[face.i2].pos; let p01 = verts[face.i3].pos;

			var bestU = 0.5f; var bestV = 0.5f; var bestErr = 1e10f;

			let bseed = bilinearUV(uv.x, uv.y, p00, p10, p11, p01);

			let seeds = array<vec2f, 6>(
				bseed,
				vec2f(0.5, 0.5),
				vec2f(0.25, 0.25),
				vec2f(0.75, 0.25),
				vec2f(0.75, 0.75),
				vec2f(0.25, 0.75),
			);

			for (var si = 0u; si < 6u; si++) {
				var su = seeds[si].x; var sv = seeds[si].y;
				for (var iter = 0u; iter < 12u; iter++) {
					let c0 = evalFaceEdge2(fi, 0u, su); let c1 = evalFaceEdge2(fi, 2u, su);
					let d0 = evalFaceEdge2(fi, 3u, sv); let d1 = evalFaceEdge2(fi, 1u, sv);
					let mu = 1.0-su; let mv = 1.0-sv;
					let c = mv*c0 + sv*c1 + mu*d0 + su*d1 - mu*mv*p00 - su*mv*p10 - su*sv*p11 - mu*sv*p01;
					let e = c - tgt;
					if dot(e, e) < 1e-10 { break; }
					let eps: f32 = 0.001;
					let cu0 = evalFaceEdge2(fi, 0u, su+eps); let cu1 = evalFaceEdge2(fi, 2u, su+eps);
					let cu = mv*cu0 + sv*cu1 + mu*d0 + (su+eps)*d1 - mu*mv*p00 - (su+eps)*mv*p10 - (su+eps)*sv*p11 - mu*sv*p01;
					let cv0 = evalFaceEdge2(fi, 3u, sv+eps); let cv1 = evalFaceEdge2(fi, 1u, sv+eps);
					let cv = (1.0-sv-eps)*c0 + (sv+eps)*c1 + mu*cv0 + su*cv1 - mu*(1.0-sv-eps)*p00 - su*(1.0-sv-eps)*p10 - su*(sv+eps)*p11 - mu*(sv+eps)*p01;
					let dFu = (cu - c) / eps; let dFv = (cv - c) / eps;
					let det = dFu.x*dFv.y - dFu.y*dFv.x;
					if abs(det) < 1e-12 { break; }
					su += -(dFv.y*e.x - dFv.x*e.y) / det;
					sv += -(-dFu.y*e.x + dFu.x*e.y) / det;
				}
				let uc = clamp(su, 0.0, 1.0); let vc = clamp(sv, 0.0, 1.0);
				let fc0 = evalFaceEdge2(fi, 0u, uc); let fc1 = evalFaceEdge2(fi, 2u, uc);
				let fd0 = evalFaceEdge2(fi, 3u, vc); let fd1 = evalFaceEdge2(fi, 1u, vc);
				let mmu = 1.0-uc; let mmv = 1.0-vc;
				let fc = mmv*fc0 + vc*fc1 + mmu*fd0 + uc*fd1 - mmu*mmv*p00 - uc*mmv*p10 - uc*vc*p11 - mmu*vc*p01;
				let er = dot(fc - tgt, fc - tgt);
				if er < bestErr { bestErr = er; bestU = uc; bestV = vc; }
				if bestErr < 1e-10 { break; }
			}

			let lab = coonsColor(fi, face, bestU, bestV);
			let alpha = verts[face.i0].color.w * (1.0-bestU)*(1.0-bestV) + verts[face.i1].color.w * bestU*(1.0-bestV) + verts[face.i2].color.w * bestU*bestV + verts[face.i3].color.w * (1.0-bestU)*bestV;
			finalColor = vec4f(fromOklab(lab), alpha);
			hasHit = true;
		} else {
			let v0 = verts[face.i0].pos; let v1 = verts[face.i1].pos; let v2 = verts[face.i2].pos;
			let d0 = v1 - v0; let d1 = v2 - v0; let d2 = uv - v0;
			let dd00 = dot(d0,d0); let dd01 = dot(d0,d1); let dd11 = dot(d1,d1);
			let dd20 = dot(d2,d0); let dd21 = dot(d2,d1);
			let denom = dd00*dd11 - dd01*dd01;
			if abs(denom) > 1e-12 {
				let l1 = (dd11*dd20 - dd01*dd21) / denom;
				let l2 = (dd00*dd21 - dd01*dd20) / denom;
				let l0 = 1.0 - l1 - l2;
				let c0 = toOklab(verts[face.i0].color.xyz);
				let c1 = toOklab(verts[face.i1].color.xyz);
				let c2 = toOklab(verts[face.i2].color.xyz);
				let lab = max(l0,0.0)*c0 + max(l1,0.0)*c1 + max(l2,0.0)*c2;
				let alpha = max(l0,0.0)*verts[face.i0].color.w + max(l1,0.0)*verts[face.i1].color.w + max(l2,0.0)*verts[face.i2].color.w;
				finalColor = vec4f(fromOklab(lab), alpha);
				hasHit = true;
			}
		}
	}

	textureStore(output, pixel, finalColor);
}
`;

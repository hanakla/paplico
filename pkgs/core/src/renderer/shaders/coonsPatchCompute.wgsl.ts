/**
 * Compute shader for generating freeform gradient textures via
 * Delaunay triangulation + triangular Coons Patch interpolation.
 *
 * ## Pipeline overview
 * 1. CPU computes Delaunay triangulation from ColorStop positions.
 * 2. Each Delaunay edge is a cubic Bezier curve, controlled by the
 *    two endpoint stops' edgeCPs (one CP per side).
 * 3. Three Bezier edges forming a triangle define a triangular Coons Patch.
 * 4. For each pixel, the shader finds which triangle contains the pixel,
 *    computes barycentric coordinates, then evaluates the Coons Patch
 *    to interpolate color in OKLab perceptual color space.
 * 5. Pixels outside all triangles (outside the convex hull) take the
 *    nearest stop's color.
 *
 * ## GPU inputs
 * - binding 0: ComputeUniforms (width, height, stopCount, triangleCount)
 * - binding 1: GradientStop[] (color + position per stop)
 * - binding 2: TriangleIndex[] (3 stop indices per triangle, from Delaunay)
 * - binding 3: EdgeCP[] (control points for each directed edge)
 * - binding 4: output texture (rgba8unorm, write-only)
 */
export const COONS_PATCH_COMPUTE_SHADER = /* wgsl */ `
struct ComputeUniforms {
	width: u32,
	height: u32,
	stopCount: u32,
	triangleCount: u32,
}

// GradientStop: color(4) + pos(2) + pad(2) = 8 floats = 32 bytes
struct GradientStop {
	color: vec4f,
	pos: vec2f,
	_pad: vec2f,
}

// EdgeCP: cp(2) + pad(2) = 4 floats = 16 bytes
// Indexed by fromStopIndex * stopCount + toStopIndex
struct EdgeCP {
	cp: vec2f,
	_pad: vec2f,
}

@group(0) @binding(0) var<uniform> params: ComputeUniforms;
@group(0) @binding(1) var<storage, read> stops: array<GradientStop>;
@group(0) @binding(2) var<storage, read> triangles: array<u32>;
@group(0) @binding(3) var<storage, read> edgeCPs: array<EdgeCP>;
@group(0) @binding(4) var output: texture_storage_2d<rgba8unorm, write>;

// ---------------------------------------------------------------------------
// sRGB <-> OKLab color space conversion
// ---------------------------------------------------------------------------

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
	let r = srgbToLinear(c.x);
	let g = srgbToLinear(c.y);
	let b = srgbToLinear(c.z);
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

// ---------------------------------------------------------------------------
// Bezier evaluation
// ---------------------------------------------------------------------------

fn cubicBezier2D(p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, t: f32) -> vec2f {
	let mt = 1.0 - t;
	let mt2 = mt * mt;
	let t2 = t * t;
	return mt2 * mt * p0 + 3.0 * mt2 * t * p1 + 3.0 * mt * t2 * p2 + t2 * t * p3;
}

// ---------------------------------------------------------------------------
// Barycentric coordinates
// ---------------------------------------------------------------------------

fn barycentric(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> vec3f {
	let v0 = b - a;
	let v1 = c - a;
	let v2 = p - a;
	let d00 = dot(v0, v0);
	let d01 = dot(v0, v1);
	let d11 = dot(v1, v1);
	let d20 = dot(v2, v0);
	let d21 = dot(v2, v1);
	let denom = d00 * d11 - d01 * d01;
	if abs(denom) < 1e-10 {
		return vec3f(-1.0);
	}
	let v = (d11 * d20 - d01 * d21) / denom;
	let w = (d00 * d21 - d01 * d20) / denom;
	let u = 1.0 - v - w;
	return vec3f(u, v, w);
}

// ---------------------------------------------------------------------------
// Edge CP lookup
// ---------------------------------------------------------------------------

fn getEdgeCP(i: u32, j: u32) -> vec2f {
	let idx = i * params.stopCount + j;
	return edgeCPs[idx].cp;
}

// ---------------------------------------------------------------------------
// Main compute entry point
// ---------------------------------------------------------------------------

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	if gid.x >= params.width || gid.y >= params.height {
		return;
	}

	let uv = vec2f(
		f32(gid.x) / f32(max(params.width - 1u, 1u)),
		f32(gid.y) / f32(max(params.height - 1u, 1u)),
	);
	let pixel = vec2u(gid.x, gid.y);

	// --- 1 stop: solid fill ---
	if params.stopCount == 1u {
		textureStore(output, pixel, stops[0].color);
		return;
	}

	// --- 2+ stops: IDW with directional CP warping ---
	// Pure IDW base with continuous directional warping from CPs.
	// No curve sampling — all functions are continuous, so no banding.
	//
	// For each stop i, the CP toward neighbor j defines a direction
	// where stop i's influence extends further. The warping compares
	// the pixel's direction from stop i against the CP direction,
	// and reduces effective distance when they align.

	var totalWeight: f32 = 0.0;
	var blended = vec4f(0.0);

	for (var i = 0u; i < params.stopCount; i++) {
		let pi = stops[i].pos;
		let toPixel = uv - pi;
		let d = length(toPixel);

		// Snap to stop if extremely close
		if d < 0.001 {
			textureStore(output, pixel, stops[i].color);
			return;
		}

		let dirToPixel = toPixel / d;

		// Accumulate directional warping from all CPs of stop i.
		// Each CP toward neighbor j pulls stop i's influence in that direction.
		var warpFactor: f32 = 1.0;

		for (var j = 0u; j < params.stopCount; j++) {
			if i == j { continue; }

			let cpIJ = getEdgeCP(i, j);
			let pj = stops[j].pos;

			// CP direction from stop i (the tangent direction at t=0)
			// For cubic Bezier P0→CP0→CP1→P3, tangent at t=0 = 3*(CP0 - P0)
			let cpDir = cpIJ - pi;
			let cpLen = length(cpDir);
			if cpLen < 0.0001 { continue; }

			let cpDirNorm = cpDir / cpLen;

			// How well does the pixel direction align with the CP direction?
			// dot product: 1 = same direction, -1 = opposite, 0 = perpendicular
			let alignment = dot(dirToPixel, cpDirNorm);

			// Only warp in the CP's forward hemisphere
			if alignment > 0.0 {
				// Strength: how far the CP extends (relative to edge length)
				let edgeLen = distance(pi, pj);
				let cpReach = cpLen / max(edgeLen, 0.0001);

				// Warping: reduce effective distance in the CP direction.
				// alignment^2 for smooth angular falloff.
				// cpReach controls how strongly the CP warps.
				// Factor < 1 means "closer" in that direction.
				let warp = 1.0 - alignment * alignment * clamp(cpReach, 0.0, 0.8);
				warpFactor = min(warpFactor, warp);
			}
		}

		let effDist = max(d * warpFactor, 0.0001);
		let w_idw = 1.0 / (effDist * effDist * effDist);
		let lab = srgbToOklab(stops[i].color.xyz);
		blended += vec4f(lab * w_idw, stops[i].color.w * w_idw);
		totalWeight += w_idw;
	}

	let avg = blended / totalWeight;
	let rgbFinal = oklabToSrgb(avg.xyz);
	textureStore(output, pixel, vec4f(rgbFinal, avg.w));
}
`;

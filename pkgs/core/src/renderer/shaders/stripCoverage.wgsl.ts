/**
 * Coverage kernels for sparse strips. `StripRasterizer` lays out the tile
 * locations of each outline on the CPU; these kernels integrate their alphas
 * into the resident alpha page and, for along/across stroke gradients, the
 * per-pixel (t, u) into the params page.
 *
 * Entry points, dispatched in this order over one frame's batches:
 *   backdrop — one invocation per band: walks its locations left to right
 *              and records the per-row winding each location starts from
 *   coverage — one invocation per location: nonzero area coverage of its
 *              16 pixels (the font-rs / Vello "area + cover" integration)
 *   params   — one invocation per location: stroke gradient params
 *
 * Locations and bands keep their batch-local indices. Each invocation finds
 * its batch in a table sorted by first location and first band, and adds
 * that batch's bases.
 */

import {
	COVERAGE_BATCH_FIELDS,
	COVERAGE_DISPATCH_FIELDS,
	u32StructWgsl,
} from "../canvas/pipeline/strips/stripCoverageLayout";
import { LOCATION_FIELDS, TILE_SIZE } from "../geometry/strips/stripTypes";
import { STRIP_PAGE_COMMON_WGSL } from "./stripPageCommon.wgsl";

/** Farthest a pixel centre can sit outside a triangle that still covers part of the pixel. */
const PIXEL_REACH = Math.SQRT1_2;

export const STRIP_COVERAGE_WORKGROUP_SIZE = 64;

export const STRIP_COVERAGE_SHADER = /* wgsl */ `
${u32StructWgsl("Location", LOCATION_FIELDS)}

struct Band {
	first: u32,
	count: u32,
}

${u32StructWgsl("Batch", COVERAGE_BATCH_FIELDS)}

${u32StructWgsl("Dispatch", COVERAGE_DISPATCH_FIELDS)}

@group(0) @binding(0) var<uniform> dispatchInfo: Dispatch;
@group(0) @binding(1) var<storage, read> lines: array<vec4f>;
@group(0) @binding(2) var<storage, read> entries: array<u32>;
@group(0) @binding(3) var<storage, read> locations: array<Location>;
@group(0) @binding(4) var<storage, read> bands: array<Band>;
@group(0) @binding(5) var<storage, read_write> backdrops: array<vec4f>;
@group(0) @binding(6) var<storage, read> triangles: array<vec4f>;
@group(0) @binding(7) var<storage, read> triEntries: array<u32>;
@group(0) @binding(8) var alphaPage: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(9) var paramsPage: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(10) var<storage, read> batches: array<Batch>;

const TILE: f32 = ${TILE_SIZE}.0;
const TILE_U: u32 = ${TILE_SIZE}u;
const PIXEL_REACH: f32 = ${PIXEL_REACH};

fn invocationIndex(gid: vec3u) -> u32 {
	return gid.y * dispatchInfo.rowStride + gid.x;
}

/** The batch holding a location, or a band when byBand. */
fn batchOf(index: u32, byBand: bool) -> Batch {
	var lo = 0u;
	var hi = dispatchInfo.batchCount;
	while (hi - lo > 1u) {
		let mid = (lo + hi) / 2u;
		let first = select(batches[mid].firstLocation, batches[mid].firstBand, byBand);
		if (first <= index) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return batches[lo];
}

/** Batch-local ends of a location's entries (x) and triangle entries (y). */
fn locationEnds(index: u32, batch: Batch) -> vec2u {
	if (index + 1u == batch.locationEnd) {
		return vec2u(batch.entryEnd, batch.triEntryEnd);
	}
	let next = locations[index + 1u];
	return vec2u(next.entryStart, next.triStart);
}

fn locationSlot(index: u32, batch: Batch) -> u32 {
	return batch.firstSlot + (index - batch.firstLocation) * TILE_U;
}

fn tileOrigin(tile: u32) -> vec2f {
	return vec2f(f32(tile & 0xffffu), f32(tile >> 16u)) * TILE;
}

${STRIP_PAGE_COMMON_WGSL}

/** A line's endpoints ordered top to bottom, with its winding sign (upward positive). */
struct Edge {
	top: vec2f,
	bottom: vec2f,
	sign: f32,
	vertical: bool,
	ySlope: f32,
}

fn makeEdge(p0: vec2f, p1: vec2f) -> Edge {
	var e: Edge;
	e.sign = select(-1.0, 1.0, p0.y > p1.y);
	e.top = select(p1, p0, p0.y < p1.y);
	e.bottom = select(p0, p1, p0.y < p1.y);
	e.vertical = e.bottom.x == e.top.x;
	e.ySlope = (e.bottom.y - e.top.y) / select(e.bottom.x - e.top.x, 1.0, e.vertical);
	return e;
}

/**
 * The line's y where it crosses x, clamped to [yMin, yMax]. A vertical line
 * at that x belongs to the pixel on its right, so it resolves to yMin.
 */
fn crossingY(e: Edge, x: f32, yMin: f32, yMax: f32) -> f32 {
	if (e.vertical) {
		return select(yMin, yMax, x > e.top.x);
	}
	return clamp((x - e.top.x) * e.ySlope + e.top.y, yMin, yMax);
}

/** Per-row winding a line (tile-local) carries past the tile's right edge. */
fn rowCarries(p0: vec2f, p1: vec2f) -> vec4f {
	var carry = vec4f(0.0);
	if (p0.y == p1.y) {
		return carry;
	}
	let e = makeEdge(p0, p1);
	for (var r = 0u; r < 4u; r++) {
		let yMin = max(e.top.y, f32(r));
		let yMax = min(e.bottom.y, f32(r) + 1.0);
		if (yMin >= yMax) {
			continue;
		}
		carry[r] = abs(crossingY(e, TILE, yMin, yMax) - crossingY(e, 0.0, yMin, yMax)) * e.sign;
	}
	return carry;
}

@compute @workgroup_size(${STRIP_COVERAGE_WORKGROUP_SIZE})
fn backdrop(@builtin(global_invocation_id) gid: vec3u) {
	let i = invocationIndex(gid);
	if (i >= dispatchInfo.count) {
		return;
	}
	let bandIndex = dispatchInfo.first + i;
	let batch = batchOf(bandIndex, true);
	let band = bands[bandIndex];
	var accum = vec4f(0.0);
	var previousTx = 0u;
	for (var k = 0u; k < band.count; k++) {
		let index = batch.firstLocation + band.first + k;
		let loc = locations[index];
		let entryEnd = locationEnds(index, batch).x;
		let tx = loc.tile & 0xffffu;
		// A gap carries the band's first-row winding, rounded, into every row.
		if (k > 0u && (tx != previousTx + 1u || entryEnd == loc.entryStart)) {
			accum = vec4f(floor(accum.x + 0.5));
		}
		previousTx = tx;
		backdrops[index] = accum;
		let origin = tileOrigin(loc.tile);
		for (var j = loc.entryStart; j < entryEnd; j++) {
			let l = lines[batch.lineBase + entries[batch.entryBase + j]];
			accum += rowCarries(l.xy - origin, l.zw - origin);
		}
	}
}

@compute @workgroup_size(${STRIP_COVERAGE_WORKGROUP_SIZE})
fn coverage(@builtin(global_invocation_id) gid: vec3u) {
	let i = invocationIndex(gid);
	if (i >= dispatchInfo.count) {
		return;
	}
	let index = dispatchInfo.first + i;
	let batch = batchOf(index, false);
	let loc = locations[index];
	let entryEnd = locationEnds(index, batch).x;
	let start = backdrops[index];
	var cov: array<f32, 16>;
	for (var r = 0u; r < 4u; r++) {
		for (var c = 0u; c < 4u; c++) {
			cov[r * 4u + c] = start[r];
		}
	}
	let origin = tileOrigin(loc.tile);
	for (var j = loc.entryStart; j < entryEnd; j++) {
		let l = lines[batch.lineBase + entries[batch.entryBase + j]];
		let p0 = l.xy - origin;
		let p1 = l.zw - origin;
		if (p0.y == p1.y) {
			continue;
		}
		let e = makeEdge(p0, p1);
		let xSlope = select(1.0 / e.ySlope, 0.0, e.vertical);
		let baseYX = e.top.x - e.top.y * xSlope;
		// A line's vertical extent inside a pixel adds a trapezoid to that
		// pixel and carries its full height to every pixel on its right.
		for (var r = 0u; r < 4u; r++) {
			let yMin = max(e.top.y, f32(r));
			let yMax = min(e.bottom.y, f32(r) + 1.0);
			if (yMin >= yMax) {
				continue;
			}
			var carried = 0.0;
			for (var c = 0u; c < 4u; c++) {
				let fc = f32(c);
				let yL = crossingY(e, fc, yMin, yMax);
				let yR = crossingY(e, fc + 1.0, yMin, yMax);
				let xL = yL * xSlope + baseYX;
				let xR = yR * xSlope + baseYX;
				let h = abs(yR - yL);
				let area = h * (fc + 1.0 - 0.5 * (xR + xL));
				cov[r * 4u + c] += area * e.sign + carried;
				carried += h * e.sign;
			}
		}
	}
	let slot = locationSlot(index, batch);
	for (var c = 0u; c < 4u; c++) {
		let column = vec4f(cov[c], cov[4u + c], cov[8u + c], cov[12u + c]);
		textureStore(alphaPage, slotTexel(slot + c), min(abs(column), vec4f(1.0)));
	}
}

/** Position of the projection of p onto the edge a→b, clamped to 0..1. */
fn edgeParameter(p: vec2f, a: vec2f, b: vec2f) -> f32 {
	let d = b - a;
	return clamp(dot(p - a, d) / dot(d, d), 0.0, 1.0);
}

@compute @workgroup_size(${STRIP_COVERAGE_WORKGROUP_SIZE})
fn params(@builtin(global_invocation_id) gid: vec3u) {
	let i = invocationIndex(gid);
	if (i >= dispatchInfo.count) {
		return;
	}
	let index = dispatchInfo.first + i;
	let batch = batchOf(index, false);
	if (batch.hasParams == 0u) {
		return;
	}
	let loc = locations[index];
	let triEnd = locationEnds(index, batch).y;
	let origin = tileOrigin(loc.tile);
	var tu: array<vec2f, 16>;
	var interior: array<bool, 16>;
	for (var k = loc.triStart; k < triEnd; k++) {
		let base = (batch.triBase + triEntries[batch.triEntryBase + k]) * 3u;
		let a = triangles[base];
		let b = triangles[base + 1u];
		let c = triangles[base + 2u];
		let p0 = a.xy;
		let p1 = a.zw;
		let p2 = b.xy;
		let q0 = b.zw;
		let q1 = c.xy;
		let q2 = c.zw;
		let det = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
		let invDet = 1.0 / det;
		// A barycentric weight times its vertex's height over the opposite
		// edge is the signed distance from that edge.
		let absDet = abs(det);
		let h0 = absDet / length(p2 - p1);
		let h1 = absDet / length(p2 - p0);
		let h2 = absDet / length(p1 - p0);
		let lo = floor(min(min(p0, p1), p2) - 1.0);
		let hi = ceil(max(max(p0, p1), p2) + 1.0);
		for (var j = 0u; j < 16u; j++) {
			let pixel = origin + vec2f(f32(j & 3u), f32(j >> 2u));
			if (any(pixel < lo) || any(pixel >= hi)) {
				continue;
			}
			let center = pixel + 0.5;
			let w1 = ((center.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (center.y - p0.y)) * invDet;
			let w2 = ((p1.x - p0.x) * (center.y - p0.y) - (center.x - p0.x) * (p1.y - p0.y)) * invDet;
			let w0 = 1.0 - w1 - w2;
			let inside = w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4;
			if (!inside && (w0 * h0 < -PIXEL_REACH || w1 * h1 < -PIXEL_REACH || w2 * h2 < -PIXEL_REACH)) {
				continue;
			}
			if (inside) {
				interior[j] = true;
				tu[j] = w0 * q0 + w1 * q1 + w2 * q2;
				continue;
			}
			if (interior[j]) {
				continue;
			}
			// Outside across one edge: the nearest point is on that edge.
			// Outside across two edges: it is the vertex between them.
			if (w0 < 0.0 && w1 < 0.0) {
				tu[j] = q2;
			} else if (w1 < 0.0 && w2 < 0.0) {
				tu[j] = q0;
			} else if (w2 < 0.0 && w0 < 0.0) {
				tu[j] = q1;
			} else if (w0 < 0.0) {
				tu[j] = mix(q1, q2, edgeParameter(center, p1, p2));
			} else if (w1 < 0.0) {
				tu[j] = mix(q2, q0, edgeParameter(center, p2, p0));
			} else {
				tu[j] = mix(q0, q1, edgeParameter(center, p0, p1));
			}
		}
	}
	let slot = locationSlot(index, batch);
	for (var col = 0u; col < 4u; col++) {
		textureStore(paramsPage, paramsTexel(slot + col, 0u), clamp(vec4f(tu[col], tu[4u + col]), vec4f(0.0), vec4f(1.0)));
		textureStore(paramsPage, paramsTexel(slot + col, 2u), clamp(vec4f(tu[8u + col], tu[12u + col]), vec4f(0.0), vec4f(1.0)));
	}
}
`;

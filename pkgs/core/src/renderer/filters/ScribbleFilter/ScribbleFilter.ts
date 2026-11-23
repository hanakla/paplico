/**
 * Scribble Pre-Filter Processor
 * Replaces a shape with a zig-zag hatching across its area, outlined to a
 * stroke width so a fill paints the hatching. On a stroke, the area is the
 * band the stroke covers, and the stroke's color fills the hatching.
 *
 * Algorithm:
 * 1. Turn the shape so the hatching runs horizontally
 * 2. Cut it with horizontal rows `spacing` apart and keep the spans inside it
 * 3. Join each row's spans to the previous row's, alternating direction, as
 *    long as the joining line stays inside the shape
 * 4. Jitter each span's ends and bend each turn by seeded noise
 * 5. Outline the zig-zags to `strokeWidth` with round joins and caps
 *
 * Ported from VectorCraft's Scribble effect
 * (https://github.com/storytold/vectorcraft, crates/effects/src/stylize.rs and
 * crates/effects/src/util.rs), used under the MIT License:
 *
 * MIT License
 *
 * Copyright (c) 2026 ArtCraft Team and the VectorCraft contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { AppearanceGeometry } from "../../../document/elementGeometry/filterCapabilities";
import {
	type GeometricStrokeShape,
	isOutlinableStroke,
	outlineGeometricStroke,
	resolveGeometricStrokeShape,
	strokeToFill,
} from "../../../document/elementGeometry/geometricStroke";
import {
	createIdentityTransform,
	createStrokeBrushSettings,
} from "../../../document/factory";
import type {
	Appearance,
	CubicBezierSegment,
	Filter,
	Point,
} from "../../../schema";
import { flattenBezierPath } from "../../../utils/geometry/generate/bezierFlatten";
import { DEVICE_CURVE_TOLERANCE_PX } from "../../../utils/geometry/measure/curveTolerance";
import { calculateSegmentListBounds } from "../../../utils/geometry/measure/pathBounds";
import { hashSegments } from "../../../utils/geometry/measure/segmentHash";
import { splitIntoSubPaths } from "../../../utils/geometry/primitives/segment";
import type { FilterHandler } from "../../canvas/pipeline/FilterRenderer";

export interface ScribbleParams {
	/** Direction of the hatching, in degrees counterclockwise from horizontal */
	angle: number;
	/** How far each line runs past the shape's edge; negative stops short */
	overlap: number;
	/** How far each line's ends move along it at random */
	overlapVariation: number;
	/** Width of the hatching lines */
	strokeWidth: number;
	/** Roundness of each turn, 0~100 (percent) */
	curviness: number;
	/** How far each turn's roundness moves from `curviness` at random, 0~100 */
	curvinessVariation: number;
	/** Distance between the lines */
	spacing: number;
	/** How far each line's ends move across it at random */
	spacingVariation: number;
	/** Seed of the random variation; the same seed yields the same hatching */
	seed?: number;
}

export interface ScribbleFilter extends Appearance<ScribbleParams> {
	processor: "scribble";
}

/** Outline memo capacity: one entry per scribbled shape drawn recently. */
const RESULT_CACHE_LIMIT = 64;

/** Error the hatching's outline is fitted within, as a fraction of its line width. */
const OUTLINE_PRECISION = 1 / 40;

/** Most rows one shape is cut into, so a tiny spacing can't explode. */
const MAX_ROWS = 2000;

export class ScribbleFilterHandler implements FilterHandler {
	/**
	 * Outlining fits curves to a triangle soup and costs tens of ms, while the
	 * pipeline hands the hook a fresh copy of the segments every frame. The
	 * memo is keyed by the segments' content, the stroke band and the
	 * parameters.
	 */
	private readonly scribbled = new Map<string, CubicBezierSegment[]>();

	public async initialize(
		_device: GPUDevice,
		_canvasFormat: GPUTextureFormat,
	): Promise<void> {
		/* no-op: Pre-filter does not use GPU pipelines */
	}

	public preProcessAppearance(
		geometry: AppearanceGeometry,
		filter: Filter,
	): AppearanceGeometry[] {
		const params = (filter as ScribbleFilter).paramData.params;
		const stroke =
			geometry.appearance && isOutlinableStroke(geometry.appearance)
				? geometry.appearance
				: null;
		const shape =
			stroke &&
			resolveGeometricStrokeShape(
				geometry.path,
				stroke.paramData.params.brushSettings ?? createStrokeBrushSettings(1),
			);
		const segments = geometry.path.segments;
		const key = `${hashSegments(segments)}:${segments.length}:${JSON.stringify(shape)}:${JSON.stringify(params)}`;
		const hatching =
			this.scribbled.get(key) ?? scribbleArea(segments, shape, params);
		// Re-inserted so the map's order runs from least to most recently used
		this.scribbled.delete(key);
		this.scribbled.set(key, hatching);
		if (this.scribbled.size > RESULT_CACHE_LIMIT) {
			const oldest = this.scribbled.keys().next().value;
			if (oldest !== undefined) this.scribbled.delete(oldest);
		}
		if (!stroke) {
			return [{ ...geometry, path: { ...geometry.path, segments: hatching } }];
		}
		// The hatching is a fill of its own outline, so the profile that shaped
		// the band does not carry over.
		return [
			{
				...geometry,
				appearance: strokeToFill(stroke),
				path: { segments: hatching },
			},
		];
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as ScribbleFilter;
		const scale = Math.sqrt(Math.abs(scaleX * scaleY));
		const p = f.paramData.params;
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...p,
					overlap: p.overlap * scale,
					overlapVariation: p.overlapVariation * scale,
					strokeWidth: p.strokeWidth * scale,
					spacing: p.spacing * scale,
					spacingVariation: p.spacingVariation * scale,
				},
			},
		};
	}

	public getExpansionMargin(filter: Filter): number {
		const p = (filter as ScribbleFilter).paramData.params;
		return (
			Math.max(0, p.overlap) +
			p.overlapVariation +
			p.spacingVariation +
			p.strokeWidth / 2
		);
	}

	/** Changes the geometry before rasterization, never reading a backdrop. */
	public getBackdropFootprint(): number {
		return 0;
	}

	public getDetailDensity(): number {
		return Number.POSITIVE_INFINITY;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as ScribbleParams;
		const b = paramsB as ScribbleParams;
		const lerp = (key: keyof Omit<ScribbleParams, "seed">) =>
			a[key] + (b[key] - a[key]) * t;
		return {
			angle: lerp("angle"),
			overlap: lerp("overlap"),
			overlapVariation: lerp("overlapVariation"),
			strokeWidth: lerp("strokeWidth"),
			curviness: lerp("curviness"),
			curvinessVariation: lerp("curvinessVariation"),
			spacing: lerp("spacing"),
			spacingVariation: lerp("spacingVariation"),
			// A blended seed would reshuffle every intermediate hatching
			seed: a.seed,
		} satisfies ScribbleParams;
	}
}

/** The hatching of the shape's area, or of the band `stroke` draws along it. */
function scribbleArea(
	segments: CubicBezierSegment[],
	stroke: GeometricStrokeShape | null,
	params: ScribbleParams,
): CubicBezierSegment[] {
	if (!stroke) return scribble(segments, params);
	return scribble(
		outlineGeometricStroke([segments], stroke, createIdentityTransform()),
		params,
	);
}

/** A zig-zag across the shape's area, outlined to `strokeWidth`. */
function scribble(
	segments: CubicBezierSegment[],
	params: ScribbleParams,
): CubicBezierSegment[] {
	const bounds = calculateSegmentListBounds(segments);
	if (!bounds) return [];
	const angle = (params.angle * Math.PI) / 180;
	const overlap = params.overlap;
	const width = clamp(params.strokeWidth, 0.01, 1000);
	const curviness = clamp(params.curviness, 0, 100);
	const curvinessVariation = clamp(params.curvinessVariation, 0, 100);
	const spacing = Math.max(params.spacing, 0.1);
	const along = clamp(params.overlapVariation, 0, 100);
	const across = clamp(params.spacingVariation, 0, 100);
	const seed = Math.floor(Math.abs(params.seed ?? 0));

	const center = {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
	};
	const toLocal = rotateAbout(center, -angle);
	const fromLocal = rotateAbout(center, angle);
	const polys = flattenSubPaths(segments).map((poly) => poly.map(toLocal));
	let y0 = Number.POSITIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const q of polys.flat()) {
		y0 = Math.min(y0, q.y);
		y1 = Math.max(y1, q.y);
	}
	if (!Number.isFinite(y0) || y1 - y0 < 1e-9) return [];
	const step = Math.max(spacing, (y1 - y0) / MAX_ROWS);

	// One zig-zag per region: a span continues a chain of the previous row as
	// long as the line from that row's end to this one's start stays inside
	// the shape; otherwise it starts a chain of its own. So no line crosses a
	// hole or a notch.
	const chains: Chain[] = [];
	// Rows are counted, not summed: adding a step below the spacing of the
	// numbers at `y` would never move it.
	for (let row = 0; row <= MAX_ROWS + 1; row++) {
		const y = y0 + step / 2 + row * step;
		if (!(y < y1)) break;
		const xs: number[] = [];
		for (const poly of polys) {
			for (let i = 1; i < poly.length; i++) {
				const a = poly[i - 1];
				const b = poly[i];
				if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
					xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
				}
			}
		}
		xs.sort((a, b) => a - b);
		const open = chains.length;
		for (let i = 0; i + 1 < xs.length; i += 2) {
			const a = xs[i] - overlap;
			const bx = xs[i + 1] + overlap;
			const jitter = (k: number, v: number) => v * noise(seed, row, k, 3);
			const l = { x: a + jitter(0, along), y: y + jitter(1, across) };
			const r = { x: bx + jitter(2, along), y: y + jitter(3, across) };
			const even = row % 2 === 0;
			const pair = even ? [l, r] : [r, l];
			const bend = [noise(seed, row, 4, 3), noise(seed, row, 5, 3)];
			if (!even) bend.reverse();
			// Un-jittered ends of the span in drawing order
			const start = even ? { x: a, y } : { x: bx, y };
			const end = even ? { x: bx, y } : { x: a, y };
			// The nearest chain of the previous row that this span can join
			// without leaving the shape
			let pick: Chain | undefined;
			for (const chain of chains.slice(0, open)) {
				if (chain.row !== row - 1) continue;
				if (crossesOutline(chain.end, start, polys)) continue;
				if (!pick || distance(chain.end, start) < distance(pick.end, start)) {
					pick = chain;
				}
			}
			if (pick) {
				pick.points.push(...pair);
				pick.bends.push(...bend);
				pick.end = end;
				pick.row = row;
			} else {
				chains.push({ points: pair, bends: bend, end, row });
			}
		}
	}

	const lines = chains
		.filter((chain) => chain.points.length >= 2)
		.map((chain) => {
			const anchors =
				curvinessVariation > 0
					? variedCurves(
							chain.points,
							chain.bends,
							curviness,
							curvinessVariation,
						)
					: curviness > 0
						? catmullRom(chain.points, (curviness / 100) * 2)
						: chain.points.map((p) => ({ p, in: p, out: p }));
			return anchorsToSegments(anchors.map((a) => mapAnchor(a, fromLocal)));
		});
	if (lines.length === 0) return [];
	return outlineGeometricStroke(
		[lines.flat()],
		{
			width,
			sizeByPressure: 0,
			lineCap: "round",
			lineJoin: "round",
			miterLimit: 4,
		},
		// The outline's error budget is set for the scale it is drawn at, which
		// the lines know nothing of. Fitting it as if drawn this much larger
		// keeps each round turn round at any width.
		{
			...createIdentityTransform(),
			scaleX: DEVICE_CURVE_TOLERANCE_PX / (width * OUTLINE_PRECISION),
			scaleY: DEVICE_CURVE_TOLERANCE_PX / (width * OUTLINE_PRECISION),
		},
	);
}

/** A zig-zag being built across rows. */
interface Chain {
	points: Point[];
	/** Each point's curviness noise in [-1, 1] */
	bends: number[];
	end: Point;
	row: number;
}

/** A curve anchor with absolute handles. */
interface Anchor {
	p: Point;
	in: Point;
	out: Point;
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

function distance(a: Point, b: Point): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

function rotateAbout(c: Point, angle: number): (p: Point) => Point {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return (p) => ({
		x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
		y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
	});
}

function mapAnchor(a: Anchor, f: (p: Point) => Point): Anchor {
	return { p: f(a.p), in: f(a.in), out: f(a.out) };
}

/** Each subpath as a polyline, closed ones ending where they start. */
function flattenSubPaths(segments: CubicBezierSegment[]): Point[][] {
	return splitIntoSubPaths(segments).map((sub) => {
		const flat = flattenBezierPath(sub);
		const points: Point[] = [];
		for (let i = 0; i + 1 < flat.length; i += 2) {
			points.push({ x: flat[i], y: flat[i + 1] });
		}
		if (sub.at(-1)?.isClosed && points.length > 0) points.push(points[0]);
		return points;
	});
}

/**
 * Whether segment `p`–`q` properly crosses an edge of `polys`: its own ends,
 * which lie on the outline, don't count, nor does running along an edge.
 */
function crossesOutline(p0: Point, q0: Point, polys: Point[][]): boolean {
	const lerp = (a: Point, b: Point, t: number) => ({
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
	});
	const p = lerp(p0, q0, 1e-3);
	const q = lerp(q0, p0, 1e-3);
	const side = (a: Point, b: Point, c: Point) =>
		(b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	// Strictly on opposite sides, beyond rounding noise (the sides are areas)
	const apart = (s1: number, s2: number, eps: number) =>
		(s1 > eps && s2 < -eps) || (s1 < -eps && s2 > eps);
	const pq = distance(p, q);
	return polys.some((poly) =>
		poly.slice(1).some((b, i) => {
			const a = poly[i];
			const eps = 1e-9 * pq * distance(a, b);
			return (
				apart(side(p, q, a), side(p, q, b), eps) &&
				apart(side(a, b, p), side(a, b, q), eps)
			);
		}),
	);
}

/** A Catmull-Rom curve through `points`, open at both ends. */
function catmullRom(points: Point[], tension: number): Anchor[] {
	const n = points.length;
	if (n < 3) return points.map((p) => ({ p, in: p, out: p }));
	return points.map((p, i) => {
		const prev = points[Math.max(0, i - 1)];
		const next = points[Math.min(n - 1, i + 1)];
		const t = turnTangent(prev, p, next);
		const k = tension / 6;
		return {
			p,
			in: { x: p.x - t.x * k, y: p.y - t.y * k },
			out: { x: p.x + t.x * k, y: p.y + t.y * k },
		};
	});
}

/**
 * The tangent at `p` from its neighbours, kept at least half as long as the
 * longer side so a sharp turn back still gets handles.
 */
function turnTangent(prev: Point, p: Point, next: Point): Point {
	const t = { x: next.x - prev.x, y: next.y - prev.y };
	const a = { x: p.x - prev.x, y: p.y - prev.y };
	const b = { x: next.x - p.x, y: next.y - p.y };
	const floor = 0.5 * Math.max(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y));
	if (Math.hypot(t.x, t.y) >= floor) return t;
	const unit = (v: Point) => {
		const l = Math.hypot(v.x, v.y);
		return l > 1e-12 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
	};
	const u = unit(a);
	const v = unit(b);
	let d = unit({ x: u.x + v.x, y: u.y + v.y });
	if (d.x === 0 && d.y === 0) d = { x: -u.y, y: u.x };
	if (d.x === 0 && d.y === 0) return t;
	return { x: d.x * floor, y: d.y * floor };
}

/**
 * A scribble line through `points` whose curviness at each point is
 * `curviness` percent plus `variation` percent times that point's `bends`
 * noise, kept within 0 to 100 percent.
 */
function variedCurves(
	points: Point[],
	bends: number[],
	curviness: number,
	variation: number,
): Anchor[] {
	// A tension of 6 makes each handle the whole Catmull-Rom tangent; each
	// point then scales its own to the tension that curviness gives.
	return catmullRom(points, 6).map((a, i) => {
		const k = clamp(curviness + variation * (bends[i] ?? 0), 0, 100) / 300;
		return {
			p: a.p,
			in: { x: a.p.x + (a.in.x - a.p.x) * k, y: a.p.y + (a.in.y - a.p.y) * k },
			out: {
				x: a.p.x + (a.out.x - a.p.x) * k,
				y: a.p.y + (a.out.y - a.p.y) * k,
			},
		};
	});
}

function anchorsToSegments(anchors: Anchor[]): CubicBezierSegment[] {
	return anchors.slice(1).map((to, i) => {
		const from = anchors[i];
		return {
			...(i === 0 ? { start: { ...from.p } } : {}),
			cp1: { x: from.out.x - from.p.x, y: from.out.y - from.p.y },
			cp2: { x: to.in.x - to.p.x, y: to.in.y - to.p.y },
			end: { ...to.p },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
		};
	});
}

const MASK_64 = (1n << 64n) - 1n;

/** Seeded noise in [-1, 1] from four integers (splitmix64). */
function noise(seed: number, a: number, b: number, c: number): number {
	const mul = (x: bigint, k: bigint) => (x * k) & MASK_64;
	let x =
		mul(BigInt(seed), 0x9e3779b97f4a7c15n) ^
		mul(BigInt(a), 0xbf58476d1ce4e5b9n) ^
		mul(BigInt(b), 0x94d049bb133111ebn) ^
		BigInt(c);
	x = (x + 0x9e3779b97f4a7c15n) & MASK_64;
	x = mul(x ^ (x >> 30n), 0xbf58476d1ce4e5b9n);
	x = mul(x ^ (x >> 27n), 0x94d049bb133111ebn);
	x ^= x >> 31n;
	return (Number(x >> 11n) / 2 ** 53) * 2 - 1;
}

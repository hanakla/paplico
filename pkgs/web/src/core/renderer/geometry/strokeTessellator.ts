import type { LineCap, LineJoin, StrokeWidthPoint } from "../../schema";
import { resolveTaper, taperFactor } from "./taper";

export interface StrokeTessellateInput {
	points: number[];
	pressures: number[];
	baseWidth: number;
	sizeByPressure: number;
	lineCap: LineCap;
	lineJoin: LineJoin;
	miterLimit: number;
	isClosed: boolean;
	strokeWidths?: StrokeWidthPoint[];
	/** Entry taper length in world units (0/undefined = off). Ignored for closed paths. */
	taperStart?: number;
	/** Exit taper length in world units (0/undefined = off). Ignored for closed paths. */
	taperEnd?: number;
	/** Fragment range covered by `points` within the whole stroke (defaults 0..1). */
	pathStart?: number;
	/** @see pathStart */
	pathEnd?: number;
	/**
	 * Request per-vertex gradient params (t, u). Maps this polyline's local arc
	 * length into the whole stroke's range: dash sub-polylines pass their start
	 * offset and the undashed polyline's total; undashed strokes pass 0 and
	 * their own total.
	 */
	arcParams?: { arcOffset: number; totalArcLength: number };
	/**
	 * Viewport zoom that sizes round join/cap arc subdivision to a
	 * device-space error budget. Defaults to 1 (world units = screen px).
	 */
	zoom?: number;
}

interface StrokeTessellateResult {
	/**
	 * Body triangles as [x, y, ...] (2 floats per vertex, 3 vertices per
	 * triangle). Triangles overlap at joins and self-crossings; the stroke is
	 * their nonzero union.
	 */
	vertices: number[];
	count: number;
	/**
	 * Per-vertex gradient params [t, u, ...] (2 floats per vertex), aligned
	 * with `vertices`. t = whole-stroke arc ratio (remapped by
	 * pathStart/pathEnd), u = cross-stroke position 0..1. Join/cap vertices
	 * carry their sample's t. Empty unless `arcParams` was requested.
	 */
	vertexParams: number[];
}

export function tessellateStroke(
	input: StrokeTessellateInput,
): StrokeTessellateResult {
	const {
		points,
		pressures,
		baseWidth,
		sizeByPressure,
		lineCap,
		lineJoin,
		miterLimit,
		isClosed,
		strokeWidths,
		taperStart,
		taperEnd,
		pathStart = 0,
		pathEnd = 1,
		arcParams,
		zoom = 1,
	} = input;

	const pointCount = points.length / 2;

	if (pointCount < 2) {
		return { vertices: [], count: 0, vertexParams: [] };
	}

	// Compute base half-widths from pressure
	const halfWidths = new Float64Array(pointCount);
	for (let i = 0; i < pointCount; i++) {
		const pressure = pressures[i] ?? 1;
		halfWidths[i] = baseWidth * 0.5 * (1 - sizeByPressure * (1 - pressure));
	}

	const hasStrokeWidths = strokeWidths != null && strokeWidths.length > 0;
	// Taper never applies to closed paths (they have no start/end).
	const taperRequested =
		!isClosed && ((taperStart ?? 0) > 0 || (taperEnd ?? 0) > 0);

	// Arc-length parameterization (matches StampGenerator's pathT = cumulativeDist / totalLength)
	let arcLengths: Float64Array | null = null;
	let totalArcLength = 0;
	if (hasStrokeWidths || taperRequested || arcParams) {
		arcLengths = new Float64Array(pointCount);
		for (let i = 1; i < pointCount; i++) {
			const dx = points[i * 2] - points[(i - 1) * 2];
			const dy = points[i * 2 + 1] - points[(i - 1) * 2 + 1];
			arcLengths[i] = arcLengths[i - 1] + Math.sqrt(dx * dx + dy * dy);
		}
		totalArcLength = arcLengths[pointCount - 1];
	}

	// Apply the taper before per-side profile derivation so side1/side2 scale with it.
	if (arcLengths && taperRequested) {
		const taper = resolveTaper(
			taperStart,
			taperEnd,
			totalArcLength / Math.max(pathEnd - pathStart, 1e-6),
			pathStart,
			pathEnd,
		);
		if (taper) {
			for (let i = 0; i < pointCount; i++) {
				halfWidths[i] *= taperFactor(taper, arcLengths[i], totalArcLength);
			}
		}
	}

	const samples = buildStrokeSamples(
		points,
		halfWidths,
		strokeWidths,
		arcLengths,
		totalArcLength,
	);
	const visibleSubpaths = splitVisibleSubpaths(samples, isClosed);
	const result: StrokeTessellateResult = {
		vertices: [],
		count: 0,
		vertexParams: [],
	};

	// Maps a sample's local arc ratio into the whole stroke's t range.
	const globalArcTotal = arcParams
		? arcParams.totalArcLength || totalArcLength || 1
		: 1;
	const pathSpan = pathEnd - pathStart;
	const toGlobalT = (localT: number): number =>
		pathStart +
		(((arcParams?.arcOffset ?? 0) + localT * totalArcLength) / globalArcTotal) *
			pathSpan;

	for (const subpath of visibleSubpaths) {
		const subpathResult = tessellateVisibleSubpath(
			centerStrokeSamples(subpath.samples, subpath.isClosed),
			subpath.isClosed,
			lineCap,
			lineJoin,
			miterLimit,
			zoom,
			arcParams
				? subpath.samples.map(({ pathT }) => toGlobalT(pathT))
				: undefined,
		);
		appendNumbers(result.vertices, subpathResult.vertices);
		appendNumbers(result.vertexParams, subpathResult.vertexParams);
	}

	result.count = result.vertices.length / 2;
	return result;
}

interface StrokeSample {
	x: number;
	y: number;
	baseHalfWidth: number;
	centerRatio: number;
	halfRatio: number;
	/** Arc ratio 0..1 within the input polyline (0 when arc data is absent). */
	pathT: number;
}

interface VisibleSubpath {
	samples: StrokeSample[];
	isClosed: boolean;
}

interface CenteredStrokeSamples {
	points: number[];
	halfWidths: Float64Array;
}

function buildStrokeSamples(
	points: number[],
	halfWidths: Float64Array,
	strokeWidths: StrokeWidthPoint[] | undefined,
	arcLengths: Float64Array | null,
	totalArcLength: number,
): StrokeSample[] {
	if (!strokeWidths?.length || !arcLengths || totalArcLength <= 0) {
		return Array.from({ length: points.length / 2 }, (_, index) => ({
			x: points[index * 2],
			y: points[index * 2 + 1],
			baseHalfWidth: halfWidths[index],
			centerRatio: 0,
			halfRatio: 1,
			pathT:
				arcLengths && totalArcLength > 0
					? arcLengths[index] / totalArcLength
					: 0,
		}));
	}

	const pathTs = [
		...Array.from(arcLengths, (length) => length / totalArcLength),
		...strokeWidths.map(({ t }) => Math.min(1, Math.max(0, t))),
	].sort((a, b) => a - b);
	const uniquePathTs = pathTs.filter(
		(pathT, index) => index === 0 || pathT - pathTs[index - 1] > 1e-10,
	);

	return uniquePathTs.map((pathT) => {
		const { x, y, baseHalfWidth } = samplePolyline(
			points,
			halfWidths,
			arcLengths,
			totalArcLength,
			pathT,
		);
		const { side1, side2 } = interpolateStrokeWidths(strokeWidths, pathT);
		return {
			x,
			y,
			baseHalfWidth,
			centerRatio: (side1 - side2) / 2,
			halfRatio: (side1 + side2) / 2,
			pathT,
		};
	});
}

function samplePolyline(
	points: number[],
	halfWidths: Float64Array,
	arcLengths: Float64Array,
	totalArcLength: number,
	pathT: number,
): { x: number; y: number; baseHalfWidth: number } {
	const targetLength = pathT * totalArcLength;
	let index = 0;
	while (
		index < arcLengths.length - 2 &&
		arcLengths[index + 1] < targetLength
	) {
		index++;
	}

	while (
		index < arcLengths.length - 2 &&
		arcLengths[index + 1] - arcLengths[index] <= 1e-10
	) {
		index++;
	}

	const segmentLength = arcLengths[index + 1] - arcLengths[index];
	const t =
		segmentLength > 0
			? Math.min(
					1,
					Math.max(0, (targetLength - arcLengths[index]) / segmentLength),
				)
			: 0;
	return {
		x: points[index * 2] + (points[(index + 1) * 2] - points[index * 2]) * t,
		y:
			points[index * 2 + 1] +
			(points[(index + 1) * 2 + 1] - points[index * 2 + 1]) * t,
		baseHalfWidth:
			halfWidths[index] + (halfWidths[index + 1] - halfWidths[index]) * t,
	};
}

function splitVisibleSubpaths(
	samples: StrokeSample[],
	isClosed: boolean,
): VisibleSubpath[] {
	if (samples.length < 2) return [];
	if (samples.every(({ halfRatio }) => halfRatio > 0)) {
		return [{ samples, isClosed }];
	}

	const result: VisibleSubpath[] = [];
	let current: StrokeSample[] = [];

	for (let index = 0; index < samples.length - 1; index++) {
		const start = samples[index];
		const end = samples[index + 1];
		const startVisible = start.halfRatio > 0;
		const endVisible = end.halfRatio > 0;

		if (startVisible && current.length === 0) current.push(start);

		if (startVisible && endVisible) {
			current.push(end);
			continue;
		}

		if (startVisible) {
			current.push(interpolateZeroCrossing(start, end));
			if (current.length >= 2)
				result.push({ samples: current, isClosed: false });
			current = [];
			continue;
		}

		if (endVisible) {
			current = [interpolateZeroCrossing(start, end), end];
		}
	}

	if (current.length >= 2) result.push({ samples: current, isClosed: false });
	return result;
}

function interpolateZeroCrossing(
	start: StrokeSample,
	end: StrokeSample,
): StrokeSample {
	const range = start.halfRatio - end.halfRatio;
	const t = range !== 0 ? start.halfRatio / range : 0;
	return {
		x: start.x + (end.x - start.x) * t,
		y: start.y + (end.y - start.y) * t,
		baseHalfWidth:
			start.baseHalfWidth + (end.baseHalfWidth - start.baseHalfWidth) * t,
		centerRatio: start.centerRatio + (end.centerRatio - start.centerRatio) * t,
		halfRatio: 0,
		pathT: start.pathT + (end.pathT - start.pathT) * t,
	};
}

function centerStrokeSamples(
	samples: StrokeSample[],
	isClosed: boolean,
): CenteredStrokeSamples {
	const points = samples.flatMap(({ x, y }) => [x, y]);
	const normals = computePointNormals(points, isClosed);
	const centeredPoints: number[] = [];
	const visibleHalfWidths = new Float64Array(samples.length);

	for (let index = 0; index < samples.length; index++) {
		const sample = samples[index];
		const centerOffset = sample.baseHalfWidth * sample.centerRatio;
		centeredPoints.push(
			sample.x + normals[index * 2] * centerOffset,
			sample.y + normals[index * 2 + 1] * centerOffset,
		);
		visibleHalfWidths[index] = Math.max(
			0,
			sample.baseHalfWidth * sample.halfRatio,
		);
	}

	return { points: centeredPoints, halfWidths: visibleHalfWidths };
}

function computePointNormals(
	points: number[],
	isClosed: boolean,
): Float64Array {
	const pointCount = points.length / 2;
	const hasDuplicateClosure =
		isClosed &&
		pointCount > 1 &&
		Math.hypot(
			points[0] - points[(pointCount - 1) * 2],
			points[1] - points[(pointCount - 1) * 2 + 1],
		) <= 1e-10;
	const uniquePointCount = hasDuplicateClosure ? pointCount - 1 : pointCount;
	const segmentCount = isClosed
		? uniquePointCount
		: Math.max(0, uniquePointCount - 1);
	const segmentNormals = new Float64Array(segmentCount * 2);

	for (let index = 0; index < segmentCount; index++) {
		const nextIndex = isClosed ? (index + 1) % uniquePointCount : index + 1;
		const dx = points[nextIndex * 2] - points[index * 2];
		const dy = points[nextIndex * 2 + 1] - points[index * 2 + 1];
		const length = Math.hypot(dx, dy);
		if (length <= 1e-10) continue;
		segmentNormals[index * 2] = -dy / length;
		segmentNormals[index * 2 + 1] = dx / length;
	}

	const normals = new Float64Array(pointCount * 2);
	for (let index = 0; index < uniquePointCount; index++) {
		const previous = isClosed
			? (index - 1 + segmentCount) % segmentCount
			: Math.max(0, index - 1);
		const next = isClosed
			? index % segmentCount
			: Math.min(segmentCount - 1, index);
		let nx = segmentNormals[previous * 2] + segmentNormals[next * 2];
		let ny = segmentNormals[previous * 2 + 1] + segmentNormals[next * 2 + 1];
		const length = Math.hypot(nx, ny);
		if (length > 1e-10) {
			nx /= length;
			ny /= length;
		} else {
			nx = segmentNormals[next * 2];
			ny = segmentNormals[next * 2 + 1];
		}
		normals[index * 2] = nx;
		normals[index * 2 + 1] = ny;
	}
	if (hasDuplicateClosure) {
		normals[(pointCount - 1) * 2] = normals[0];
		normals[(pointCount - 1) * 2 + 1] = normals[1];
	}
	return normals;
}

function tessellateVisibleSubpath(
	centered: CenteredStrokeSamples,
	isClosed: boolean,
	lineCap: LineCap,
	lineJoin: LineJoin,
	miterLimit: number,
	zoom: number,
	/** Whole-stroke t per sample; enables vertexParams emission. */
	globalTs?: number[],
): StrokeTessellateResult {
	const { points, halfWidths } = centered;
	const segments = buildSegments(points, points.length / 2);
	if (segments.length === 0) {
		return { vertices: [], count: 0, vertexParams: [] };
	}

	const vertices: number[] = [];
	const vertexParams: number[] = [];
	const corners = segments.map((seg) =>
		bodyCorners(seg, halfWidths[seg.i0], halfWidths[seg.i1]),
	);

	// Adjacent bodies overlap on the inside of a turn. Coverage accumulates
	// area, so an overlap would double the partial pixels along the inner
	// edge; meeting the bodies at the inner offset intersection instead keeps
	// the union exact wherever both segments reach that point.
	const joinCount = isClosed ? segments.length : segments.length - 1;
	const innerCorners: ReturnType<typeof trimInnerCorner>[] = [];
	for (let index = 0; index < joinCount; index++) {
		const next = (index + 1) % segments.length;
		innerCorners.push(
			trimInnerCorner(
				segments[index],
				segments[next],
				corners[index],
				corners[next],
			),
		);
	}

	for (let index = 0; index < segments.length; index++) {
		const seg = segments[index];
		const [lx0, ly0, rx0, ry0, lx1, ly1, rx1, ry1] = corners[index];
		pushTriangle(vertices, lx0, ly0, rx0, ry0, lx1, ly1);
		pushTriangle(vertices, rx0, ry0, rx1, ry1, lx1, ly1);
		if (globalTs) {
			const t0 = globalTs[seg.i0];
			const t1 = globalTs[seg.i1];
			vertexParams.push(t0, 1, t0, 0, t1, 1, t0, 0, t1, 0, t1, 1);
		}
	}

	for (let index = 0; index < joinCount; index++) {
		const segA = segments[index];
		const segB = segments[(index + 1) % segments.length];
		const joinIndex = segA.i1;
		const groupStart = vertices.length;
		const cx = points[joinIndex * 2];
		const cy = points[joinIndex * 2 + 1];
		const inner = innerCorners[index];
		if (inner !== null) {
			// Trimming moves the body ends away from the join's center fan.
			// Bridge both ends without overlapping the trimmed inner edge.
			const outer = inner === 4 ? 6 : 4;
			const a = corners[index];
			const b = corners[(index + 1) % segments.length];
			pushTriangle(
				vertices,
				a[inner],
				a[inner + 1],
				a[outer],
				a[outer + 1],
				cx,
				cy,
			);
			pushTriangle(
				vertices,
				a[inner],
				a[inner + 1],
				cx,
				cy,
				b[outer - 4],
				b[outer - 3],
			);
		}
		emitJoin(
			vertices,
			lineJoin,
			miterLimit,
			segA,
			segB,
			cx,
			cy,
			halfWidths[joinIndex],
			halfWidths[joinIndex],
			zoom,
			inner === null,
		);
		if (globalTs) {
			appendJoinGroupParams(
				vertices,
				groupStart,
				vertexParams,
				globalTs[joinIndex],
				cx,
				cy,
				segA,
				segB,
				halfWidths[joinIndex],
			);
		}
	}

	if (!isClosed) {
		const first = segments[0];
		let groupStart = vertices.length;
		emitCap(
			vertices,
			lineCap,
			first.x0,
			first.y0,
			-first.dx,
			-first.dy,
			first.nx,
			first.ny,
			halfWidths[first.i0],
			halfWidths[first.i0],
			zoom,
		);
		if (globalTs) {
			appendGroupParams(
				vertices,
				groupStart,
				vertexParams,
				globalTs[first.i0],
				first.x0,
				first.y0,
				first.nx,
				first.ny,
				halfWidths[first.i0],
			);
		}
		const last = segments.at(-1)!;
		groupStart = vertices.length;
		emitCap(
			vertices,
			lineCap,
			last.x1,
			last.y1,
			last.dx,
			last.dy,
			last.nx,
			last.ny,
			halfWidths[last.i1],
			halfWidths[last.i1],
			zoom,
		);
		if (globalTs) {
			appendGroupParams(
				vertices,
				groupStart,
				vertexParams,
				globalTs[last.i1],
				last.x1,
				last.y1,
				last.nx,
				last.ny,
				halfWidths[last.i1],
			);
		}
	}

	return { vertices, count: vertices.length / 2, vertexParams };
}

/** Total arc length of a flat [x, y, ...] polyline. */
export function polylineArcLength(points: number[]): number {
	let total = 0;
	for (let i = 2; i < points.length; i += 2) {
		total += Math.hypot(
			points[i] - points[i - 2],
			points[i + 1] - points[i - 1],
		);
	}
	return total;
}

/**
 * Splits a polyline into dash sub-polylines according to an SVG-style dash pattern.
 * Each returned sub-polyline contains interpolated points and pressures
 * at exact dash/gap boundaries, plus its start arc length within the input
 * polyline (`arcOffset`).
 */
export function applyDashPattern(
	points: number[],
	pressures: number[],
	dashArray: readonly number[],
	dashOffset: number,
): { points: number[]; pressures: number[]; arcOffset: number }[] {
	const pointCount = points.length / 2;
	if (pointCount < 2) return [{ points, pressures, arcOffset: 0 }];

	// No-op when dashArray is empty or all zeros
	if (dashArray.length === 0) return [{ points, pressures, arcOffset: 0 }];

	let pattern = dashArray;

	// SVG spec: odd-length pattern is doubled
	if (pattern.length % 2 !== 0) {
		pattern = [...pattern, ...pattern];
	}

	const totalPatternLength = pattern.reduce((sum, v) => sum + v, 0);
	if (totalPatternLength <= 0) return [{ points, pressures, arcOffset: 0 }];

	// Normalize phase into [0, totalPatternLength) — matching Skia's CalcDashParameters
	let phase = dashOffset;
	if (phase < 0) {
		phase = -phase;
		if (phase > totalPatternLength) {
			phase = phase % totalPatternLength;
		}
		phase = totalPatternLength - phase;
		if (phase === totalPatternLength) phase = 0;
	} else if (phase >= totalPatternLength) {
		phase = phase % totalPatternLength;
	}

	// find_first_interval — matching Skia's condition:
	// advance past interval when phase > gap, or phase == gap && gap != 0
	let phaseIndex = 0;
	let phaseRemaining = pattern[0];

	for (let i = 0; i < pattern.length; i++) {
		const gap = pattern[i];
		if (phase > gap || (phase === gap && gap !== 0)) {
			phase -= gap;
		} else {
			phaseIndex = i;
			phaseRemaining = gap - phase;
			break;
		}
		// Fallback for floating-point accumulation errors (matches Skia)
		if (i === pattern.length - 1) {
			phaseIndex = 0;
			phaseRemaining = pattern[0];
		}
	}

	const isDash = () => phaseIndex % 2 === 0;

	const result: { points: number[]; pressures: number[]; arcOffset: number }[] =
		[];

	// Current dash accumulator
	let curPoints: number[] = [];
	let curPressures: number[] = [];
	// Arc length walked before the current segment / at the current dash's start
	let walked = 0;
	let curArcOffset = 0;

	// Start first dash if we begin in a dash phase
	if (isDash()) {
		curPoints.push(points[0], points[1]);
		curPressures.push(pressures[0]);
	}

	for (let i = 0; i < pointCount - 1; i++) {
		const x0 = points[i * 2];
		const y0 = points[i * 2 + 1];
		const p0 = pressures[i];
		const x1 = points[(i + 1) * 2];
		const y1 = points[(i + 1) * 2 + 1];
		const p1 = pressures[i + 1];

		const dx = x1 - x0;
		const dy = y1 - y0;
		const segLen = Math.sqrt(dx * dx + dy * dy);

		if (segLen < 1e-10) {
			// Zero-length segment: just carry the point forward if in dash
			if (isDash() && curPoints.length >= 2) {
				curPoints.push(x1, y1);
				curPressures.push(p1);
			}
			continue;
		}

		let consumed = 0;

		while (consumed < segLen) {
			const remaining = segLen - consumed;

			if (phaseRemaining > remaining) {
				// Current phase extends beyond this segment
				phaseRemaining -= remaining;

				if (isDash()) {
					curPoints.push(x1, y1);
					curPressures.push(p1);
				}
				break;
			}

			// Phase ends within this segment
			const t = (consumed + phaseRemaining) / segLen;
			const ix = x0 + t * dx;
			const iy = y0 + t * dy;
			const ip = p0 + t * (p1 - p0);

			consumed += phaseRemaining;

			if (isDash()) {
				// End current dash
				curPoints.push(ix, iy);
				curPressures.push(ip);

				if (curPoints.length >= 4) {
					// At least 2 points (4 floats in flat array)
					result.push({
						points: curPoints,
						pressures: curPressures,
						arcOffset: curArcOffset,
					});
				}
				curPoints = [];
				curPressures = [];
			} else {
				// End gap, start new dash
				curPoints = [ix, iy];
				curPressures = [ip];
				curArcOffset = walked + consumed;
			}

			// Advance to next phase
			phaseIndex = (phaseIndex + 1) % pattern.length;
			phaseRemaining = pattern[phaseIndex];

			// Skip zero-length phases
			while (phaseRemaining <= 0 && consumed < segLen) {
				if (isDash()) {
					// Zero-length dash produces nothing
				} else {
					// Zero-length gap: no interruption, continue current dash if any
				}
				phaseIndex = (phaseIndex + 1) % pattern.length;
				phaseRemaining = pattern[phaseIndex];
			}
		}

		walked += segLen;
	}

	// Flush remaining dash
	if (isDash() && curPoints.length >= 4) {
		result.push({
			points: curPoints,
			pressures: curPressures,
			arcOffset: curArcOffset,
		});
	}

	return result;
}

// --- Gradient param (t, u) helpers ---

/** Cross-stroke position 0..1 from a signed offset along the sample normal. */
function crossStrokeU(
	dx: number,
	dy: number,
	nx: number,
	ny: number,
	halfWidth: number,
): number {
	if (halfWidth <= 0) return 0.5;
	const u = 0.5 + (dx * nx + dy * ny) / (2 * halfWidth);
	return u < 0 ? 0 : u > 1 ? 1 : u;
}

/**
 * Append (t, u) for every vertex emitted after `startLength` (cap/join
 * groups): t is the group's sample t, u is classified from the vertex's
 * signed distance to the sample center along `nx/ny`.
 */
function appendGroupParams(
	out: number[],
	startLength: number,
	params: number[],
	t: number,
	cx: number,
	cy: number,
	nx: number,
	ny: number,
	halfWidth: number,
): void {
	for (let i = startLength; i < out.length; i += 2) {
		params.push(
			t,
			crossStrokeU(out[i] - cx, out[i + 1] - cy, nx, ny, halfWidth),
		);
	}
}

/** appendGroupParams with the join's averaged segment normal. */
function appendJoinGroupParams(
	out: number[],
	startLength: number,
	params: number[],
	t: number,
	cx: number,
	cy: number,
	segA: Segment,
	segB: Segment,
	halfWidth: number,
): void {
	let nx = segA.nx + segB.nx;
	let ny = segA.ny + segB.ny;
	const length = Math.hypot(nx, ny);
	if (length > 1e-10) {
		nx /= length;
		ny /= length;
	} else {
		nx = segA.nx;
		ny = segA.ny;
	}
	appendGroupParams(out, startLength, params, t, cx, cy, nx, ny, halfWidth);
}

// --- Helper types ---

interface Segment {
	i0: number;
	i1: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	dx: number;
	dy: number;
	nx: number;
	ny: number;
}

/** Body quad corners: left start, right start, left end, right end. */
type BodyCorners = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

function bodyCorners(seg: Segment, hw0: number, hw1: number): BodyCorners {
	return [
		seg.x0 + seg.nx * hw0,
		seg.y0 + seg.ny * hw0,
		seg.x0 - seg.nx * hw0,
		seg.y0 - seg.ny * hw0,
		seg.x1 + seg.nx * hw1,
		seg.y1 + seg.ny * hw1,
		seg.x1 - seg.nx * hw1,
		seg.y1 - seg.ny * hw1,
	];
}

/**
 * Move the inner end corner of `a` and the inner start corner of `b` to the
 * intersection of their inner offset edges. Returns the inner end index of
 * `a`, or null without changing either body when no intersection lies
 * within both segments.
 */
function trimInnerCorner(
	segA: Segment,
	segB: Segment,
	a: BodyCorners,
	b: BodyCorners,
): 4 | 6 | null {
	const cross = segA.dx * segB.dy - segA.dy * segB.dx;
	if (Math.abs(cross) < 1e-10) return null;

	// Left-hand normals: on a left (CCW) turn the left side is the inside.
	const start = cross > 0 ? 0 : 2;
	const end = cross > 0 ? 4 : 6;
	const adx = a[end] - a[start];
	const ady = a[end + 1] - a[start + 1];
	const bdx = b[end] - b[start];
	const bdy = b[end + 1] - b[start + 1];
	const hit = lineLineIntersect(
		a[start],
		a[start + 1],
		adx,
		ady,
		b[start],
		b[start + 1],
		bdx,
		bdy,
	);
	if (hit === null) return null;

	const [px, py] = hit;
	const alongA =
		((px - a[start]) * adx + (py - a[start + 1]) * ady) /
		(adx * adx + ady * ady);
	const alongB =
		((px - b[start]) * bdx + (py - b[start + 1]) * bdy) /
		(bdx * bdx + bdy * bdy);
	if (!(alongA >= 0 && alongA <= 1 && alongB >= 0 && alongB <= 1)) {
		return null;
	}

	a[end] = px;
	a[end + 1] = py;
	b[start] = px;
	b[start + 1] = py;
	return end;
}

// --- Segment construction ---

function buildSegments(points: number[], pointCount: number): Segment[] {
	const segments: Segment[] = [];

	for (let i = 0; i < pointCount - 1; i++) {
		const x0 = points[i * 2];
		const y0 = points[i * 2 + 1];
		const x1 = points[(i + 1) * 2];
		const y1 = points[(i + 1) * 2 + 1];

		const ex = x1 - x0;
		const ey = y1 - y0;
		const len = Math.sqrt(ex * ex + ey * ey);

		if (len < 1e-10) continue;

		const dx = ex / len;
		const dy = ey / len;

		segments.push({
			i0: i,
			i1: i + 1,
			x0,
			y0,
			x1,
			y1,
			dx,
			dy,
			nx: -dy,
			ny: dx,
		});
	}

	return segments;
}

// --- Join emitters ---

/** Device-space error budget for round join/cap arc subdivision (px). */
const ARC_TOLERANCE_PX = 0.25;

/**
 * Angular step whose chord deviates from the arc by at most ARC_TOLERANCE_PX
 * on screen (NanoVG's curve-divs formula: the sagitta is r·tol/(r+tol) < tol),
 * so subdivision follows the on-screen radius instead of a fixed step.
 */
function arcAngleStep(radius: number, zoom: number): number {
	return 2 * Math.acos(radius / (radius + ARC_TOLERANCE_PX / zoom));
}

/** Semicircle subdivision for round caps. */
function roundCapSteps(side1Hw: number, side2Hw: number, zoom: number): number {
	return Math.max(
		2,
		Math.ceil(Math.PI / arcAngleStep(Math.max(side1Hw, side2Hw), zoom)),
	);
}

function emitJoin(
	out: number[],
	joinType: LineJoin,
	miterLimit: number,
	segA: Segment,
	segB: Segment,
	cx: number,
	cy: number,
	side1Hw: number,
	side2Hw: number,
	zoom: number,
	/** Bridge the inner-side gap between untrimmed bodies. */
	fillInnerGap: boolean,
): void {
	const cross = segA.dx * segB.dy - segA.dy * segB.dx;

	if (Math.abs(cross) < 1e-10) return;

	const isLeftTurn = cross > 0;

	// Normals are left-hand ((nx,ny) = (-dy,dx)). On a left (CCW) turn the
	// left side is the inside of the corner, so inner = +normal (side1) and
	// outer = -normal (side2); mirrored on a right turn.
	const innerHw = isLeftTurn ? side1Hw : side2Hw;
	const outerHw = isLeftTurn ? side2Hw : side1Hw;
	const innerSign = isLeftTurn ? 1 : -1;

	if (fillInnerGap) {
		pushTriangle(
			out,
			cx,
			cy,
			cx + segA.nx * innerHw * innerSign,
			cy + segA.ny * innerHw * innerSign,
			cx + segB.nx * innerHw * innerSign,
			cy + segB.ny * innerHw * innerSign,
		);
	}

	if (joinType === "miter") {
		emitMiterJoin(out, miterLimit, segA, segB, cx, cy, outerHw, isLeftTurn);
	} else if (joinType === "round") {
		emitRoundJoin(out, segA, segB, cx, cy, outerHw, isLeftTurn, zoom);
	} else {
		emitBevelJoin(out, segA, segB, cx, cy, outerHw, isLeftTurn);
	}
}

function emitMiterJoin(
	out: number[],
	miterLimit: number,
	segA: Segment,
	segB: Segment,
	cx: number,
	cy: number,
	hw: number,
	isLeftTurn: boolean,
): void {
	const sign = isLeftTurn ? -1 : 1;

	const outerA_x = cx + segA.nx * hw * sign;
	const outerA_y = cy + segA.ny * hw * sign;
	const outerB_x = cx + segB.nx * hw * sign;
	const outerB_y = cy + segB.ny * hw * sign;

	const ix = lineLineIntersect(
		outerA_x,
		outerA_y,
		segA.dx,
		segA.dy,
		outerB_x,
		outerB_y,
		segB.dx,
		segB.dy,
	);

	if (ix === null) {
		emitBevelJoin(out, segA, segB, cx, cy, hw, isLeftTurn);
		return;
	}

	const miterDx = ix[0] - cx;
	const miterDy = ix[1] - cy;
	const miterLen = Math.sqrt(miterDx * miterDx + miterDy * miterDy);

	if (miterLen / hw > miterLimit) {
		emitBevelJoin(out, segA, segB, cx, cy, hw, isLeftTurn);
		return;
	}

	pushTriangle(out, cx, cy, outerA_x, outerA_y, ix[0], ix[1]);
	pushTriangle(out, cx, cy, ix[0], ix[1], outerB_x, outerB_y);
}

function emitRoundJoin(
	out: number[],
	segA: Segment,
	segB: Segment,
	cx: number,
	cy: number,
	hw: number,
	isLeftTurn: boolean,
	zoom: number,
): void {
	const sign = isLeftTurn ? -1 : 1;

	const nAx = segA.nx * sign;
	const nAy = segA.ny * sign;
	const nBx = segB.nx * sign;
	const nBy = segB.ny * sign;

	const angleA = Math.atan2(nAy, nAx);
	const angleB = Math.atan2(nBy, nBx);

	let angleDiff = angleB - angleA;
	if (isLeftTurn) {
		if (angleDiff < 0) angleDiff += Math.PI * 2;
	} else {
		if (angleDiff > 0) angleDiff -= Math.PI * 2;
	}

	const steps = Math.max(
		2,
		Math.ceil(Math.abs(angleDiff) / arcAngleStep(hw, zoom)),
	);
	const angleStep = angleDiff / steps;

	for (let s = 0; s < steps; s++) {
		const a0 = angleA + angleStep * s;
		const a1 = angleA + angleStep * (s + 1);

		const cos0 = Math.cos(a0);
		const sin0 = Math.sin(a0);
		const cos1 = Math.cos(a1);
		const sin1 = Math.sin(a1);

		pushTriangle(
			out,
			cx,
			cy,
			cx + cos0 * hw,
			cy + sin0 * hw,
			cx + cos1 * hw,
			cy + sin1 * hw,
		);
	}
}

function emitBevelJoin(
	out: number[],
	segA: Segment,
	segB: Segment,
	cx: number,
	cy: number,
	hw: number,
	isLeftTurn: boolean,
): void {
	const sign = isLeftTurn ? -1 : 1;

	const outerA_x = cx + segA.nx * hw * sign;
	const outerA_y = cy + segA.ny * hw * sign;
	const outerB_x = cx + segB.nx * hw * sign;
	const outerB_y = cy + segB.ny * hw * sign;

	pushTriangle(out, cx, cy, outerA_x, outerA_y, outerB_x, outerB_y);
}

// --- Cap emitters ---

function emitCap(
	out: number[],
	capType: LineCap,
	px: number,
	py: number,
	dx: number,
	dy: number,
	nx: number,
	ny: number,
	side1Hw: number,
	side2Hw: number,
	zoom: number,
): void {
	if (capType === "butt") return;

	if (capType === "square") {
		emitSquareCap(out, px, py, dx, dy, nx, ny, side1Hw, side2Hw);
	} else {
		emitRoundCap(out, px, py, dx, dy, nx, ny, side1Hw, side2Hw, zoom);
	}
}

function emitSquareCap(
	out: number[],
	px: number,
	py: number,
	dx: number,
	dy: number,
	nx: number,
	ny: number,
	side1Hw: number,
	side2Hw: number,
): void {
	// side1 = +normal (left), side2 = -normal (right)
	const lx = px + nx * side1Hw;
	const ly = py + ny * side1Hw;
	const rx = px - nx * side2Hw;
	const ry = py - ny * side2Hw;
	const extHw = Math.max(side1Hw, side2Hw);
	const elx = lx + dx * extHw;
	const ely = ly + dy * extHw;
	const erx = rx + dx * extHw;
	const ery = ry + dy * extHw;

	pushTriangle(out, lx, ly, rx, ry, elx, ely);
	pushTriangle(out, rx, ry, erx, ery, elx, ely);
}

function emitRoundCap(
	out: number[],
	px: number,
	py: number,
	dx: number,
	dy: number,
	_nx: number,
	_ny: number,
	side1Hw: number,
	side2Hw: number,
	zoom: number,
): void {
	const steps = roundCapSteps(side1Hw, side2Hw, zoom);
	const startAngle = Math.atan2(dx, -dy);
	// Sweep clockwise so the semicircle extends outward (through the cap
	// direction) rather than inward through the stroke body.
	const angleStep = -Math.PI / steps;

	for (let s = 0; s < steps; s++) {
		const a0 = startAngle + angleStep * s;
		const a1 = startAngle + angleStep * (s + 1);

		// Interpolate radius from side1Hw to side2Hw across the half-circle
		const t0 = s / steps;
		const t1 = (s + 1) / steps;
		const r0 = side1Hw + (side2Hw - side1Hw) * t0;
		const r1 = side1Hw + (side2Hw - side1Hw) * t1;

		const cos0 = Math.cos(a0);
		const sin0 = Math.sin(a0);
		const cos1 = Math.cos(a1);
		const sin1 = Math.sin(a1);

		pushTriangle(
			out,
			px,
			py,
			px + cos0 * r0,
			py + sin0 * r0,
			px + cos1 * r1,
			py + sin1 * r1,
		);
	}
}

// --- Geometry utilities ---

/** Push a triangle as [x, y] per vertex with a consistent winding. */
function pushTriangle(
	out: number[],
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
): void {
	const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

	if (cross >= 0) {
		out.push(ax, ay, bx, by, cx, cy);
	} else {
		out.push(ax, ay, cx, cy, bx, by);
	}
}

function lineLineIntersect(
	ax: number,
	ay: number,
	adx: number,
	ady: number,
	bx: number,
	by: number,
	bdx: number,
	bdy: number,
): [number, number] | null {
	const denom = adx * bdy - ady * bdx;
	if (Math.abs(denom) < 1e-10) return null;

	const t = ((bx - ax) * bdy - (by - ay) * bdx) / denom;
	return [ax + adx * t, ay + ady * t];
}

/**
 * Interpolate side1/side2 width ratios from a StrokeWidthPoint array at a given pathT.
 *
 * Uses binary search for O(log n) lookup. Implicit endpoints at t=0 and t=1
 * with side1=1, side2=1 (full width) are assumed when not explicitly present.
 */
export function interpolateStrokeWidths(
	strokeWidths: StrokeWidthPoint[],
	pathT: number,
): { side1: number; side2: number } {
	if (strokeWidths.length === 0) return { side1: 1, side2: 1 };

	// Before first point: lerp from implicit {t:0, 1, 1}
	if (pathT <= strokeWidths[0].t) {
		const first = strokeWidths[0];
		if (first.t <= 0) return { side1: first.side1, side2: first.side2 };
		const frac = pathT / first.t;
		return {
			side1: 1 + (first.side1 - 1) * frac,
			side2: 1 + (first.side2 - 1) * frac,
		};
	}

	// After last point: lerp to implicit {t:1, 1, 1}
	const last = strokeWidths[strokeWidths.length - 1];
	if (pathT >= last.t) {
		const remaining = 1 - last.t;
		if (remaining <= 0) return { side1: last.side1, side2: last.side2 };
		const frac = (pathT - last.t) / remaining;
		return {
			side1: last.side1 + (1 - last.side1) * frac,
			side2: last.side2 + (1 - last.side2) * frac,
		};
	}

	// Binary search for the interval containing pathT
	let lo = 0;
	let hi = strokeWidths.length - 1;
	while (lo < hi - 1) {
		const mid = (lo + hi) >> 1;
		if (strokeWidths[mid].t <= pathT) lo = mid;
		else hi = mid;
	}

	const a = strokeWidths[lo];
	const b = strokeWidths[hi];
	const range = b.t - a.t;
	const frac = range > 0 ? (pathT - a.t) / range : 0;
	return {
		side1: a.side1 + (b.side1 - a.side1) * frac,
		side2: a.side2 + (b.side2 - a.side2) * frac,
	};
}

/**
 * Appends every element of `src` to `dst`.
 *
 * `dst.push(...src)` passes one argument per element, so a dense subpath
 * (tens of thousands of vertices) overflows the engine's argument limit and
 * throws RangeError: Maximum call stack size exceeded.
 */
function appendNumbers(dst: number[], src: number[]): void {
	for (let i = 0; i < src.length; i++) {
		dst.push(src[i]);
	}
}

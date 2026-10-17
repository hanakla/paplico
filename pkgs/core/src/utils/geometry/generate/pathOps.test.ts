import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import { createIdentityTransform } from "../../../document/factory";
import type {
	BezierPoint,
	CompoundPathSource,
	CubicBezierSegment,
	FillAppearance,
	Path,
	StrokeAppearance,
} from "../../../schema";
import clipCompoundUnionPaths from "../../../testUtils/fixtures/clipCompoundUnionPaths.json";
import zeroHandleUnionPaths from "../../../testUtils/fixtures/zeroHandleUnionPaths.json";
import { createFilledRect, KAPPA } from "../../../testUtils/segmentFactory";
import { evalCubicBezier } from "../primitives/bezier";
import { resolveSegment } from "../primitives/segment";
import { toWorldPath } from "../space/worldSegments";
import { computeBooleanOperation, triangleSoupOutline } from "./pathOps";

// ============================================================================
// computeBooleanOperation
// ============================================================================

const BLACK = { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 };
const RED_FILL = {
	type: "solid" as const,
	color: BLACK,
};

/** A filled arch from the origin along one curve, closed by a straight line. */
function createArchPath(
	id: string,
	cp1: BezierPoint,
	cp2: BezierPoint,
	endX: number,
	endY: number,
): Path {
	const origin: BezierPoint = { x: 0, y: 0 };
	const end: BezierPoint = { x: endX, y: endY };
	return {
		...createCirclePath(id, 0, 0, 1),
		segments: [
			makeSegment(origin, cp1, cp2, end, true),
			{ ...makeSegment(end, end, origin, origin), isClosed: true },
		],
	};
}

/** Winding number of the outline around `point`, the count the non-zero fill reads. */
function windingAt(segments: CubicBezierSegment[], point: BezierPoint): number {
	let winding = 0;
	let prevEnd: BezierPoint | undefined;
	for (const segment of segments) {
		const samples = sampleSegments([segment], prevEnd);
		prevEnd = segment.end;
		for (const [i, a] of samples.slice(0, -1).entries()) {
			const b = samples[i + 1];
			if (a.y <= point.y === b.y <= point.y) continue;
			const x = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
			if (x > point.x) winding += b.y > a.y ? 1 : -1;
		}
	}
	return winding;
}

function sampleSegments(
	segments: CubicBezierSegment[],
	firstStart?: BezierPoint,
): BezierPoint[] {
	let prevEnd = firstStart;
	return segments.flatMap((segment) => {
		const { start, cp1, cp2, end } = resolveSegment(segment, prevEnd);
		prevEnd = segment.end;
		return Array.from({ length: 65 }, (_, i) =>
			evalCubicBezier(start, cp1, cp2, end, i / 64),
		);
	});
}

function createCirclePath(id: string, cx: number, cy: number, r: number): Path {
	const kr = r * KAPPA;
	const p0: BezierPoint = { x: cx + r, y: cy };
	const p1: BezierPoint = { x: cx + r, y: cy + kr };
	const p2: BezierPoint = { x: cx + kr, y: cy + r };
	const p3: BezierPoint = { x: cx, y: cy + r };
	const p4: BezierPoint = { x: cx - kr, y: cy + r };
	const p5: BezierPoint = { x: cx - r, y: cy + kr };
	const p6: BezierPoint = { x: cx - r, y: cy };
	const p7: BezierPoint = { x: cx - r, y: cy - kr };
	const p8: BezierPoint = { x: cx - kr, y: cy - r };
	const p9: BezierPoint = { x: cx, y: cy - r };
	const p10: BezierPoint = { x: cx + kr, y: cy - r };
	const p11: BezierPoint = { x: cx + r, y: cy - kr };

	const segments: CubicBezierSegment[] = [
		makeSegment(p0, p1, p2, p3, true),
		makeSegment(p3, p4, p5, p6),
		makeSegment(p6, p7, p8, p9),
		{
			...makeSegment(p9, p10, p11, p0),
			isClosed: true,
		},
	];

	return {
		type: "path",
		id,
		segments,
		filters: [
			{
				processor: "fill",
				paramData: { version: "1", params: { fill: RED_FILL } },
			} as FillAppearance,
			{
				processor: "stroke",
				paramData: {
					version: "1",
					params: {
						strokeColor: { type: "solid", color: BLACK },
						brushSettings: { type: "line", size: 0, opacity: 1 },
					},
				},
			} as unknown as StrokeAppearance,
		],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function makeSegment(
	start: BezierPoint,
	cp1Abs: BezierPoint,
	cp2Abs: BezierPoint,
	end: BezierPoint,
	isMoved = false,
): CubicBezierSegment {
	return {
		start,
		cp1: {
			x: cp1Abs.x - start.x,
			y: cp1Abs.y - start.y,
		},
		cp2: {
			x: cp2Abs.x - end.x,
			y: cp2Abs.y - end.y,
		},
		end,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved,
	};
}

function segmentHasFiniteCoordinates(segment: CubicBezierSegment): boolean {
	const values = [
		segment.start?.x,
		segment.start?.y,
		segment.cp1.x,
		segment.cp1.y,
		segment.cp2.x,
		segment.cp2.y,
		segment.end.x,
		segment.end.y,
	];

	return values.every((v) => v === undefined || Number.isFinite(v));
}

function segmentsBounds(segments: CubicBezierSegment[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
} {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let prevEnd: BezierPoint | undefined;

	for (const segment of segments) {
		const { start, cp1, cp2, end } = resolveSegment(segment, prevEnd);
		for (const point of [start, cp1, cp2, end]) {
			minX = Math.min(minX, point.x);
			minY = Math.min(minY, point.y);
			maxX = Math.max(maxX, point.x);
			maxY = Math.max(maxY, point.y);
		}
		prevEnd = segment.end;
	}

	if (minX === Number.POSITIVE_INFINITY) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	}

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

// ============================================================================
// Test helpers — after all test cases
// ============================================================================

/** An axis-aligned rectangle as two triangles. */
function rectTriangles(x0: number, y0: number, x1: number, y1: number) {
	return [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1];
}

describe("computeBooleanOperation", () => {
	it("keeps the union of two circles on the circles instead of flattening it", () => {
		const pathA = createCirclePath("a", 0, 0, 100);
		const pathB = createCirclePath("b", 80, 0, 100);

		const segments = computeBooleanOperation(
			[
				{ id: pathA.id, op: "union" },
				{ id: pathB.id, op: "union" },
			],
			new Map<string, Path>([
				[pathA.id, pathA],
				[pathB.id, pathB],
			]),
		);

		expect(segments.length).toBe(8);
		let prevEnd: BezierPoint | undefined;
		for (const segment of segments) {
			const { start, cp1, cp2, end } = resolveSegment(segment, prevEnd);
			const mid = evalCubicBezier(start, cp1, cp2, end, 0.5);
			const offCircle = Math.min(
				Math.abs(Math.hypot(mid.x, mid.y) - 100),
				Math.abs(Math.hypot(mid.x - 80, mid.y) - 100),
			);
			expect(offCircle).toBeLessThan(0.1);
			prevEnd = segment.end;
		}
	});

	it("ignores the stroke width of an open source and closes it with a straight line", () => {
		const base = createCirclePath("a", 0, 0, 100);
		const openHalf: Path = {
			...createCirclePath("b", 0, 0, 100),
			segments: createCirclePath("b", 0, 0, 100).segments.slice(0, 2),
			filters: [
				{
					processor: "stroke",
					paramData: {
						version: "1",
						params: {
							strokeColor: { type: "solid", color: BLACK },
							brushSettings: { type: "line", size: 40, opacity: 1 },
						},
					},
				} as unknown as StrokeAppearance,
			],
		};

		const segments = computeBooleanOperation(
			[
				{ id: base.id, op: "union" },
				{ id: openHalf.id, op: "intersect" },
			],
			new Map<string, Path>([
				[base.id, base],
				[openHalf.id, openHalf],
			]),
		);

		const bounds = segmentsBounds(segments);
		expect(bounds.width).toBeCloseTo(200, 0);
		expect(bounds.height).toBeCloseTo(100, 0);
	});

	it("rounds the corners of a source that has corner radii", () => {
		const rect = createFilledRect(0, 0, 100, 100);
		const rounded: Path = {
			...rect,
			id: "rounded",
			segments: rect.segments.map((segment) => ({
				...segment,
				cornerRadius: 20,
			})),
		};
		const cover: Path = {
			...createFilledRect(-50, -50, 200, 200),
			id: "cover",
		};

		const segments = computeBooleanOperation(
			[
				{ id: rounded.id, op: "union" },
				{ id: cover.id, op: "intersect" },
			],
			new Map<string, Path>([
				[rounded.id, rounded],
				[cover.id, cover],
			]),
		);

		const bounds = segmentsBounds(segments);
		expect(bounds.width).toBeCloseTo(100, 0);
		expect(bounds.height).toBeCloseTo(100, 0);
		for (const corner of [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 },
		]) {
			const nearest = Math.min(
				...segments.map((segment) =>
					Math.hypot(segment.end.x - corner.x, segment.end.y - corner.y),
				),
			);
			expect(nearest).toBeGreaterThan(5);
		}
	});

	it("returns valid geometry for subtract/intersect/exclude", () => {
		const pathA = createCirclePath("a", 0, 0, 90);
		const pathB = createCirclePath("b", 50, 0, 90);
		const pathMap = new Map<string, Path>([
			[pathA.id, pathA],
			[pathB.id, pathB],
		]);

		for (const op of ["subtract", "intersect", "exclude"] as const) {
			const segments = computeBooleanOperation(
				[
					{ id: pathA.id, op: "union" },
					{ id: pathB.id, op },
				],
				pathMap,
			);

			expect(segments.length).toBeGreaterThan(0);
			expect(segments.every(segmentHasFiniteCoordinates)).toBe(true);
		}
	});

	it("keeps a self-crossing source whose curves have a zero handle at a shared vertex", () => {
		const [pathA, pathB] = (zeroHandleUnionPaths as unknown as Path[]).map(
			(path) => toWorldPath(path),
		);

		const segments = computeBooleanOperation(
			[
				{ id: pathA.id, op: "union" },
				{ id: pathB.id, op: "union" },
			],
			new Map<string, Path>([
				[pathA.id, pathA],
				[pathB.id, pathB],
			]),
		);

		const bounds = segmentsBounds(segments);
		expect(bounds.minX).toBeCloseTo(1389.57, 1);
		expect(bounds.maxX).toBeCloseTo(1456.39, 1);
	});

	it("keeps sources that cross next to a vertex where a curve's handle is zero", () => {
		const paths = (clipCompoundUnionPaths as unknown as Path[]).map((path) =>
			toWorldPath(path),
		);

		const segments = computeBooleanOperation(
			paths.map((path) => ({ id: path.id, op: "union" })),
			new Map(paths.map((path) => [path.id, path])),
		);

		const bounds = segmentsBounds(segments);
		const anchors = paths.flatMap((path) =>
			path.segments.map((segment) => segment.end),
		);
		for (const anchor of anchors) {
			expect(anchor.x).toBeGreaterThanOrEqual(bounds.minX - 0.01);
			expect(anchor.x).toBeLessThanOrEqual(bounds.maxX + 0.01);
			expect(anchor.y).toBeGreaterThanOrEqual(bounds.minY - 0.01);
			expect(anchor.y).toBeLessThanOrEqual(bounds.maxY + 0.01);
		}
	});

	it("skips missing sources and computes from available sources only", () => {
		const pathA = createCirclePath("a", 0, 0, 100);
		const pathB = createCirclePath("b", 80, 0, 100);
		const pathMap = new Map<string, Path>([
			[pathA.id, pathA],
			[pathB.id, pathB],
		]);

		const withoutMissing = computeBooleanOperation(
			[
				{ id: pathA.id, op: "union" },
				{ id: pathB.id, op: "union" },
			],
			pathMap,
		);
		const withMissing = computeBooleanOperation(
			[
				{ id: pathA.id, op: "union" },
				{ id: "missing", op: "subtract" },
				{ id: pathB.id, op: "union" },
			],
			pathMap,
		);

		expect(withMissing.length).toBe(withoutMissing.length);
	});

	it("reflects source transform when caller passes world-space paths", () => {
		const pathA = createCirclePath("a", 0, 0, 80);
		const pathB = {
			...createCirclePath("b", 0, 0, 80),
			transform: {
				x: 220,
				y: 0,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
			},
		};
		const sources: CompoundPathSource[] = [
			{ id: pathA.id, op: "union" },
			{ id: pathB.id, op: "union" },
		];

		const rawResult = computeBooleanOperation(
			sources,
			new Map<string, Path>([
				[pathA.id, pathA],
				[pathB.id, pathB],
			]),
		);
		const worldResult = computeBooleanOperation(
			sources,
			new Map<string, Path>([
				[pathA.id, toWorldPath(pathA)],
				[pathB.id, toWorldPath(pathB)],
			]),
		);

		const localBounds = segmentsBounds(rawResult);
		const worldBounds = segmentsBounds(worldResult);

		expect(worldResult.length).toBeGreaterThan(rawResult.length);
		expect(worldBounds.width - localBounds.width).toBeGreaterThanOrEqual(
			pathB.transform.x - 10,
		);
	});

	it.each([
		{
			name: "cross again at a small angle after a shared crossing",
			a: createArchPath("a", { x: 100, y: 200 }, { x: 300, y: 0 }, 400, 0),
			b: createArchPath("b", { x: 106, y: 208 }, { x: 294, y: 8 }, 400, 0),
		},
		{
			name: "leave a shared point along the same tangent",
			a: createArchPath("a", { x: 100, y: 100 }, { x: 300, y: 100 }, 400, 100),
			b: createArchPath("b", { x: 120, y: 120 }, { x: 230, y: 90 }, 380, 60),
		},
		{
			name: "trace the same curve from a shared point",
			a: createArchPath("a", { x: 100, y: 200 }, { x: 300, y: 200 }, 400, 0),
			b: createArchPath("b", { x: 30, y: 60 }, { x: 69, y: 102 }, 111.6, 126),
		},
	])("keeps the union outline when two sources $name", ({ a, b }) => {
		const segments = computeBooleanOperation(
			[
				{ id: a.id, op: "union" },
				{ id: b.id, op: "union" },
			],
			new Map<string, Path>([
				[a.id, a],
				[b.id, b],
			]),
		);

		const highest = (s: CubicBezierSegment[]) =>
			Math.max(...sampleSegments(s).map((p) => p.y));
		expect(highest(segments)).toBeCloseTo(
			Math.max(highest(a.segments), highest(b.segments)),
			1,
		);
	});

	it("keeps a region the source outline winds around twice filled", () => {
		const corners = [0, 2, 4, 1, 3].map((k) => ({
			x: 100 * Math.sin((k * 2 * Math.PI) / 5),
			y: 100 * Math.cos((k * 2 * Math.PI) / 5),
		}));
		const star: Path = {
			...createCirclePath("star", 0, 0, 1),
			segments: corners.map((corner, i) => {
				const next = corners[(i + 1) % corners.length];
				return makeSegment(corner, corner, next, next, i === 0);
			}),
		};
		const square: Path = {
			...createFilledRect(300, 0, 20, 20),
			id: "square",
		};
		const center = { x: 0, y: 1 };
		expect(windingAt(star.segments, center)).not.toBe(0);

		const segments = computeBooleanOperation(
			[
				{ id: star.id, op: "union" },
				{ id: square.id, op: "union" },
			],
			new Map<string, Path>([
				[star.id, star],
				[square.id, square],
			]),
		);

		expect(windingAt(segments, center)).not.toBe(0);
	});
});

describe("triangleSoupOutline", () => {
	it("should merge overlapping triangles of mixed winding into one closed subpath", () => {
		// A 10×10 square split along its diagonal, one triangle wound each way,
		// plus a copy overlapping the first.
		const outline = triangleSoupOutline(
			[0, 0, 10, 0, 10, 10, 0, 0, 0, 10, 10, 10, 0, 0, 10, 10, 10, 0],
			0.1,
		);

		expect(outline.filter((seg) => seg.isMoved)).toHaveLength(1);
		expect(outline.at(-1)?.isClosed).toBe(true);
		const ends = outline.map((seg) => [seg.end.x, seg.end.y]);
		for (const corner of [
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
		]) {
			expect(ends).toContainEqual(corner);
		}
	});

	it("should keep an enclosed gap as a hole subpath", () => {
		const outline = triangleSoupOutline(
			[
				...rectTriangles(0, 0, 20, 5),
				...rectTriangles(0, 15, 20, 20),
				...rectTriangles(0, 0, 5, 20),
				...rectTriangles(15, 0, 20, 20),
			],
			0.1,
		);

		expect(outline.filter((seg) => seg.isMoved)).toHaveLength(2);
	});

	it("should fit a finely tessellated smooth outline with a few curves", () => {
		// A disk of radius 50 as a 128-triangle fan, like a round cap.
		const steps = 128;
		const fan: number[] = [];
		for (let i = 0; i < steps; i++) {
			const a0 = (i / steps) * Math.PI * 2;
			const a1 = ((i + 1) / steps) * Math.PI * 2;
			fan.push(
				0,
				0,
				50 * Math.cos(a0),
				50 * Math.sin(a0),
				50 * Math.cos(a1),
				50 * Math.sin(a1),
			);
		}
		const outline = triangleSoupOutline(fan, 0.1);

		expect(outline.length).toBeLessThan(steps / 8);
		for (const [i, seg] of outline.entries()) {
			const { start, cp1, cp2, end } = resolveSegment(seg, outline[i - 1]?.end);
			for (const t of [0, 0.5, 1]) {
				const p = evalCubicBezier(start, cp1, cp2, end, t);
				expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 0);
			}
		}
	});

	it("should return nothing when every triangle is degenerate", () => {
		expect(triangleSoupOutline([0, 0, 1, 1, 2, 2], 0.1)).toEqual([]);
	});

	it("should outline a strip of sliver quads as one subpath of few curves", () => {
		// A 12-wide band of 400 quads along a sine wave, the way a stroke body
		// tessellates: long, thin triangles sharing their vertices exactly.
		const quads = 400;
		const strip: number[] = [];
		const edge = (i: number, side: number) => {
			const x = i * 2;
			const y = Math.sin(x / 40) * 30;
			const slope = Math.cos(x / 40) * 0.75;
			const len = Math.hypot(1, slope);
			return [x - (slope / len) * 6 * side, y + (1 / len) * 6 * side];
		};
		for (let i = 0; i < quads; i++) {
			const [lx0, ly0] = edge(i, 1);
			const [rx0, ry0] = edge(i, -1);
			const [lx1, ly1] = edge(i + 1, 1);
			const [rx1, ry1] = edge(i + 1, -1);
			strip.push(lx0, ly0, rx0, ry0, lx1, ly1, rx0, ry0, rx1, ry1, lx1, ly1);
		}

		const outline = triangleSoupOutline(strip, 0.1);

		expect(outline.filter((seg) => seg.isMoved)).toHaveLength(1);
		expect(outline.length).toBeLessThan(quads / 4);
	});
});

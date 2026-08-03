import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../document/factory";
import type {
	BezierPoint,
	CompoundPathSource,
	CubicBezierSegment,
	FillAppearance,
	Path,
	StrokeAppearance,
} from "../../schema";
import {
	computeBooleanOperation,
	evalBezier,
	splitPathAtAnchor,
	splitPathByEraser,
	splitPathByNormalizedRanges,
	subtractEraserFromFilledPath,
} from "./pathOps";
import { resolveSegment, toWorldPath } from "./segmentOps";

// ============================================================================
// computeBooleanOperation
// ============================================================================

const BLACK = { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 };
const RED_FILL = {
	type: "solid" as const,
	color: BLACK,
};

const KAPPA = 0.552284749831;

describe("computeBooleanOperation", () => {
	it("increases edge detail for curved union when curveTolerance is smaller", () => {
		const pathA = createCirclePath("a", 0, 0, 100);
		const pathB = createCirclePath("b", 80, 0, 100);
		const pathMap = new Map<string, Path>([
			[pathA.id, pathA],
			[pathB.id, pathB],
		]);
		const sources: CompoundPathSource[] = [
			{ id: pathA.id, op: "union" },
			{ id: pathB.id, op: "union" },
		];

		const coarse = computeBooleanOperation(sources, pathMap, {
			curveTolerance: 2.0,
			maxFlattenDepth: 8,
		});
		const fine = computeBooleanOperation(sources, pathMap, {
			curveTolerance: 0.1,
			maxFlattenDepth: 12,
		});

		expect(fine.length).toBeGreaterThan(coarse.length);
		expect(maxEdgeLength(fine)).toBeLessThan(maxEdgeLength(coarse));
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
});

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

function maxEdgeLength(segments: CubicBezierSegment[]): number {
	let prevEnd: BezierPoint | undefined;
	let maxLen = 0;
	for (const seg of segments) {
		const { start, end } = resolveSegment(seg, prevEnd);
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const len = Math.hypot(dx, dy);
		if (len > maxLen) maxLen = len;
		prevEnd = seg.end;
	}
	return maxLen;
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
// splitPathByEraser
// ============================================================================

/** Straight-line path: world(0,0) → world(100,0) */
function straightPath(overrides?: Partial<Path>): Path {
	return {
		id: "p1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [
			{
				processor: "stroke",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
						},
						brushSettings: { type: "line", size: 2, opacity: 1 },
					},
				},
			} as unknown as StrokeAppearance,
		],
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
		],
		...overrides,
	};
}

/** Two-segment path: world(0,0) → world(100,0) → world(200,0) */
function twoSegmentPath(): Path {
	return {
		id: "p2",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [
			{
				processor: "stroke",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
						},
						brushSettings: { type: "line", size: 2, opacity: 1 },
					},
				},
			} as unknown as StrokeAppearance,
		],
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
			{
				// start is implicitly prev.end = (100, 0)
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 200, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
		],
	};
}

/** Three-segment path: (0,0) → (100,0) → (200,0) → (300,0) */
function threeSegmentPath(): Path {
	return {
		id: "p3",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
			{
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 200, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
			{
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 300, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
		],
	};
}

/** Square filled path: (0,0) → (100,0) → (100,100) → (0,100) → closed */
function squarePath(): Path {
	return {
		id: "pf",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [
			{
				processor: "fill",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
						},
					},
				},
			} as FillAppearance,
		],
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
			{
				cp1: { x: 0, y: 33 },
				cp2: { x: 0, y: -33 },
				end: { x: 100, y: 100 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
			{
				cp1: { x: -33, y: 0 },
				cp2: { x: 33, y: 0 },
				end: { x: 0, y: 100 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
			{
				cp1: { x: 0, y: -33 },
				cp2: { x: 0, y: 33 },
				end: { x: 0, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
				isClosed: true,
			},
		],
	};
}

/** Get start and end X coordinates of a path */
function getPathExtents(path: Path): { startX: number; endX: number } {
	const firstSeg = path.segments[0];
	const lastSeg = path.segments[path.segments.length - 1];
	const prevEnd =
		path.segments.length > 1
			? path.segments[path.segments.length - 2].end
			: undefined;

	const resolvedFirst = resolveSegment(firstSeg);
	const resolvedLast = resolveSegment(lastSeg, prevEnd);

	return {
		startX: resolvedFirst.start.x,
		endX: resolvedLast.end.x,
	};
}

/** Verify all segment start/end Y coordinates are approximately 0 */
function expectPathOnXAxis(path: Path) {
	for (let i = 0; i < path.segments.length; i++) {
		const prevEnd = i > 0 ? path.segments[i - 1].end : undefined;
		const resolved = resolveSegment(path.segments[i], prevEnd);
		expect(Math.abs(resolved.start.y)).toBeLessThan(1);
		expect(Math.abs(resolved.end.y)).toBeLessThan(1);
	}
}

describe("splitPathByEraser", () => {
	it("空の消しゴムストロークを受け取った場合、元のパス参照をそのまま返す", () => {
		const path = straightPath();
		const result = splitPathByEraser(path, [], 20);

		expect(result).toHaveLength(1);
		expect(result[0]).toBe(path);
	});

	it("パスから遠い位置の消しゴムストロークでは元パスと同じ座標範囲のパスが1本返る", () => {
		const path = straightPath();
		// パスはy=0上。消しゴムはy=500上でradius=20なので到達しない
		const eraserStroke = [
			{ x: 0, y: 500 },
			{ x: 100, y: 500 },
		];
		const result = splitPathByEraser(path, eraserStroke, 20);

		expect(result).toHaveLength(1);
		const ext = getPathExtents(result[0]);
		expect(ext.startX).toBeCloseTo(0, 0);
		expect(ext.endX).toBeCloseTo(100, 0);
	});

	it("パスの中央を垂直に横切る消しゴムで2本に分割され、前半は0〜40付近、後半は60〜100付近になる", () => {
		const path = straightPath();
		// 消しゴムはx=50で垂直に横切る。radius=10なので約x=40〜60が消える
		const eraserStroke = [
			{ x: 50, y: -30 },
			{ x: 50, y: 30 },
		];
		const result = splitPathByEraser(path, eraserStroke, 10);

		expect(result).toHaveLength(2);

		const [first, second] = result;
		const extFirst = getPathExtents(first);
		const extSecond = getPathExtents(second);

		// 前半: 0付近から始まり、40付近で終わる
		expect(extFirst.startX).toBeCloseTo(0, -1);
		expect(extFirst.endX).toBeLessThan(50);
		expect(extFirst.endX).toBeGreaterThan(20);

		// 後半: 60付近から始まり、100付近で終わる
		expect(extSecond.startX).toBeGreaterThan(50);
		expect(extSecond.startX).toBeLessThan(80);
		expect(extSecond.endX).toBeCloseTo(100, -1);

		// 両方ともy≈0の直線上にあること
		expectPathOnXAxis(first);
		expectPathOnXAxis(second);

		// 各分割パスの先頭セグメントはstart座標とisMoved=trueを持つ
		for (const p of result) {
			expect(p.segments.length).toBeGreaterThan(0);
			expect(p.segments[0].start).toBeDefined();
			expect(p.segments[0].isMoved).toBe(true);
		}
	});

	it("パスの始端(x=0付近)を消すと、後半部分のみ返り、そのstartX > 0である", () => {
		const path = straightPath();
		// x=0をradius=25で消す → x=0〜25付近が消える
		const eraserStroke = [{ x: 0, y: 0 }];
		const result = splitPathByEraser(path, eraserStroke, 25);

		expect(result).toHaveLength(1);

		const ext = getPathExtents(result[0]);
		// 始端が消えたので、残ったパスのstartXは25付近より大きい
		expect(ext.startX).toBeGreaterThan(10);
		// 終端は元のまま
		expect(ext.endX).toBeCloseTo(100, -1);
	});

	it("パスの終端(x=100付近)を消すと、前半部分のみ返り、そのendX < 100である", () => {
		const path = straightPath();
		// x=100をradius=25で消す → x=75〜100付近が消える
		const eraserStroke = [{ x: 100, y: 0 }];
		const result = splitPathByEraser(path, eraserStroke, 25);

		expect(result).toHaveLength(1);

		const ext = getPathExtents(result[0]);
		// 始端は元のまま
		expect(ext.startX).toBeCloseTo(0, -1);
		// 終端が消えたので、残ったパスのendXは90付近より小さい
		expect(ext.endX).toBeLessThan(90);
	});

	it("パス全体を覆う消しゴムストロークでは空配列が返る", () => {
		const path = straightPath();
		const eraserStroke = [
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 100, y: 0 },
		];
		const result = splitPathByEraser(path, eraserStroke, 60);

		expect(result).toHaveLength(0);
	});

	it("単一ポイント消しゴム(x=50,radius=15)でパスが2本に分割され、消去箇所を挟んで前後に分かれる", () => {
		const path = straightPath();
		const eraserStroke = [{ x: 50, y: 0 }];
		const result = splitPathByEraser(path, eraserStroke, 15);

		expect(result).toHaveLength(2);

		const [first, second] = result;
		const extFirst = getPathExtents(first);
		const extSecond = getPathExtents(second);

		// 前半のendX < 50、後半のstartX > 50
		expect(extFirst.endX).toBeLessThan(50);
		expect(extSecond.startX).toBeGreaterThan(50);
	});

	it("2セグメントパスの1セグメント目中央(x=50)を消すと、x<50の断片とx>50〜200の断片に分かれる", () => {
		const path = twoSegmentPath();
		const eraserStroke = [
			{ x: 50, y: -20 },
			{ x: 50, y: 20 },
		];
		const result = splitPathByEraser(path, eraserStroke, 10);

		expect(result.length).toBeGreaterThanOrEqual(2);

		// 結果をstartXでソート
		const sorted = [...result].sort(
			(a, b) => getPathExtents(a).startX - getPathExtents(b).startX,
		);

		const extFirst = getPathExtents(sorted[0]);
		const extLast = getPathExtents(sorted[sorted.length - 1]);

		// 最初の断片は0付近から始まり50未満で終わる
		expect(extFirst.startX).toBeCloseTo(0, -1);
		expect(extFirst.endX).toBeLessThan(50);

		// 最後の断片は200付近で終わる（2セグメント目の終端）
		expect(extLast.endX).toBeCloseTo(200, -1);
	});

	it("分割結果のパスはfilters(strokeColor・brushSettings)を元パスから引き継ぐ", () => {
		const path = straightPath({
			filters: [
				{
					processor: "stroke",
					paramData: {
						version: "1",
						params: {
							strokeColor: {
								type: "solid",
								color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
							},
							brushSettings: {
								textureFileUid: "builtin-brush-pencil",
								size: 10,
								sizeByPressure: 0.3,
								opacity: 0.8,
								opacityByPressure: 0.5,
								spacing: 0.08,
								flow: 0.8,
								stampRotation: "none",
								randomSeed: 42,
							},
						},
					},
				} as unknown as StrokeAppearance,
			],
		});
		const eraserStroke = [
			{ x: 50, y: -20 },
			{ x: 50, y: 20 },
		];
		const result = splitPathByEraser(path, eraserStroke, 10);

		expect(result.length).toBeGreaterThanOrEqual(2);
		for (const p of result) {
			expect(p.filters).toEqual(path.filters);
		}
	});
});

// ============================================================================
// splitPathByEraser — pathStart/pathEnd
// ============================================================================

describe("splitPathByEraser — pathStart/pathEnd", () => {
	it("erasing middle sets fragment1.pathEnd < 1 and fragment2.pathStart > 0", () => {
		const path = straightPath();
		const eraserStroke = [
			{ x: 50, y: -30 },
			{ x: 50, y: 30 },
		];
		const result = splitPathByEraser(path, eraserStroke, 10);

		expect(result).toHaveLength(2);
		const [frag1, frag2] = result;

		expect(frag1.pathEnd).toBeDefined();
		expect(frag1.pathEnd!).toBeGreaterThan(0);
		expect(frag1.pathEnd!).toBeLessThan(1);

		expect(frag2.pathStart).toBeDefined();
		expect(frag2.pathStart!).toBeGreaterThan(0);
		expect(frag2.pathStart!).toBeLessThan(1);
	});

	it("erasing head sets remaining path's pathStart > 0", () => {
		const path = straightPath();
		const eraserStroke = [{ x: 0, y: 0 }];
		const result = splitPathByEraser(path, eraserStroke, 25);

		expect(result).toHaveLength(1);
		expect(result[0].pathStart).toBeDefined();
		expect(result[0].pathStart!).toBeGreaterThan(0);
	});

	it("erasing tail sets remaining path's pathEnd < 1", () => {
		const path = straightPath();
		const eraserStroke = [{ x: 100, y: 0 }];
		const result = splitPathByEraser(path, eraserStroke, 25);

		expect(result).toHaveLength(1);
		expect(result[0].pathEnd).toBeDefined();
		expect(result[0].pathEnd!).toBeLessThan(1);
	});

	it("no erasure leaves pathStart/pathEnd undefined", () => {
		const path = straightPath();
		const eraserStroke = [
			{ x: 0, y: 500 },
			{ x: 100, y: 500 },
		];
		const result = splitPathByEraser(path, eraserStroke, 20);

		expect(result).toHaveLength(1);
		expect(result[0].pathStart).toBeUndefined();
		expect(result[0].pathEnd).toBeUndefined();
	});

	it("fragment1.pathEnd < fragment2.pathStart (erased gap between fragments)", () => {
		const path = straightPath();
		const eraserStroke = [
			{ x: 50, y: -30 },
			{ x: 50, y: 30 },
		];
		const result = splitPathByEraser(path, eraserStroke, 10);

		expect(result).toHaveLength(2);
		const [frag1, frag2] = result;

		expect(frag1.pathEnd).toBeDefined();
		expect(frag2.pathStart).toBeDefined();
		expect(frag1.pathEnd!).toBeLessThan(frag2.pathStart!);
	});

	it("composes fragment ranges when splitting an existing fragment", () => {
		const eraserStroke = [
			{ x: 50, y: -30 },
			{ x: 50, y: 30 },
		];
		const localResult = splitPathByEraser(straightPath(), eraserStroke, 10);
		const result = splitPathByEraser(
			{ ...straightPath(), pathStart: 0.2, pathEnd: 0.8 },
			eraserStroke,
			10,
		);

		expect(result).toHaveLength(2);
		expect(result[0].pathStart).toBeCloseTo(0.2);
		expect(result[0].pathEnd).toBeCloseTo(
			0.2 + (localResult[0].pathEnd ?? 1) * 0.6,
		);
		expect(result[1].pathStart).toBeCloseTo(
			0.2 + (localResult[1].pathStart ?? 0) * 0.6,
		);
		expect(result[1].pathEnd).toBeCloseTo(0.8);
	});

	it("uses arc-length positions for curved fragment ranges", () => {
		const path = straightPath();
		path.segments = [
			{
				...path.segments[0],
				cp1: { x: 160, y: 180 },
				cp2: { x: -80, y: 60 },
			},
		];
		const resolved = resolveSegment(path.segments[0]);
		const eraserPoint = evalBezier(
			resolved.start,
			resolved.cp1,
			resolved.cp2,
			resolved.end,
			0.55,
		);
		const result = splitPathByEraser(path, [eraserPoint], 3);

		expect(result).toHaveLength(2);
		const firstEnd = result[0].segments.at(-1)!.end;
		const secondStart = result[1].segments[0].start!;
		expect(result[0].pathEnd).toBeCloseTo(
			approximateArcFractionAtPoint(path.segments[0], firstEnd),
			2,
		);
		expect(result[1].pathStart).toBeCloseTo(
			approximateArcFractionAtPoint(path.segments[0], secondStart),
			2,
		);
	});
});

// ============================================================================
// splitPathByEraser — pressure preservation
// ============================================================================

describe("splitPathByEraser — pressure preservation", () => {
	it("split fragments retain interpolated startPressure/endPressure", () => {
		const path = pressurePath();
		// Erase near the middle
		const eraserStroke = [
			{ x: 50, y: -30 },
			{ x: 50, y: 30 },
		];
		const result = splitPathByEraser(path, eraserStroke, 10);

		expect(result).toHaveLength(2);
		const [frag1, frag2] = result;

		// Fragment 1: starts at ~0.2, ends somewhere below 0.5
		const seg1 = frag1.segments[0];
		expect(seg1.startPressure).toBeCloseTo(0.2, 1);
		expect(seg1.endPressure).toBeDefined();
		expect(seg1.endPressure!).toBeLessThan(0.6);
		expect(seg1.endPressure!).toBeGreaterThan(0.2);

		// Fragment 2: starts somewhere above 0.4, ends at ~0.8
		const seg2 = frag2.segments[0];
		expect(seg2.startPressure).toBeDefined();
		expect(seg2.startPressure!).toBeGreaterThan(0.4);
		expect(seg2.endPressure).toBeCloseTo(0.8, 1);
	});

	it("unsplit path retains original pressure unchanged", () => {
		const path = pressurePath();
		// Miss the path entirely
		const eraserStroke = [{ x: 0, y: 500 }];
		const result = splitPathByEraser(path, eraserStroke, 20);

		expect(result).toHaveLength(1);
		const seg = result[0].segments[0];
		expect(seg.startPressure).toBe(0.2);
		expect(seg.endPressure).toBe(0.8);
	});

	/** Straight path with pressure ramp from 0.2 to 0.8. */
	function pressurePath(): Path {
		return straightPath({
			segments: [
				{
					start: { x: 0, y: 0 },
					cp1: { x: 33, y: 0 },
					cp2: { x: -33, y: 0 },
					end: { x: 100, y: 0 },
					isMoved: true,
					startPressure: 0.2,
					endPressure: 0.8,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
				},
			],
		});
	}
});

describe("splitPathByNormalizedRanges", () => {
	it("should preserve subpath boundaries and closure only for untouched subpaths", () => {
		const path: Path = {
			id: "multiple-subpaths",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			segments: [
				{
					start: { x: 0, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 100, y: 0 },
					isMoved: true,
					isClosed: true,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
				},
				{
					start: { x: 300, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 400, y: 0 },
					isMoved: true,
					isClosed: true,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
				},
			],
		};

		const result = splitPathByNormalizedRanges(path, [
			{ start: 0.2, end: 0.3 },
		]);

		expect(result).toHaveLength(2);
		expect(result[0].segments[0].isClosed).toBeUndefined();
		expect(result[1].segments).toHaveLength(2);
		expect(result[1].segments[0].isClosed).toBeUndefined();
		expect(result[1].segments[1]).toMatchObject({
			start: { x: 300, y: 0 },
			isMoved: true,
			isClosed: true,
		});
	});
});

// ============================================================================
// subtractEraserFromFilledPath
// ============================================================================

describe("subtractEraserFromFilledPath", () => {
	it("空の消しゴムストロークでは元パス参照をそのまま返す", () => {
		const path = squarePath();
		const result = subtractEraserFromFilledPath(path, [], 20);

		expect(result).toHaveLength(1);
		expect(result[0]).toBe(path);
	});

	it("塗りパスから遠い位置の消しゴムでは結果のセグメント総数が元パスと同等になる", () => {
		const path = squarePath();
		// パスは(0,0)-(100,100)の四角。消しゴムは(500,500)で遠い
		const eraserStroke = [{ x: 500, y: 500 }];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 20);

		expect(result).toHaveLength(1);
		// polygon-clippingを通るのでセグメント数は厳密一致しないが、
		// 元の4辺に対応する頂点が保持されているはず
		expect(result[0].segments.length).toBeGreaterThanOrEqual(3);
	});

	it("塗りパスの中央を左右に貫通する消しゴムで上下2つに分割され、各断片のセグメントが3以上ある", () => {
		const path = squarePath();
		// 四角の中央(y=50)を左から右に横切る
		const eraserStroke = [
			{ x: -20, y: 50 },
			{ x: 120, y: 50 },
		];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 15);

		expect(result.length).toBeGreaterThanOrEqual(2);

		// 各断片は閉じたポリゴンなので最低3セグメント
		for (const p of result) {
			expect(p.segments.length).toBeGreaterThanOrEqual(3);
			expect(p.type).toBe("path");
		}
	});

	it("塗りパス全体を覆う消しゴムでは空配列が返る", () => {
		const path = squarePath();
		const eraserStroke = [
			{ x: 50, y: -50 },
			{ x: 50, y: 150 },
		];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 200);

		expect(result).toHaveLength(0);
	});

	it("分割結果のパスはfilters(fill)・opacity・blendModeを元パスから引き継ぐ", () => {
		const path = squarePath();
		const eraserStroke = [
			{ x: -20, y: 50 },
			{ x: 120, y: 50 },
		];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 15);

		expect(result).toHaveLength(2);
		for (const p of result) {
			expect(p.filters).toEqual(path.filters);
			expect(p.opacity).toBe(path.opacity);
			expect(p.blendMode).toBe(path.blendMode);
		}
	});

	it("単一ポイント消しゴム(中央,radius=20)で塗りパスの面積が減少する", () => {
		const path = squarePath();
		const eraserStroke = [{ x: 50, y: 50 }];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 20);

		// 穴が開くのでパスは返るが、セグメント総数が元(4)より増える（穴の輪郭分）
		const totalSegments = result.reduce((sum, p) => sum + p.segments.length, 0);
		expect(totalSegments).toBeGreaterThan(path.segments.length);
	});

	it("自己交差パスの片方だけ消しゴムを当てると、消してない方のローブが残る", () => {
		// Figure-8 (8の字): 左ローブ(中心 -50,0) + 右ローブ(中心 50,0) が (0,0) で交差
		const path = figure8Path();
		// 右ローブ(50,0)付近だけ消しゴムを当てる
		const eraserStroke = [
			{ x: 40, y: 0 },
			{ x: 60, y: 0 },
		];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 60);

		// 左ローブが少なくとも1パスとして残るはず
		expect(result.length).toBeGreaterThanOrEqual(1);

		// 残ったパスの中に、左ローブの領域 (x < 0) にセグメントを持つものがある
		const hasLeftLobe = result.some((p) =>
			p.segments.some((s) => {
				const resolved = resolveSegment(s, undefined);
				if (!resolved.start) return false;
				return resolved.start.x < -10 || resolved.end.x < -10;
			}),
		);
		expect(hasLeftLobe).toBe(true);
	});

	it("horizontal cut through square produces 2 closed paths within original bounds", () => {
		const path = squarePath();
		const eraserStroke = [
			{ x: -20, y: 50 },
			{ x: 120, y: 50 },
		];
		const eraserRadius = 15;
		const result = subtractEraserFromFilledPath(
			path,
			eraserStroke,
			eraserRadius,
		);

		// Exactly 2 paths: top half and bottom half
		expect(result).toHaveLength(2);

		// Both paths must be closed
		for (const p of result) {
			const last = p.segments[p.segments.length - 1];
			expect(last.isClosed).toBe(true);
		}

		// Resolve all endpoints and verify they stay within original path bounds + tolerance
		const TOLERANCE = 1;
		for (const p of result) {
			for (const seg of p.segments) {
				expect(seg.end.x).toBeGreaterThanOrEqual(-TOLERANCE);
				expect(seg.end.x).toBeLessThanOrEqual(100 + TOLERANCE);
				expect(seg.end.y).toBeGreaterThanOrEqual(-TOLERANCE);
				expect(seg.end.y).toBeLessThanOrEqual(100 + TOLERANCE);
				if (seg.start) {
					expect(seg.start.x).toBeGreaterThanOrEqual(-TOLERANCE);
					expect(seg.start.x).toBeLessThanOrEqual(100 + TOLERANCE);
					expect(seg.start.y).toBeGreaterThanOrEqual(-TOLERANCE);
					expect(seg.start.y).toBeLessThanOrEqual(100 + TOLERANCE);
				}
			}
		}

		// The split boundary should be at y ≈ 35 (50 - 15) and y ≈ 65 (50 + 15)
		const splitY = 50 - eraserRadius; // 35
		const splitYBottom = 50 + eraserRadius; // 65
		const SPLIT_TOL = 1;

		// One path covers the top region (y from 0 to ~35)
		// Another covers the bottom region (y from ~65 to 100)
		const pathsByMinY = result.toSorted((a, b) => {
			const minYA = Math.min(...a.segments.map((s) => s.end.y));
			const minYB = Math.min(...b.segments.map((s) => s.end.y));
			return minYA - minYB;
		});

		const topPath = pathsByMinY[0];
		const bottomPath = pathsByMinY[1];

		// Top path endpoints should all be below y ≈ 35 + tolerance
		for (const seg of topPath.segments) {
			expect(seg.end.y).toBeLessThanOrEqual(splitY + SPLIT_TOL);
		}

		// Bottom path endpoints should all be above y ≈ 65 - tolerance
		for (const seg of bottomPath.segments) {
			expect(seg.end.y).toBeGreaterThanOrEqual(splitYBottom - SPLIT_TOL);
		}
	});

	it("should restore cornerRadius on untouched corners after polygon boolean", () => {
		// Rectangle with cornerRadius on segment 2
		const path = createFilledRect(-100, -50, 200, 100);
		path.segments[2].cornerRadius = 5;
		path.segments[2].cornerSuperellipseN = 3;

		// Eraser touches only the right edge (segment 1): a vertical stroke at x=100
		const eraserStroke = [
			{ x: 100, y: -60 },
			{ x: 100, y: 60 },
		];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 15);

		expect(result.length).toBeGreaterThanOrEqual(1);

		const allSegments = result.flatMap((p) => p.segments);

		// The corner at segment 2's end (-100, 50) should have cornerRadius restored
		const cornerEnd = path.segments[2].end; // (-100, 50)
		const match = allSegments.find(
			(s) =>
				Math.abs(s.end.x - cornerEnd.x) < 2 &&
				Math.abs(s.end.y - cornerEnd.y) < 2,
		);
		expect(match).toBeDefined();
		expect((match as { cornerRadius?: number })?.cornerRadius).toBe(5);
		expect(
			(match as { cornerSuperellipseN?: number })?.cornerSuperellipseN,
		).toBe(3);
	});

	it("should handle self-intersecting paths: self-union splits lobes, eraser removes from one lobe", () => {
		const path = figure8Path();

		// Large eraser covering the entire right lobe (center=50,0, radius=60)
		const eraserStroke = [
			{ x: 40, y: 0 },
			{ x: 60, y: 0 },
		];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 60);

		// Self-union resolves the 8-shape into two lobes. Eraser covers the right lobe.
		// Left lobe must survive.
		expect(result.length).toBeGreaterThanOrEqual(1);

		const allSegments = result.flatMap((p) => p.segments);

		// Left lobe must survive: segments with endpoints in the left region
		const hasLeftLobe = allSegments.some((s) => s.end.x < -10);
		expect(hasLeftLobe).toBe(true);

		// No segments should be far in the right lobe (eraser removed it)
		const rightLobeOnly = allSegments.filter((s) => s.end.x > 30);
		expect(rightLobeOnly.length).toBe(0);
	});

	it("should create a hole contour when eraser is completely inside the fill", () => {
		// Large rectangle covering -200,-200 to 200,200
		const path = createFilledRect(-200, -200, 400, 400);
		const eraserRadius = 30;

		// Eraser completely inside the rectangle (single point at center, radius 30)
		const eraserStroke = [{ x: 0, y: 0 }];
		const result = subtractEraserFromFilledPath(
			path,
			eraserStroke,
			eraserRadius,
		);

		// Ring concatenation: both outer and hole rings become one Path with 2 subpaths
		expect(result).toHaveLength(1);

		const segs = result[0].segments;

		// Outer contour corners should be present (approximately, after polygon round-trip)
		const outerCorners = [
			{ x: 200, y: -200 },
			{ x: 200, y: 200 },
			{ x: -200, y: 200 },
			{ x: -200, y: -200 },
		];
		for (const corner of outerCorners) {
			const match = segs.find(
				(s) =>
					Math.abs(s.end.x - corner.x) < 2 && Math.abs(s.end.y - corner.y) < 2,
			);
			expect(match).toBeDefined();
		}

		// Two subpaths: outer + hole (each has isMoved start and isClosed end)
		const movedSegments = segs.filter((s) => s.isMoved === true);
		expect(movedSegments).toHaveLength(2);

		const closedSegments = segs.filter((s) => s.isClosed === true);
		expect(closedSegments).toHaveLength(2);

		// Hole contour endpoints should be approximately on a circle of eraserRadius around (0,0)
		// Find where the second subpath starts
		let holeStartIdx = -1;
		let foundFirst = false;
		for (let i = 0; i < segs.length; i++) {
			if (segs[i].isMoved) {
				if (foundFirst) {
					holeStartIdx = i;
					break;
				}
				foundFirst = true;
			}
		}
		expect(holeStartIdx).toBeGreaterThan(0);

		const holeSegs = segs.slice(holeStartIdx);
		expect(holeSegs.length).toBeGreaterThanOrEqual(2);
		for (const hs of holeSegs) {
			const dist = Math.hypot(hs.end.x, hs.end.y);
			expect(dist).toBeGreaterThanOrEqual(eraserRadius - 5);
			expect(dist).toBeLessThanOrEqual(eraserRadius + 5);
		}
	});

	it("should return empty array when entire path is erased", () => {
		// Small rectangle 20x20
		const path = createFilledRect(-10, -10, 20, 20);

		// Large eraser covering the entire path
		const eraserStroke = [
			{ x: -20, y: 0 },
			{ x: 20, y: 0 },
		];
		const result = subtractEraserFromFilledPath(path, eraserStroke, 50);

		expect(result).toEqual([]);
	});
});

// ============================================================================
// splitPathAtAnchor
// ============================================================================

describe("splitPathAtAnchor", () => {
	it("単一セグメントパスでは先頭(start)も末尾(end)も分割できずnullが返る", () => {
		const path = straightPath();

		expect(splitPathAtAnchor(path, 0, "start")).toBeNull();
		expect(splitPathAtAnchor(path, 0, "end")).toBeNull();
	});

	it("2セグメントパスの中間アンカーで分割すると、各1セグメントのパスが2本返る", () => {
		const path = twoSegmentPath();

		const result = splitPathAtAnchor(path, 0, "end");
		expect(result).not.toBeNull();
		const [first, second] = result!;

		expect(first.segments).toHaveLength(1);
		expect(second.segments).toHaveLength(1);
	});

	it("segment[0].endとsegment[1].startは同じ分割位置を指し、結果のセグメント構成が一致する", () => {
		const path = twoSegmentPath();

		const resultA = splitPathAtAnchor(path, 0, "end");
		const resultB = splitPathAtAnchor(path, 1, "start");

		expect(resultA).not.toBeNull();
		expect(resultB).not.toBeNull();

		expect(resultA?.[0].segments).toHaveLength(resultB![0].segments.length);
		expect(resultA?.[1].segments).toHaveLength(resultB![1].segments.length);
	});

	it("3セグメントパスのsegment[0].endで分割: 1セグメント + 2セグメント", () => {
		const path = threeSegmentPath();
		const result = splitPathAtAnchor(path, 0, "end");

		expect(result).not.toBeNull();
		const [first, second] = result!;

		expect(first.segments).toHaveLength(1);
		expect(second.segments).toHaveLength(2);
	});

	it("3セグメントパスのsegment[1].endで分割: 2セグメント + 1セグメント", () => {
		const path = threeSegmentPath();
		const result = splitPathAtAnchor(path, 1, "end");

		expect(result).not.toBeNull();
		const [first, second] = result!;

		expect(first.segments).toHaveLength(2);
		expect(second.segments).toHaveLength(1);
	});

	it("分割後の2番目のパスのstart座標が、1番目のパスの末尾end座標と一致する", () => {
		const path = twoSegmentPath();
		const result = splitPathAtAnchor(path, 0, "end");

		expect(result).not.toBeNull();
		const [first, second] = result!;

		const lastEndOfFirst = first.segments[first.segments.length - 1].end;
		const startOfSecond = second.segments[0].start;

		expect(startOfSecond).toBeDefined();
		expect(startOfSecond?.x).toBe(lastEndOfFirst.x);
		expect(startOfSecond?.y).toBe(lastEndOfFirst.y);
	});

	it("分割結果の各パスは元パスと異なるIDを持ち、互いのIDも異なる", () => {
		const path = twoSegmentPath();
		const result = splitPathAtAnchor(path, 0, "end");

		expect(result).not.toBeNull();
		const [first, second] = result!;

		expect(first.id).not.toBe(path.id);
		expect(second.id).not.toBe(path.id);
		expect(first.id).not.toBe(second.id);
	});

	it("分割結果のパスはfilters・opacity・blendModeを元パスから引き継ぐ", () => {
		const path = twoSegmentPath();
		const result = splitPathAtAnchor(path, 0, "end");

		expect(result).not.toBeNull();
		const [first, second] = result!;

		const srcStroke = (
			path.filters?.find((f) => f.processor === "stroke") as StrokeAppearance
		).paramData.params;

		for (const p of [first, second]) {
			expect(p.opacity).toBe(path.opacity);
			expect(p.blendMode).toBe(path.blendMode);

			const stroke = (
				p.filters?.find((f) => f.processor === "stroke") as StrokeAppearance
			).paramData.params;
			expect(stroke.brushSettings?.size).toBe(srcStroke.brushSettings?.size);
		}
	});

	it("範囲外のsegmentIndexではnullが返る", () => {
		const path = twoSegmentPath();

		// segment[2]は存在しない
		expect(splitPathAtAnchor(path, 2, "end")).toBeNull();
		// 負のindex
		expect(splitPathAtAnchor(path, -1, "start")).toBeNull();
	});

	it("分割後の2番目のパスの先頭セグメントはisMoved=trueを持つ", () => {
		const path = twoSegmentPath();
		const result = splitPathAtAnchor(path, 0, "end");

		expect(result).not.toBeNull();
		const [, second] = result!;

		expect(second.segments[0].isMoved).toBe(true);
	});

	it("two-segment path split at middle: first.pathEnd ≈ 0.5, second.pathStart ≈ 0.5", () => {
		const path = twoSegmentPath();
		const result = splitPathAtAnchor(path, 0, "end");

		expect(result).not.toBeNull();
		const [first, second] = result!;

		// Two equal-length segments → split at 50%
		expect(first.pathStart).toBeUndefined();
		expect(first.pathEnd).toBeDefined();
		expect(first.pathEnd!).toBeCloseTo(0.5, 1);

		expect(second.pathStart).toBeDefined();
		expect(second.pathStart!).toBeCloseTo(0.5, 1);
		expect(second.pathEnd).toBeUndefined();
	});

	it("three-segment path split at segment[0].end: pathEnd ≈ 1/3, pathStart ≈ 1/3", () => {
		const path = threeSegmentPath();
		const result = splitPathAtAnchor(path, 0, "end");

		expect(result).not.toBeNull();
		const [first, second] = result!;

		expect(first.pathEnd).toBeDefined();
		expect(first.pathEnd!).toBeCloseTo(1 / 3, 1);

		expect(second.pathStart).toBeDefined();
		expect(second.pathStart!).toBeCloseTo(1 / 3, 1);
	});

	it("first.pathEnd equals second.pathStart at the split point", () => {
		const path = threeSegmentPath();
		const result = splitPathAtAnchor(path, 1, "end");

		expect(result).not.toBeNull();
		const [first, second] = result!;

		expect(first.pathEnd).toBeDefined();
		expect(second.pathStart).toBeDefined();
		expect(first.pathEnd).toBeCloseTo(second.pathStart!, 10);
	});
});

// ============================================================================
// Test helpers — after all test cases
// ============================================================================

/**
 * Closed rectangular path with straight-line segments (cp offsets = 0).
 * 4 segments: top → right → bottom → left, closed.
 */
function createFilledRect(x: number, y: number, w: number, h: number): Path {
	return {
		type: "path",
		id: "test-filled-rect",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [
			{
				processor: "fill",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
						},
					},
				},
			} as FillAppearance,
		],
		segments: [
			{
				start: { x, y },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x + w, y },
				isMoved: true,
				startPressure: 0.5,
				endPressure: 0.5,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x + w, y: y + h },
				isMoved: false,
				startPressure: 0.5,
				endPressure: 0.5,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x, y: y + h },
				isMoved: false,
				startPressure: 0.5,
				endPressure: 0.5,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x, y },
				isMoved: false,
				isClosed: true,
				startPressure: 0.5,
				endPressure: 0.5,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
			},
		],
	} as unknown as Path;
}

/**
 * Figure-8 path: two lobes meeting at (0,0).
 * Left lobe centered at (-50,0), right lobe centered at (50,0).
 * Constructed from 4 bezier segments forming a self-intersecting closed path.
 */
function figure8Path(): Path {
	const R = 50;
	const K = R * KAPPA;
	return {
		id: "fig8",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [
			{
				processor: "fill",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
						},
					},
				},
			} as FillAppearance,
		],
		segments: [
			// Start at origin, go to left lobe top
			{
				start: { x: 0, y: 0 },
				cp1: { x: -K, y: K },
				cp2: { x: K, y: 0 },
				end: { x: -R, y: R },
				isMoved: true,
			} as CubicBezierSegment,
			// Left lobe top to left lobe bottom (via left side)
			{
				cp1: { x: -K, y: 0 },
				cp2: { x: -K, y: 0 },
				end: { x: -R, y: -R },
			} as CubicBezierSegment,
			// Left lobe bottom back to origin, cross over to right lobe top
			{
				cp1: { x: K, y: 0 },
				cp2: { x: -K, y: -K },
				end: { x: 0, y: 0 },
			} as CubicBezierSegment,
			// Origin to right lobe top
			{
				cp1: { x: K, y: -K },
				cp2: { x: -K, y: 0 },
				end: { x: R, y: -R },
			} as CubicBezierSegment,
			// Right lobe top to right lobe bottom
			{
				cp1: { x: K, y: 0 },
				cp2: { x: K, y: 0 },
				end: { x: R, y: R },
			} as CubicBezierSegment,
			// Right lobe bottom back to origin (close)
			{
				cp1: { x: -K, y: 0 },
				cp2: { x: K, y: K },
				end: { x: 0, y: 0 },
				isClosed: true,
			} as CubicBezierSegment,
		],
	};
}

function approximateArcFractionAtPoint(
	segment: CubicBezierSegment,
	point: BezierPoint,
): number {
	const { start, cp1, cp2, end } = resolveSegment(segment);
	const samples = 10_000;
	let nearestIndex = 0;
	let nearestDistance = Number.POSITIVE_INFINITY;

	for (let i = 0; i <= samples; i++) {
		const sample = evalBezier(start, cp1, cp2, end, i / samples);
		const distance = Math.hypot(sample.x - point.x, sample.y - point.y);
		if (distance < nearestDistance) {
			nearestIndex = i;
			nearestDistance = distance;
		}
	}

	let totalLength = 0;
	let targetLength = 0;
	let previous = start;
	for (let i = 1; i <= samples; i++) {
		const sample = evalBezier(start, cp1, cp2, end, i / samples);
		const length = Math.hypot(sample.x - previous.x, sample.y - previous.y);
		totalLength += length;
		if (i <= nearestIndex) targetLength += length;
		previous = sample;
	}

	return targetLength / totalLength;
}

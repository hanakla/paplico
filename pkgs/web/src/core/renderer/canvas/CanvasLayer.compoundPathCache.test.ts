import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../document/factory";
import type {
	BezierPoint,
	CompoundPath,
	CompoundPathSource,
	CubicBezierSegment,
	FillAppearance,
	Path,
	StrokeAppearance,
} from "../../schema";
import { CompoundPathCache } from "./caches/CompoundPathCache";

const BLACK = { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 };
const SOLID_FILL = { type: "solid" as const, color: BLACK };

describe("CompoundPathCache", () => {
	it("returns cached segments when fingerprint is unchanged", () => {
		const pathA = createCirclePath("a", 0, 0, 100);
		const pathB = createCirclePath("b", 80, 0, 100);
		const cache = new CompoundPathCache();
		const pathMap = new Map<string, Path>([
			[pathA.id, pathA],
			[pathB.id, pathB],
		]);
		const compound = createCompoundPath("cp", [
			{ id: pathA.id, op: "union" },
			{ id: pathB.id, op: "union" },
		]);

		const first = cache.resolve(compound, pathMap);
		const second = cache.resolve(compound, pathMap);

		expect(second).toBe(first);
		expect(cache.size()).toBe(1);
	});

	it("recomputes when source geometry/op/order changes", () => {
		const pathA = createCirclePath("a", 0, 0, 100);
		const pathB = createCirclePath("b", 80, 0, 100);
		const cache = new CompoundPathCache();
		const pathMap = new Map<string, Path>([
			[pathA.id, pathA],
			[pathB.id, pathB],
		]);
		const baseCompound = createCompoundPath("cp", [
			{ id: pathA.id, op: "union" },
			{ id: pathB.id, op: "union" },
		]);
		const base = cache.resolve(baseCompound, pathMap);

		const mutatedA = createCirclePath("a", 10, 0, 100);
		const mutatedMap = new Map<string, Path>(pathMap);
		mutatedMap.set(pathA.id, mutatedA);
		const geometryChanged = cache.resolve(baseCompound, mutatedMap);
		expect(geometryChanged).not.toBe(base);

		const opChanged = createCompoundPath("cp", [
			{ id: pathA.id, op: "union" },
			{ id: pathB.id, op: "subtract" },
		]);
		const opChangedSegments = cache.resolve(opChanged, pathMap);
		expect(opChangedSegments).not.toBe(geometryChanged);

		const orderChanged = createCompoundPath("cp", [
			{ id: pathB.id, op: "union" },
			{ id: pathA.id, op: "union" },
		]);
		const orderChangedSegments = cache.resolve(orderChanged, pathMap);
		expect(orderChangedSegments).not.toBe(opChangedSegments);
	});

	it("drops all cached data when clear is called", () => {
		const pathA = createCirclePath("a", 0, 0, 100);
		const pathB = createCirclePath("b", 80, 0, 100);
		const cache = new CompoundPathCache();
		const pathMap = new Map<string, Path>([
			[pathA.id, pathA],
			[pathB.id, pathB],
		]);
		const compound = createCompoundPath("cp", [
			{ id: pathA.id, op: "union" },
			{ id: pathB.id, op: "union" },
		]);

		const first = cache.resolve(compound, pathMap);
		cache.clear();
		const second = cache.resolve(compound, pathMap);

		expect(second).not.toBe(first);
		expect(cache.size()).toBe(1);
	});
});

function createCompoundPath(
	id: string,
	sources: CompoundPathSource[],
): CompoundPath {
	return {
		type: "compound-path",
		id,
		sources,
		opacity: 1,
		blendMode: "normal",
		filters: [
			{
				processor: "stroke",
				paramData: {
					version: "1",
					params: {
						strokeColor: { type: "solid", color: BLACK },
						brushSettings: { type: "line", size: 2, opacity: 1 },
					},
				},
			} as unknown as StrokeAppearance,
			{
				processor: "fill",
				paramData: { version: "1", params: { fill: SOLID_FILL } },
			} as FillAppearance,
		],
		transform: createIdentityTransform(),
	};
}

function createCirclePath(id: string, cx: number, cy: number, r: number): Path {
	const kappa = 0.552284749831;
	const kr = r * kappa;
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
				processor: "stroke",
				paramData: {
					version: "1",
					params: {
						strokeColor: { type: "solid", color: BLACK },
						brushSettings: { type: "line", size: 0, opacity: 1 },
					},
				},
			} as unknown as StrokeAppearance,
			{
				processor: "fill",
				paramData: { version: "1", params: { fill: SOLID_FILL } },
			} as FillAppearance,
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

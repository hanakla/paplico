import { describe, expect, it } from "vitest";
import type { Artboard, PathSegment } from "../../../schema";
import { applyTransformToPoint } from "../../../utils/geometry/geometry";
import {
	composeWorldAffine,
	createCoordMapper,
	elementTransformToWorldAffine,
	formatNumber,
	segmentsToPathData,
	svgMatrixToString,
} from "./pathData";

const artboard = (
	x: number,
	y: number,
	width: number,
	height: number,
): Artboard => ({ id: "ab", name: "Artboard", x, y, width, height });

const seg = (partial: Partial<PathSegment>): PathSegment => ({
	cp1: { x: 0, y: 0 },
	cp2: { x: 0, y: 0 },
	end: { x: 0, y: 0 },
	startTiltX: 0,
	startTiltY: 0,
	endTiltX: 0,
	endTiltY: 0,
	startDeltaTime: 0,
	endDeltaTime: 0,
	isMoved: false,
	...partial,
});

describe("formatNumber", () => {
	it("should round to 3 decimals", () => {
		expect(formatNumber(1.23456)).toBe("1.235");
		expect(formatNumber(0.1 + 0.2)).toBe("0.3");
	});

	it("should normalize -0 and tiny negatives to 0", () => {
		expect(formatNumber(-0)).toBe("0");
		expect(formatNumber(-0.0001)).toBe("0");
	});

	it("should keep integers without decimal point", () => {
		expect(formatNumber(400)).toBe("400");
	});
});

describe("createCoordMapper", () => {
	it("should map world origin to artboard center for a centered artboard", () => {
		const mapper = createCoordMapper(artboard(0, 0, 800, 600));
		expect(mapper.point({ x: 0, y: 0 })).toEqual({ x: 400, y: 300 });
	});

	it("should map the artboard's top-left world corner to (0, 0)", () => {
		const mapper = createCoordMapper(artboard(0, 0, 800, 600));
		// World top-left of the artboard = (-400, +300) in Y-up space.
		expect(mapper.point({ x: -400, y: 300 })).toEqual({ x: 0, y: 0 });
	});

	it("should handle an artboard whose center is not the world origin", () => {
		const mapper = createCoordMapper(artboard(100, 50, 200, 100));
		// originX = 0, originY = 100
		expect(mapper.point({ x: 0, y: 100 })).toEqual({ x: 0, y: 0 });
		expect(mapper.point({ x: 200, y: 0 })).toEqual({ x: 200, y: 100 });
	});

	it("should compose F with a pure world translation, flipping the Y axis", () => {
		const mapper = createCoordMapper(artboard(0, 0, 800, 600));
		const m = mapper.composeWorld({
			m00: 1,
			m01: 0,
			m10: 0,
			m11: 1,
			tx: 10,
			ty: 20,
		});
		// Input space is world-oriented (Y up), so the linear part flips Y and
		// the translation lands at mapper.point((10, 20)).
		expect(m).toEqual({ a: 1, b: 0, c: 0, d: -1, e: 410, f: 280 });
	});

	it("should agree with point-mapping the transformed input for arbitrary maps", () => {
		const ab = artboard(100, -50, 300, 200);
		const mapper = createCoordMapper(ab);
		const transform = {
			x: 15,
			y: -25,
			rotation: Math.PI / 6,
			scaleX: 2,
			scaleY: 0.5,
			skewX: 0.2,
		};
		const origin = { x: 40, y: 30 };
		const m = mapper.composeWorld(
			elementTransformToWorldAffine(transform, origin),
		);

		for (const p of [
			{ x: 0, y: 0 },
			{ x: 40, y: 30 },
			{ x: -120, y: 85 },
		]) {
			const world = applyTransformToPoint(
				p.x,
				p.y,
				transform,
				origin.x,
				origin.y,
			);
			const expected = mapper.point(world);
			const actual = {
				x: m.a * p.x + m.c * p.y + m.e,
				y: m.b * p.x + m.d * p.y + m.f,
			};
			expect(actual.x).toBeCloseTo(expected.x, 6);
			expect(actual.y).toBeCloseTo(expected.y, 6);
		}
	});

	it("should compose affine maps so result(p) = outer(inner(p))", () => {
		const outer = { m00: 2, m01: 1, m10: 0, m11: 3, tx: 5, ty: -2 };
		const inner = { m00: 0, m01: -1, m10: 1, m11: 0, tx: 4, ty: 7 };
		const composed = composeWorldAffine(outer, inner);
		const p = { x: 3, y: -6 };
		const innerP = {
			x: inner.m00 * p.x + inner.m01 * p.y + inner.tx,
			y: inner.m10 * p.x + inner.m11 * p.y + inner.ty,
		};
		const expected = {
			x: outer.m00 * innerP.x + outer.m01 * innerP.y + outer.tx,
			y: outer.m10 * innerP.x + outer.m11 * innerP.y + outer.ty,
		};
		expect(composed.m00 * p.x + composed.m01 * p.y + composed.tx).toBeCloseTo(
			expected.x,
			9,
		);
		expect(composed.m10 * p.x + composed.m11 * p.y + composed.ty).toBeCloseTo(
			expected.y,
			9,
		);
	});
});

describe("segmentsToPathData", () => {
	const mapper = createCoordMapper(artboard(0, 0, 800, 600));

	it("should emit M then L for straight segments", () => {
		const d = segmentsToPathData(
			[
				seg({
					start: { x: -400, y: 300 },
					end: { x: 0, y: 0 },
					isMoved: true,
				}),
			],
			mapper,
		);
		expect(d).toBe("M 0 0 L 400 300");
	});

	it("should emit C with control points resolved from relative offsets", () => {
		const d = segmentsToPathData(
			[
				seg({
					start: { x: 0, y: 0 },
					cp1: { x: 10, y: 20 },
					cp2: { x: -10, y: -20 },
					end: { x: 100, y: 0 },
					isMoved: true,
				}),
			],
			mapper,
		);
		// cp1 = start + (10, 20) = (10, 20) → svg (410, 280)
		// cp2 = end + (-10, -20) = (90, -20) → svg (490, 320)
		expect(d).toBe("M 400 300 C 410 280 490 320 500 300");
	});

	it("should close subpaths with Z and restart with M on isMoved", () => {
		const d = segmentsToPathData(
			[
				seg({ start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, isMoved: true }),
				seg({ end: { x: 100, y: 100 }, isClosed: true }),
				seg({
					start: { x: 200, y: 200 },
					end: { x: 300, y: 200 },
					isMoved: true,
				}),
			],
			mapper,
		);
		expect(d).toBe("M 400 300 L 500 300 L 500 200 Z M 600 100 L 700 100");
	});

	it("should return an empty string for no segments", () => {
		expect(segmentsToPathData([], mapper)).toBe("");
	});
});

describe("svgMatrixToString", () => {
	it("should format all six coefficients", () => {
		expect(svgMatrixToString({ a: 1, b: 0, c: 0, d: 1, e: 10.5, f: -0 })).toBe(
			"matrix(1 0 0 1 10.5 0)",
		);
	});
});

import { describe, expect, it } from "vitest";
import { createRepeatObject } from "../../document/factory";
import type { RepeatObject } from "../../schema";
import {
	applyAffineToPoint,
	composeAffine,
	computeRepeatInstances,
	elementTransformToAffine,
	IDENTITY_AFFINE,
} from "./repeatInterpolation";

const CENTER = { x: 0, y: 0 };

function makeRepeat(overrides: Partial<RepeatObject>): RepeatObject {
	return { ...createRepeatObject(["src"]), ...overrides };
}

describe("computeRepeatInstances", () => {
	describe("grid mode", () => {
		it("should derive rows*columns from the fill region and spacing", () => {
			// width 30 / spacingX 10 -> 4 cols; height 40 / spacingY 20 -> 3 rows.
			const repeat = makeRepeat({
				mode: "grid",
				grid: { width: 30, height: 40, spacingX: 10, spacingY: 20 },
			});
			expect(computeRepeatInstances(repeat, CENTER)).toHaveLength(12);
		});

		it("should keep the first instance as identity (the original)", () => {
			const repeat = makeRepeat({
				mode: "grid",
				grid: { width: 10, height: 20, spacingX: 10, spacingY: 20 },
			});
			expect(computeRepeatInstances(repeat, CENTER)[0]).toEqual(
				IDENTITY_AFFINE,
			);
		});

		it("should offset instances by per-axis spacing in row-major order", () => {
			const repeat = makeRepeat({
				mode: "grid",
				grid: { width: 10, height: 20, spacingX: 10, spacingY: 20 },
			});
			const at = computeRepeatInstances(repeat, CENTER).map((m) =>
				applyAffineToPoint(m, { x: 0, y: 0 }),
			);
			// Rows grow downward (screen), i.e. -y in the Y-up world space.
			expect(at).toEqual([
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 0, y: -20 },
				{ x: 10, y: -20 },
			]);
		});

		it("should brick-offset odd rows horizontally by offsetX", () => {
			const repeat = makeRepeat({
				mode: "grid",
				grid: {
					width: 10,
					height: 20,
					spacingX: 10,
					spacingY: 20,
					offsetX: 5,
					offsetY: 0,
				},
			});
			const at = computeRepeatInstances(repeat, CENTER).map((m) =>
				applyAffineToPoint(m, { x: 0, y: 0 }),
			);
			// Row 0 aligned; row 1 (odd) shifted right by 5.
			expect(at).toEqual([
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 5, y: -20 },
				{ x: 15, y: -20 },
			]);
		});
	});

	describe("radial mode", () => {
		it("should produce `count` instances", () => {
			const repeat = makeRepeat({
				mode: "radial",
				radial: {
					count: 6,
					radius: 100,
					startAngle: 0,
					sweep: Math.PI * 2,
					rotateInstances: true,
				},
			});
			expect(computeRepeatInstances(repeat, CENTER)).toHaveLength(6);
		});

		it("should place instance 0 on the ring above the object center at startAngle 0", () => {
			const repeat = makeRepeat({
				mode: "radial",
				radial: {
					count: 4,
					radius: 100,
					startAngle: 0,
					sweep: Math.PI * 2,
					rotateInstances: true,
				},
			});
			// The ring is centered on the source center (0,0); instance 0 sits one
			// radius above it.
			const p = applyAffineToPoint(
				computeRepeatInstances(repeat, CENTER)[0],
				CENTER,
			);
			expect(p.x).toBeCloseTo(0);
			expect(p.y).toBeCloseTo(-100);
		});

		it("should orbit copies around the object center (quarter turn for the 2nd of 4)", () => {
			const repeat = makeRepeat({
				mode: "radial",
				radial: {
					count: 4,
					radius: 100,
					startAngle: 0,
					sweep: Math.PI * 2,
					rotateInstances: true,
				},
			});
			// Ring center = object center (0,0). Instance 0 at (0,-100); a +90deg
			// turn about the center lands the 2nd instance at (100, 0).
			const p = applyAffineToPoint(
				computeRepeatInstances(repeat, CENTER)[1],
				CENTER,
			);
			expect(p.x).toBeCloseTo(100);
			expect(p.y).toBeCloseTo(0);
		});
	});

	describe("mirror mode", () => {
		it("should produce exactly 2 instances (source + reflection)", () => {
			const repeat = makeRepeat({
				mode: "mirror",
				mirror: { axisAngle: Math.PI / 2, offset: 50 },
			});
			expect(computeRepeatInstances(repeat, CENTER)).toHaveLength(2);
		});

		it("should reflect a point across a vertical axis offset from center", () => {
			// Vertical axis (angle PI/2), normal is horizontal; offset 50 puts the
			// axis at x = 50. A point at x=0 reflects to x=100.
			const repeat = makeRepeat({
				mode: "mirror",
				mirror: { axisAngle: Math.PI / 2, offset: 50 },
			});
			const reflect = computeRepeatInstances(repeat, CENTER)[1];
			const p = applyAffineToPoint(reflect, { x: 0, y: 30 });
			expect(p.x).toBeCloseTo(100);
			expect(p.y).toBeCloseTo(30);
		});

		it("should rotate the original with the axis about the source center", () => {
			// Axis tilted 90deg from the default vertical axis -> the original
			// rotates 90deg about the source center (CENTER = origin), so a point
			// 10 to the right of the pivot swings to 10 above it.
			const repeat = makeRepeat({
				mode: "mirror",
				mirror: { axisAngle: Math.PI, offset: 50 },
			});
			const [original, reflection] = computeRepeatInstances(repeat, CENTER);
			const op = applyAffineToPoint(original, { x: 10, y: 0 });
			expect(op.x).toBeCloseTo(0);
			expect(op.y).toBeCloseTo(10);
			// The reflection stays the rotated original mirrored across the tilted
			// axis (horizontal line y=50 here): same x, y reflected about 50.
			const rp = applyAffineToPoint(reflection, { x: 10, y: 0 });
			expect(rp.x).toBeCloseTo(op.x);
			expect(rp.y).toBeCloseTo(100 - op.y);
		});
	});
});

describe("affine helpers", () => {
	it("composeAffine should apply the inner transform first", () => {
		const inner = elementTransformToAffine(
			{ x: 5, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			0,
			0,
		);
		const outer = elementTransformToAffine(
			{ x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 2 },
			0,
			0,
		);
		// outer(inner(p)): translate by 5 then scale by 2 -> (0+5)*2 = 10.
		const p = applyAffineToPoint(composeAffine(outer, inner), { x: 0, y: 0 });
		expect(p.x).toBeCloseTo(10);
		expect(p.y).toBeCloseTo(0);
	});

	it("elementTransformToAffine should rotate around the given origin", () => {
		const m = elementTransformToAffine(
			{ x: 0, y: 0, rotation: Math.PI / 2, scaleX: 1, scaleY: 1 },
			10,
			10,
		);
		// Rotating the pivot itself leaves it fixed.
		const p = applyAffineToPoint(m, { x: 10, y: 10 });
		expect(p.x).toBeCloseTo(10);
		expect(p.y).toBeCloseTo(10);
	});
});

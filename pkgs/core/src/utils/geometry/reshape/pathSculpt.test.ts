import { describe, expect, it } from "vitest";
import type { CubicBezierSegment, Point } from "../../../schema";
import { closedRectSegments, lineSeg } from "../../../testUtils/segmentFactory";
import { mulberry32 } from "../../math";
import {
	buildArcLengthTable,
	samplePathAtArcLength,
} from "../measure/arcLength";
import { computeSubPathSignedArea } from "../measure/area";
import { splitIntoSubPaths } from "../primitives/segment";
import { isPointInPath } from "../query/hitTest";
import { carryProfile, sculptPath } from "./pathSculpt";

describe("sculptPath", () => {
	const square = closedRectSegments(0, 0, 100, 100);
	const zoom = 1;

	it("should add the part of the stroke's region that lies outside the path", () => {
		const result = sculptPath(
			square,
			polyline([
				{ x: 50, y: 50 },
				{ x: 150, y: 30 },
				{ x: 150, y: 70 },
				{ x: 50, y: 60 },
			]),
			"add",
			zoom,
			false,
		);

		expect(isInside(result, 130, 50)).toBe(true);
		expect(isInside(result, 50, 50)).toBe(true);
		expect(isInside(result, 130, 10)).toBe(false);
	});

	it("should take the part of the stroke's region that lies inside the path away", () => {
		const result = sculptPath(
			square,
			polyline([
				{ x: 150, y: 30 },
				{ x: 50, y: 45 },
				{ x: 50, y: 55 },
				{ x: 150, y: 70 },
			]),
			"subtract",
			zoom,
			false,
		);

		expect(isInside(result, 70, 50)).toBe(false);
		expect(isInside(result, 20, 50)).toBe(true);
	});

	it("should keep both pieces in one segment list when a subtraction splits the path", () => {
		const result = sculptPath(
			square,
			polyline([
				{ x: 40, y: -20 },
				{ x: 40, y: 120 },
				{ x: 60, y: 120 },
				{ x: 60, y: -20 },
			]),
			"subtract",
			zoom,
			false,
		);

		expect(isInside(result, 50, 50)).toBe(false);
		expect(isInside(result, 20, 50)).toBe(true);
		expect(isInside(result, 80, 50)).toBe(true);
		expect(splitIntoSubPaths(result ?? [])).toHaveLength(2);
	});

	it("should return an empty array when the stroke takes the whole path away", () => {
		const result = sculptPath(
			square,
			polyline([
				{ x: -20, y: -20 },
				{ x: 120, y: -20 },
				{ x: 120, y: 120 },
				{ x: -20, y: 120 },
			]),
			"subtract",
			zoom,
			false,
		);

		expect(result).toEqual([]);
	});

	describe("with an open path", () => {
		// Three sides of the square; the line joining its ends is the fourth,
		// from (0,100) back to (0,0).
		const openSquare = square.slice(0, 3);
		const bulge = [
			{ x: 50, y: 50 },
			{ x: 150, y: 30 },
			{ x: 150, y: 70 },
			{ x: 50, y: 60 },
		];

		it("should close the path by the line joining its ends", () => {
			const result = sculptPath(
				openSquare,
				polyline(bulge),
				"add",
				zoom,
				false,
			);

			expect(isInside(result, 130, 50)).toBe(true);
			expect(result?.at(-1)?.isClosed).toBe(true);
		});

		it("should keep the direction of a filled open path away from the origin", () => {
			// (300,0) -> (200,0) -> (200,100) -> (300,100), open on the right
			const openAway = closedRectSegments(300, 0, 200, 100).slice(0, 3);

			const result =
				sculptPath(
					openAway,
					polyline([
						{ x: 250, y: 50 },
						{ x: 150, y: 30 },
						{ x: 150, y: 70 },
						{ x: 250, y: 60 },
					]),
					"add",
					zoom,
					false,
				) ?? [];

			// Closed, the original runs (300,0) -> (200,0) -> (200,100) -> (300,100)
			const closedOriginal = closedRectSegments(300, 0, 200, 100);
			expect(Math.sign(computeSubPathSignedArea(result))).toBe(
				Math.sign(computeSubPathSignedArea(closedOriginal)),
			);
		});

		it("should redraw the stretch between the stroke's crossings and keep the path open", () => {
			const result = sculptPath(openSquare, polyline(bulge), "add", zoom, true);

			expect(result?.some((segment) => segment.isClosed)).toBe(false);
			expect(splitIntoSubPaths(result ?? [])).toHaveLength(1);
			expect(result?.some((segment) => segment.end.x > 140)).toBe(true);
			// Same ends, in the same order
			expect(result?.[0].start).toMatchObject({ x: 0, y: 0 });
			expect(result?.at(-1)?.end).toMatchObject({ x: 0, y: 100 });
		});

		it("should stay one line when the stroke also crosses the line joining its ends", () => {
			// Enters over the open side at x=0, leaves over the side at x=100
			const result = sculptPath(
				openSquare,
				polyline([
					{ x: -50, y: 50 },
					{ x: 50, y: 40 },
					{ x: 150, y: 50 },
					{ x: 150, y: 150 },
					{ x: 50, y: 150 },
					{ x: 50, y: 60 },
				]),
				"subtract",
				zoom,
				true,
			);

			expect(splitIntoSubPaths(result ?? [])).toHaveLength(1);
			expect(result?.some((segment) => segment.isClosed)).toBe(false);
		});

		it("should return null when the stroke crosses the line once", () => {
			const result = sculptPath(
				openSquare,
				polyline([
					{ x: 50, y: 50 },
					{ x: 150, y: 30 },
					{ x: 180, y: 80 },
				]),
				"add",
				zoom,
				true,
			);

			expect(result).toBeNull();
		});

		it("should record no pressure on a line that had none", () => {
			const result = sculptPath(openSquare, polyline(bulge), "add", zoom, true);

			expect(
				result?.every(
					(segment) =>
						segment.startPressure === undefined &&
						segment.endPressure === undefined,
				),
			).toBe(true);
		});

		it("should round the corners where the redrawn stretch meets the line", () => {
			const result =
				sculptPath(openSquare, polyline(bulge), "add", zoom, true) ?? [];

			const rounded = result.filter((segment) => segment.cornerRadius);
			expect(rounded).toHaveLength(2);
			for (const { cornerRadius } of rounded) {
				expect(cornerRadius).toBeCloseTo(0.15 * 25, 1);
			}
		});

		it("should keep the pressure of the parts the stroke leaves alone", () => {
			const pressed = openSquare.map((segment, index) => ({
				...segment,
				startPressure: 0.2 + index * 0.2,
				endPressure: 0.4 + index * 0.2,
			}));

			const result = sculptPath(pressed, polyline(bulge), "add", zoom, true);

			expect(result?.[0].startPressure).toBeCloseTo(0.2);
			expect(result?.at(-1)?.endPressure).toBeCloseTo(0.8);
			// The redrawn stretch runs between pressures of the side it replaces
			for (const segment of result ?? []) {
				expect(segment.startPressure).toBeGreaterThanOrEqual(0.2);
				expect(segment.endPressure).toBeLessThanOrEqual(0.8);
			}
		});
	});

	it("should keep the direction and the pressure of the outline it reshapes", () => {
		const pressed = square.map((segment) => ({
			...segment,
			startPressure: 0.3,
			endPressure: 0.3,
		}));
		const stroke = [
			{ x: 50, y: 50 },
			{ x: 150, y: 30 },
			{ x: 150, y: 70 },
			{ x: 50, y: 60 },
		];

		const result =
			sculptPath(pressed, polyline(stroke), "add", zoom, false) ?? [];

		expect(Math.sign(computeSubPathSignedArea(result))).toBe(
			Math.sign(computeSubPathSignedArea(pressed)),
		);
		expect(result.every((segment) => segment.startPressure === 0.3)).toBe(true);
	});

	it("should record no pressure on an outline that had none", () => {
		const result = sculptPath(
			square,
			polyline([
				{ x: 50, y: 50 },
				{ x: 150, y: 30 },
				{ x: 150, y: 70 },
				{ x: 50, y: 60 },
			]),
			"add",
			zoom,
			false,
		);

		expect(
			result?.every((segment) => segment.startPressure === undefined),
		).toBe(true);
	});

	it("should round the two corners of the mouth in proportion to its width", () => {
		// Crosses the side x=100 at y=40 and y=65: a mouth 25 wide
		const result =
			sculptPath(
				square,
				polyline([
					{ x: 50, y: 50 },
					{ x: 150, y: 30 },
					{ x: 150, y: 70 },
					{ x: 50, y: 60 },
				]),
				"add",
				zoom,
				false,
			) ?? [];

		const rounded = result.filter((segment) => segment.cornerRadius);
		expect(
			rounded.map(({ end }) => [Math.round(end.x), Math.round(end.y)]),
		).toEqual(
			expect.arrayContaining([
				[100, 40],
				[100, 65],
			]),
		);
		expect(rounded).toHaveLength(2);
		for (const { cornerRadius } of rounded) {
			expect(cornerRadius).toBeCloseTo(0.15 * 25, 1);
		}
		// The outline's own corners stay sharp
		expect(result.at(-1)?.cornerRadius).toBeUndefined();
	});

	it("should keep the corner radii of the corners the stroke leaves alone", () => {
		const rounded = square.map((segment) => ({ ...segment, cornerRadius: 10 }));

		const result =
			sculptPath(
				rounded,
				polyline([
					{ x: 50, y: 50 },
					{ x: 150, y: 30 },
					{ x: 150, y: 70 },
					{ x: 50, y: 60 },
				]),
				"add",
				zoom,
				false,
			) ?? [];

		const radiusAt = (x: number, y: number) =>
			result.find(({ end }) => Math.hypot(end.x - x, end.y - y) < 1e-6)
				?.cornerRadius;
		const isLast = (x: number, y: number) => {
			const last = result.at(-1)?.end;
			return last !== undefined && Math.hypot(last.x - x, last.y - y) < 1e-6;
		};
		for (const [x, y] of [
			[0, 0],
			[100, 0],
			[100, 100],
			[0, 100],
		]) {
			// The vertex the outline closes at stays sharp
			expect(radiusAt(x, y)).toBe(isLast(x, y) ? undefined : 10);
		}
		expect(result.at(-1)?.cornerRadius).toBeUndefined();
	});

	it("should return null when an added stroke stays inside the path", () => {
		const result = sculptPath(
			square,
			polyline([
				{ x: 20, y: 20 },
				{ x: 80, y: 20 },
				{ x: 80, y: 80 },
			]),
			"add",
			zoom,
			false,
		);

		expect(result).toBeNull();
	});

	it("should return null when a subtracted stroke stays outside the path", () => {
		const result = sculptPath(
			square,
			polyline([
				{ x: 120, y: 20 },
				{ x: 180, y: 20 },
				{ x: 180, y: 80 },
			]),
			"subtract",
			zoom,
			false,
		);

		expect(result).toBeNull();
	});

	it("should return null when a hand-drawn stroke runs straight across the path", () => {
		const wobble = seededWobble();
		const line = Array.from({ length: 150 }, (_, i) => ({
			x: -20 + (140 * i) / 149 + wobble(),
			y: 50 + wobble(),
		}));

		expect(
			sculptPath(square, polyline(line), "subtract", zoom, false),
		).toBeNull();
	});

	it("should return null when the stroke runs straight across the path", () => {
		const result = sculptPath(
			square,
			polyline([
				{ x: -20, y: 50 },
				{ x: 50, y: 50.2 },
				{ x: 120, y: 50 },
			]),
			"subtract",
			zoom,
			false,
		);

		expect(result).toBeNull();
	});
});

describe("carryProfile", () => {
	// (0,0) -> (100,0) -> (100,100) -> (0,100), open: 300 long
	const line = closedRectSegments(0, 0, 100, 100).slice(0, 3);
	const zoom = 1;

	it("should keep a profile point where it sat on the part that kept its shape", () => {
		const redrawn =
			sculptPath(
				line,
				polyline([
					{ x: 50, y: 50 },
					{ x: 150, y: 30 },
					{ x: 150, y: 70 },
					{ x: 50, y: 60 },
				]),
				"add",
				zoom,
				true,
			) ?? [];
		// At 50 of 300 along the first side: (50,0)
		const [carried] = carryProfile(
			[{ t: 50 / 300, side1: 0.4, side2: 0.6 }],
			line,
			redrawn,
		);

		const table = buildArcLengthTable(redrawn);
		const total = table.at(-1)?.cumulativeLength ?? 0;
		const place = samplePathAtArcLength(
			redrawn,
			table,
			carried.t * total,
			total,
		);
		expect(total).toBeGreaterThan(300);
		expect(place?.x).toBeCloseTo(50, 0);
		expect(place?.y).toBeCloseTo(0, 0);
		expect(carried).toMatchObject({ side1: 0.4, side2: 0.6 });
	});

	it("should keep the ends of the profile on the ends of a closed path", () => {
		const closed = closedRectSegments(0, 0, 100, 100);

		const carried = carryProfile(
			[
				{ t: 0, side1: 1, side2: 1 },
				{ t: 0.5, side1: 0.5, side2: 0.5 },
				{ t: 1, side1: 1, side2: 1 },
			],
			closed,
			closed,
		);

		expect(carried.map(({ t }) => t)).toEqual([0, 0.5, 1]);
	});

	it("should keep the ends of the profile on the ends of the path", () => {
		const carried = carryProfile(
			[
				{ t: 0, side1: 1, side2: 1 },
				{ t: 1, side1: 0, side2: 0 },
			],
			line,
			line,
		);

		expect(carried[0].t).toBeCloseTo(0);
		expect(carried[1].t).toBeCloseTo(1);
	});
});

/** A stroke through the points, as straight segments. */
function polyline(points: Point[]): CubicBezierSegment[] {
	return points
		.slice(1)
		.map((end, index) =>
			lineSeg(end, index === 0 ? { start: points[0], isMoved: true } : {}),
		);
}

/** Repeatable offsets within ±0.5, standing in for an unsteady hand. */
function seededWobble(): () => number {
	const random = mulberry32(1);
	return () => random() - 0.5;
}

function isInside(
	segments: CubicBezierSegment[] | null,
	x: number,
	y: number,
): boolean {
	return segments !== null && isPointInPath(x, y, { segments });
}

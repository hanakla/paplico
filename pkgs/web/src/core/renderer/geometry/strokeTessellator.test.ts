import { describe, expect, it } from "vitest";
import { lineSeg } from "../../testUtils/segmentFactory";
import { flattenBezierPathWithPressure } from "./bezierFlatten";
import {
	applyDashPattern,
	type StrokeTessellateInput,
	tessellateStroke,
} from "./strokeTessellator";

function makeInput(
	overrides: Partial<StrokeTessellateInput>,
): StrokeTessellateInput {
	return {
		points: [],
		pressures: [],
		baseWidth: 10,
		sizeByPressure: 0,
		lineCap: "butt",
		lineJoin: "miter",
		miterLimit: 4,
		isClosed: false,
		...overrides,
	};
}

describe("tessellateStroke", () => {
	it.each([
		"round",
		"bevel",
		"miter",
	] as const)("should cover the interior of an SVG curve with %s joins", (lineJoin) => {
		const { points, pressures } = flattenBezierPathWithPressure(
			[
				lineSeg({ x: 0, y: 0 }, { start: { x: 0, y: -24 } }),
				lineSeg(
					{ x: -8.7, y: 8.7 },
					{
						cp1: { x: 0, y: 4.81 },
						cp2: { x: 4.8, y: 0 },
					},
				),
				lineSeg({ x: -32, y: 8.7 }),
			],
			{ curveTolerance: 0.0625 },
		);
		for (const direction of [1, -1]) {
			const mirrored = points.map((value, index) =>
				index % 2 === 0 ? value * direction : value,
			);
			const { vertices } = tessellateStroke(
				makeInput({ points: mirrored, pressures, baseWidth: 2.66, lineJoin }),
			);
			for (let i = 2; i < mirrored.length - 2; i += 2) {
				for (const dx of [-0.5, 0, 0.5]) {
					for (const dy of [-0.5, 0, 0.5]) {
						expect(
							coversPoint(vertices, mirrored[i] + dx, mirrored[i + 1] + dy),
						).toBe(true);
					}
				}
			}
		}
	});
	it("should return empty result for fewer than 2 points", () => {
		const single = tessellateStroke(
			makeInput({ points: [0, 0], pressures: [1] }),
		);
		expect(single.vertices).toHaveLength(0);
		expect(single.count).toBe(0);

		const empty = tessellateStroke(makeInput({ points: [], pressures: [] }));
		expect(empty.count).toBe(0);
	});

	it("should produce a rectangle (2 triangles) for a horizontal line with butt cap", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				baseWidth: 10,
				lineCap: "butt",
			}),
		);

		// 2 triangles for the body segment, no caps
		expect(result.count).toBe(6); // 2 triangles × 3 vertices
		expect(result.vertices).toHaveLength(12); // 6 vertices × 2 floats
	});

	it("should produce additional geometry for round caps", () => {
		const butt = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				lineCap: "butt",
			}),
		);

		const round = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				lineCap: "round",
			}),
		);

		// Round caps add half-circle fan triangles at each end
		expect(round.count).toBeGreaterThan(butt.count);
	});

	it("round cap vertices should extend beyond the stroke endpoint (outward)", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				baseWidth: 20,
				lineCap: "round",
			}),
		);

		const butt = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				baseWidth: 20,
				lineCap: "butt",
			}),
		);

		const xValues = result.vertices.filter((_, i) => i % 2 === 0);
		const buttXValues = butt.vertices.filter((_, i) => i % 2 === 0);

		// Butt cap: x stays within [0, 100]
		expect(Math.min(...buttXValues)).toBeCloseTo(0, 5);
		expect(Math.max(...buttXValues)).toBeCloseTo(100, 5);

		// Round cap: x extends beyond [0, 100] by ~halfWidth (10)
		expect(Math.min(...xValues)).toBeLessThan(-1);
		expect(Math.max(...xValues)).toBeGreaterThan(101);
	});

	it("should produce additional geometry for square caps", () => {
		const butt = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				lineCap: "butt",
			}),
		);

		const square = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				lineCap: "square",
			}),
		);

		// Square caps add 2 triangles at each end (4 total)
		expect(square.count).toBe(butt.count + 12); // 4 triangles × 3 vertices
	});

	it("should produce join geometry for a right-angle path", () => {
		const result = tessellateStroke(
			makeInput({
				// L-shaped path: right then up
				points: [0, 0, 100, 0, 100, 100],
				pressures: [1, 1, 1],
				lineJoin: "bevel",
				lineCap: "butt",
			}),
		);

		expect(coversPoint(result.vertices, 99, 1)).toBe(true);
		expect(coversPoint(result.vertices, 101, -1)).toBe(true);
	});

	describe("join side", () => {
		// L-shaped path turning left: the outer corner extension is (110, -10).
		const leftTurn = { points: [0, 0, 100, 0, 100, 100], pressures: [1, 1, 1] };
		// Mirrored path turning right: the outer corner extension is (110, 10).
		const rightTurn = {
			points: [0, 0, 100, 0, 100, -100],
			pressures: [1, 1, 1],
		};

		it("should emit the miter tip on the outer side of the corner", () => {
			const left = tessellateStroke(
				makeInput({ ...leftTurn, baseWidth: 20, lineJoin: "miter" }),
			);
			expect(hasBodyVertexNear(left, 110, -10)).toBe(true);

			const right = tessellateStroke(
				makeInput({ ...rightTurn, baseWidth: 20, lineJoin: "miter" }),
			);
			expect(hasBodyVertexNear(right, 110, 10)).toBe(true);
		});

		it("should meet the body quads at the inner offset intersection", () => {
			const left = tessellateStroke(
				makeInput({ ...leftTurn, baseWidth: 20, lineJoin: "bevel" }),
			);
			expect(hasBodyVertexNear(left, 90, 10)).toBe(true);
			expect(hasBodyVertexNear(left, 100, 10)).toBe(false);
			expect(hasBodyVertexNear(left, 90, 0)).toBe(false);

			const right = tessellateStroke(
				makeInput({ ...rightTurn, baseWidth: 20, lineJoin: "bevel" }),
			);
			expect(hasBodyVertexNear(right, 90, -10)).toBe(true);
			expect(hasBodyVertexNear(right, 100, -10)).toBe(false);
			expect(hasBodyVertexNear(right, 90, 0)).toBe(false);
		});

		it("should leave the bodies untrimmed when the inner intersection lies beyond a segment", () => {
			// The second segment is shorter than the inner offset reach.
			const result = tessellateStroke(
				makeInput({
					points: [0, 0, 100, 0, 100, 5],
					pressures: [1, 1, 1],
					baseWidth: 20,
					lineJoin: "bevel",
					lineCap: "butt",
				}),
			);
			expect(hasBodyVertexNear(result, 100, 10)).toBe(true);
			expect(hasBodyVertexNear(result, 90, 0)).toBe(true);
		});

		it("should emit the round fan on the outer side of the corner", () => {
			const result = tessellateStroke(
				makeInput({ ...leftTurn, baseWidth: 20, lineJoin: "round" }),
			);
			// Fan vertices lie on the outer quadrant of the hw=10 circle around
			// the corner: x > 100 and y < 0.
			const fan: Array<[number, number]> = [];
			for (let i = 0; i < result.count; i++) {
				const x = result.vertices[i * 2];
				const y = result.vertices[i * 2 + 1];
				if (x > 100 + 1e-6 && y < -1e-6) fan.push([x, y]);
			}
			expect(fan.length).toBeGreaterThan(0);
			for (const [x, y] of fan) {
				expect(Math.hypot(x - 100, y)).toBeCloseTo(10, 5);
			}
		});

		it("should keep the bevel corner chamfered between the strip edges", () => {
			const result = tessellateStroke(
				makeInput({ ...leftTurn, baseWidth: 20, lineJoin: "bevel" }),
			);
			expect(hasBodyVertexNear(result, 100, -10)).toBe(true);
			expect(hasBodyVertexNear(result, 110, 0)).toBe(true);
			expect(hasBodyVertexNear(result, 110, -10)).toBe(false);
		});
	});

	describe("adaptive arc subdivision", () => {
		const leftTurn = { points: [0, 0, 100, 0, 100, 100], pressures: [1, 1, 1] };

		it("should subdivide round joins finer as zoom increases", () => {
			expect(roundJoinFanVertexCount(8)).toBeGreaterThan(
				roundJoinFanVertexCount(1),
			);
		});

		it("should subdivide round joins finer for wider strokes", () => {
			expect(roundJoinFanVertexCount(1, 80)).toBeGreaterThan(
				roundJoinFanVertexCount(1, 8),
			);
		});

		it("should keep round join chords within the device-space error budget", () => {
			for (const zoom of [1, 4]) {
				const result = tessellateStroke(
					makeInput({ ...leftTurn, baseWidth: 20, lineJoin: "round", zoom }),
				);
				// Angular positions of the outer fan vertices (radius-10 circle
				// around the corner, outer quadrant including both arc ends).
				const angles: number[] = [];
				for (let i = 0; i < result.count; i++) {
					const dx = result.vertices[i * 2] - 100;
					const dy = result.vertices[i * 2 + 1];
					if (
						Math.abs(Math.hypot(dx, dy) - 10) < 1e-6 &&
						dx > -1e-6 &&
						dy < 1e-6
					) {
						angles.push(Math.atan2(dy, dx));
					}
				}
				const sorted = [
					...new Set(angles.map((a) => Number(a.toFixed(9)))),
				].toSorted((a, b) => a - b);
				expect(sorted.length).toBeGreaterThan(2);
				let maxGap = 0;
				for (let i = 1; i < sorted.length; i++) {
					maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
				}
				const sagitta = 10 * (1 - Math.cos(maxGap / 2));
				expect(sagitta).toBeLessThanOrEqual(0.25 / zoom + 1e-6);
			}
		});

		function roundJoinFanVertexCount(zoom: number, baseWidth = 20): number {
			const result = tessellateStroke(
				makeInput({ ...leftTurn, baseWidth, lineJoin: "round", zoom }),
			);
			let fan = 0;
			for (let i = 0; i < result.count; i++) {
				const x = result.vertices[i * 2];
				const y = result.vertices[i * 2 + 1];
				if (x > 100 + 1e-6 && y < -1e-6) fan++;
			}
			return fan;
		}
	});

	it("should produce more geometry for round joins than bevel joins", () => {
		const points = [0, 0, 100, 0, 100, 100];
		const pressures = [1, 1, 1];

		const bevel = tessellateStroke(
			makeInput({ points, pressures, lineJoin: "bevel", lineCap: "butt" }),
		);

		const round = tessellateStroke(
			makeInput({ points, pressures, lineJoin: "round", lineCap: "butt" }),
		);

		expect(round.count).toBeGreaterThan(bevel.count);
	});

	it("should fall back to bevel when miter limit is exceeded", () => {
		// Very sharp angle that exceeds miter limit
		const sharp = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0, 99, 1],
				pressures: [1, 1, 1],
				lineJoin: "miter",
				miterLimit: 1,
				lineCap: "butt",
			}),
		);

		const bevel = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0, 99, 1],
				pressures: [1, 1, 1],
				lineJoin: "bevel",
				lineCap: "butt",
			}),
		);

		// With miterLimit=1 on a sharp angle, miter should fall back to bevel
		expect(sharp.count).toBe(bevel.count);
	});

	it("should produce variable width segments with pressure", () => {
		const uniform = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				baseWidth: 20,
				sizeByPressure: 0,
			}),
		);

		const variable = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 0.5],
				baseWidth: 20,
				sizeByPressure: 1,
			}),
		);

		// Both should produce 2 triangles (same topology)
		expect(uniform.count).toBe(variable.count);

		// But the vertex positions differ: variable width tapers
		// Uniform half-width at both ends = 10
		// Variable: start hw = 20*0.5*(1 - 1*(1-1)) = 10
		//           end hw = 20*0.5*(1 - 1*(1-0.5)) = 5
		expect(uniform.vertices).not.toEqual(variable.vertices);
	});

	it("should produce no caps for closed paths", () => {
		// Triangle path
		const open = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0, 50, 100],
				pressures: [1, 1, 1],
				isClosed: false,
				lineCap: "round",
				lineJoin: "bevel",
			}),
		);

		const closed = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0, 50, 100],
				pressures: [1, 1, 1],
				isClosed: true,
				lineCap: "round",
				lineJoin: "bevel",
			}),
		);

		// Closed path: no caps but extra closing join
		// Open: 2 body segments (4 tri) + 1 join (1 tri) + 2 round caps (many tri)
		// Closed: 2 body segments (4 tri) + 2 joins (2 tri, closing the path) + 0 caps
		// Closed should have fewer vertices than open with round caps
		expect(closed.count).toBeLessThan(open.count);
	});

	it("should skip zero-length segments", () => {
		const result = tessellateStroke(
			makeInput({
				// Three points but second and third are the same
				points: [0, 0, 100, 0, 100, 0],
				pressures: [1, 1, 1],
				lineCap: "butt",
			}),
		);

		// Only one valid segment (0,0 → 100,0), zero-length (100,0 → 100,0) skipped
		expect(result.count).toBe(6); // 2 triangles × 3 vertices
	});

	it("should produce valid winding order (all CCW triangles)", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0, 100, 100, 0, 100],
				pressures: [1, 1, 1, 1],
				lineJoin: "miter",
				lineCap: "butt",
			}),
		);

		const verts = result.vertices;
		for (let i = 0; i < verts.length; i += 6) {
			const ax = verts[i];
			const ay = verts[i + 1];
			const bx = verts[i + 2];
			const by = verts[i + 3];
			const cx = verts[i + 4];
			const cy = verts[i + 5];
			const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
			expect(cross).toBeGreaterThanOrEqual(0);
		}
	});

	it("should render signed asymmetric widths around their shifted center", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				baseWidth: 20,
				strokeWidths: [
					{ t: 0, side1: 1, side2: -0.5 },
					{ t: 1, side1: 1, side2: -0.5 },
				],
			}),
		);

		const yValues = result.vertices.filter((_, index) => index % 2 === 1);
		expect(Math.min(...yValues)).toBeCloseTo(5, 5);
		expect(Math.max(...yValues)).toBeCloseTo(10, 5);
		expect(result.vertices.every(Number.isFinite)).toBe(true);
	});

	it("should omit a stroke whose signed half width is non-positive", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				strokeWidths: [
					{ t: 0, side1: 1, side2: -1 },
					{ t: 1, side1: 1, side2: -1 },
				],
			}),
		);

		expect(result.count).toBe(0);
	});

	it("should split visible regions at interpolated zero crossings", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				lineCap: "round",
				strokeWidths: [{ t: 0.5, side1: -1, side2: -1 }],
			}),
		);

		expect(result.count).toBeGreaterThan(0);
		expectTrianglesDoNotCrossXGap(result.vertices, 25, 75);
	});

	it("should split a curved polyline without bridging its invisible region", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 50, 50, 100, 0],
				pressures: [1, 1, 1],
				lineJoin: "round",
				strokeWidths: [{ t: 0.5, side1: -1, side2: -1 }],
			}),
		);

		expect(result.vertices.every(Number.isFinite)).toBe(true);
		expectTrianglesDoNotCrossXGap(result.vertices, 25, 75);
	});

	it("should keep joins and caps finite when one signed side is negative", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 50, 0, 50, 50],
				pressures: [1, 1, 1],
				lineCap: "round",
				lineJoin: "round",
				strokeWidths: [
					{ t: 0, side1: 1, side2: -0.5 },
					{ t: 1, side1: 1, side2: -0.5 },
				],
			}),
		);

		expect(result.count).toBeGreaterThan(12);
		expect(result.vertices.every(Number.isFinite)).toBe(true);
	});

	it("should keep a signed asymmetric closed-path seam continuous", () => {
		const input = makeInput({
			points: [0, 0, 100, 0, 100, 100, 0, 100, 0, 0],
			pressures: [1, 1, 1, 1, 1],
			baseWidth: 20,
			isClosed: true,
			lineCap: "round",
			lineJoin: "round",
			strokeWidths: [
				{ t: 0, side1: 1, side2: -0.5 },
				{ t: 1, side1: 1, side2: -0.5 },
			],
		});
		const result = tessellateStroke(input);
		const buttResult = tessellateStroke({ ...input, lineCap: "butt" });

		// The closing body's end and the first body's start meet at the inner
		// offset intersection, so the seam has no gap.
		const firstStart = getBodySegmentEndpoints(result.vertices, 0, 0, 0);
		const closingEnd = getBodySegmentEndpoints(result.vertices, 3, 0, 0);
		const shared = firstStart.filter((a) =>
			closingEnd.some((b) => a.x === b.x && a.y === b.y),
		);

		expect(shared).toHaveLength(1);
		expect(result.count).toBeGreaterThan(0);
		expect(result.vertices.every(Number.isFinite)).toBe(true);
		expect(result).toEqual(buttResult);
	});
});

describe("tessellateStroke taper", () => {
	// Straight 3-point line so a mid point exists between the taper zones
	const points = [0, 0, 50, 0, 100, 0];
	const pressures = [1, 1, 1];

	it("should shrink endpoint widths to ~0 while keeping the middle intact", () => {
		const result = tessellateStroke(
			makeInput({
				points,
				pressures,
				baseWidth: 10,
				taperStart: 20,
				taperEnd: 20,
			}),
		);

		// Endpoint vertices (x≈0 and x≈100) collapse onto the centerline
		const verts = result.vertices;
		let maxAbsY = 0;
		for (let i = 0; i < verts.length; i += 2) {
			const x = verts[i];
			const y = verts[i + 1];
			if (Math.abs(x) < 1e-6 || Math.abs(x - 100) < 1e-6) {
				expect(Math.abs(y)).toBeLessThan(1e-6);
			}
			maxAbsY = Math.max(maxAbsY, Math.abs(y));
		}
		// Mid point (arc dist 50, beyond both 20-unit tapers) keeps full half-width
		expect(maxAbsY).toBeCloseTo(5, 5);
	});

	it("should deep-equal the baseline when taper is 0 or undefined", () => {
		const baseline = tessellateStroke(makeInput({ points, pressures }));
		const zero = tessellateStroke(
			makeInput({ points, pressures, taperStart: 0, taperEnd: 0 }),
		);
		const explicitUndefined = tessellateStroke(
			makeInput({
				points,
				pressures,
				taperStart: undefined,
				taperEnd: undefined,
			}),
		);

		expect(zero).toEqual(baseline);
		expect(explicitUndefined).toEqual(baseline);
	});

	it("should not shrink the start when pathStart is 0.5 (mid-stroke fragment)", () => {
		const baseline = tessellateStroke(makeInput({ points, pressures }));
		const suppressed = tessellateStroke(
			makeInput({ points, pressures, taperStart: 20, pathStart: 0.5 }),
		);

		expect(suppressed).toEqual(baseline);
	});
});

describe("applyDashPattern", () => {
	it("should return input as-is for empty dashArray", () => {
		const points = [0, 0, 100, 0];
		const pressures = [1, 1];
		const result = applyDashPattern(points, pressures, [], 0);

		expect(result).toHaveLength(1);
		expect(result[0].points).toEqual(points);
		expect(result[0].pressures).toEqual(pressures);
	});

	it("should return input as-is for all-zero dashArray", () => {
		const points = [0, 0, 100, 0];
		const pressures = [1, 1];
		const result = applyDashPattern(points, pressures, [0, 0], 0);

		expect(result).toHaveLength(1);
		expect(result[0].points).toEqual(points);
	});

	it("should split a horizontal line into equal dashes", () => {
		// 100-unit line with [10, 10] pattern → 5 dashes of 10 units each
		const points = [0, 0, 100, 0];
		const pressures = [1, 1];
		const result = applyDashPattern(points, pressures, [10, 10], 0);

		expect(result).toHaveLength(5);

		for (const sub of result) {
			const startX = sub.points[0];
			const endX = sub.points[sub.points.length - 2];
			expect(endX - startX).toBeCloseTo(10, 5);
		}
	});

	it("should double odd-length dashArray per SVG spec", () => {
		// [10] → [10, 10] → same as above
		const points = [0, 0, 100, 0];
		const pressures = [1, 1];
		const result = applyDashPattern(points, pressures, [10], 0);

		expect(result).toHaveLength(5);
	});

	it("should apply dashOffset correctly", () => {
		// 100-unit line, [20, 10] pattern, offset 5
		// First dash starts at 0, offset=5 means 15 units of first dash remain
		const points = [0, 0, 100, 0];
		const pressures = [1, 1];
		const result = applyDashPattern(points, pressures, [20, 10], 5);

		// First dash: 15 units (20-5), then gap 10, dash 20, gap 10, dash 20, gap 10, dash 15 (partial)
		expect(result.length).toBeGreaterThanOrEqual(3);

		// First dash should start at x=0 and end at x=15
		expect(result[0].points[0]).toBeCloseTo(0);
		expect(result[0].points[result[0].points.length - 2]).toBeCloseTo(15, 5);
	});

	it("should interpolate pressure at dash boundaries", () => {
		// 100-unit line, pressure goes from 0 at start to 1 at end
		const points = [0, 0, 100, 0];
		const pressures = [0, 1];
		const result = applyDashPattern(points, pressures, [50, 50], 0);

		// One dash from 0 to 50
		expect(result).toHaveLength(1);

		// End pressure should be ~0.5 (interpolated at 50% of 100)
		const endPressure = result[0].pressures[result[0].pressures.length - 1];
		expect(endPressure).toBeCloseTo(0.5, 5);
	});

	it("should handle zero-length gaps as continuous line", () => {
		const points = [0, 0, 100, 0];
		const pressures = [1, 1];
		const result = applyDashPattern(points, pressures, [10, 0], 0);

		// Zero-length gaps don't interrupt: single continuous output
		expect(result).toHaveLength(1);
	});

	it("should handle multi-segment polylines", () => {
		// L-shaped path: 100 right, then 100 up, total length 200
		const points = [0, 0, 100, 0, 100, 100];
		const pressures = [1, 1, 1];
		const result = applyDashPattern(points, pressures, [30, 20], 0);

		// Total length 200, pattern length 50 → 4 complete cycles → 4 dashes
		expect(result).toHaveLength(4);
	});

	it("should handle negative dashOffset", () => {
		const points = [0, 0, 100, 0];
		const pressures = [1, 1];
		// dashOffset -5 with pattern [20, 10] (total 30)
		// Normalized: -5 mod 30 = 25
		const result = applyDashPattern(points, pressures, [20, 10], -5);
		const resultPositive = applyDashPattern(points, pressures, [20, 10], 25);

		// Should produce the same result as offset 25
		expect(result.length).toBe(resultPositive.length);
	});

	it("should produce more total vertices with dash than without when tessellated", () => {
		const points = [0, 0, 200, 0];
		const pressures = [1, 1];

		const solidResult = tessellateStroke(
			makeInput({ points, pressures, lineCap: "round" }),
		);

		const dashes = applyDashPattern(points, pressures, [20, 10], 0);
		let dashVertexCount = 0;
		for (const dash of dashes) {
			const r = tessellateStroke(
				makeInput({
					points: dash.points,
					pressures: dash.pressures,
					lineCap: "round",
				}),
			);
			dashVertexCount += r.count;
		}

		// Dashed stroke has many more caps → more vertices
		expect(dashVertexCount).toBeGreaterThan(solidResult.count);
	});
});

function hasBodyVertexNear(
	result: { vertices: number[]; count: number },
	x: number,
	y: number,
): boolean {
	for (let i = 0; i < result.count; i++) {
		if (
			Math.hypot(result.vertices[i * 2] - x, result.vertices[i * 2 + 1] - y) <
			1e-6
		) {
			return true;
		}
	}
	return false;
}

function expectTrianglesDoNotCrossXGap(
	vertices: number[],
	gapStart: number,
	gapEnd: number,
): void {
	for (let index = 0; index < vertices.length; index += 6) {
		const xs = [vertices[index], vertices[index + 2], vertices[index + 4]];
		expect(Math.min(...xs) < gapStart && Math.max(...xs) > gapEnd).toBe(false);
	}
}

/** The two body corners of a segment nearest to a target point. */
function getBodySegmentEndpoints(
	vertices: number[],
	segmentIndex: number,
	targetX: number,
	targetY: number,
): { x: number; y: number }[] {
	const offset = segmentIndex * 12;
	const uniqueVertices = new Map<string, { x: number; y: number }>();
	for (let index = offset; index < offset + 12; index += 2) {
		const point = { x: vertices[index], y: vertices[index + 1] };
		uniqueVertices.set(`${point.x},${point.y}`, point);
	}
	return [...uniqueVertices.values()]
		.toSorted(
			(a, b) =>
				Math.hypot(a.x - targetX, a.y - targetY) -
				Math.hypot(b.x - targetX, b.y - targetY),
		)
		.slice(0, 2);
}

describe("applyDashPattern arc offsets", () => {
	it("should report each dash's start arc length within the polyline", () => {
		const result = applyDashPattern([0, 0, 100, 0], [1, 1], [30, 20], 0);

		expect(result.map(({ arcOffset }) => arcOffset)).toEqual([0, 50]);
	});

	it("should offset the first dash start when dashOffset shifts the pattern", () => {
		const result = applyDashPattern([0, 0, 100, 0], [1, 1], [30, 20], 10);

		expect(result.map(({ arcOffset }) => arcOffset)).toEqual([0, 40, 90]);
	});
});

describe("tessellateStroke gradient params", () => {
	it("should not emit params when arcParams is absent", () => {
		const result = tessellateStroke(
			makeInput({ points: [0, 0, 100, 0], pressures: [1, 1] }),
		);

		expect(result.vertexParams).toEqual([]);
	});

	it("should emit one (t, u) pair per vertex when arcParams is requested", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				arcParams: { arcOffset: 0, totalArcLength: 100 },
			}),
		);

		expect(result.count).toBeGreaterThan(0);
		expect(result.vertexParams.length).toBe(result.count * 2);
	});

	it("should map t from the arc ratio and u from the stroke side", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				arcParams: { arcOffset: 0, totalArcLength: 100 },
			}),
		);

		for (let i = 0; i < result.vertices.length; i += 2) {
			const x = result.vertices[i];
			const y = result.vertices[i + 1];
			const pi = i;
			expect(result.vertexParams[pi]).toBeCloseTo(x / 100, 5);
			expect(result.vertexParams[pi + 1]).toBeCloseTo(y > 0 ? 1 : 0, 5);
		}
	});

	it("should keep dash sub-polylines' t continuous with the whole stroke", () => {
		const dashes = applyDashPattern([0, 0, 100, 0], [1, 1], [30, 20], 0);
		const second = dashes[1];
		const result = tessellateStroke(
			makeInput({
				points: second.points,
				pressures: second.pressures,
				arcParams: { arcOffset: second.arcOffset, totalArcLength: 100 },
			}),
		);

		const ts: number[] = [];
		for (let i = 0; i < result.vertexParams.length; i += 2) {
			ts.push(result.vertexParams[i]);
		}
		expect(Math.min(...ts)).toBeCloseTo(0.5, 5);
		expect(Math.max(...ts)).toBeCloseTo(0.8, 5);
	});

	it("should remap t into the pathStart..pathEnd fragment range", () => {
		const result = tessellateStroke(
			makeInput({
				points: [0, 0, 100, 0],
				pressures: [1, 1],
				pathStart: 0.25,
				pathEnd: 0.75,
				arcParams: { arcOffset: 0, totalArcLength: 100 },
			}),
		);

		const ts: number[] = [];
		for (let i = 0; i < result.vertexParams.length; i += 2) {
			ts.push(result.vertexParams[i]);
		}
		expect(Math.min(...ts)).toBeCloseTo(0.25, 5);
		expect(Math.max(...ts)).toBeCloseTo(0.75, 5);
	});
});

function coversPoint(vertices: number[], x: number, y: number): boolean {
	for (let i = 0; i < vertices.length; i += 6) {
		const crosses = [0, 2, 4].map((offset, index) => {
			const next = ((index + 1) % 3) * 2;
			return (
				(vertices[i + next] - vertices[i + offset]) *
					(y - vertices[i + offset + 1]) -
				(vertices[i + next + 1] - vertices[i + offset + 1]) *
					(x - vertices[i + offset])
			);
		});
		if (
			crosses.every((value) => value >= -1e-10) ||
			crosses.every((value) => value <= 1e-10)
		)
			return true;
	}
	return false;
}

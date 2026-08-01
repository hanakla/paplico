import { describe, expect, it } from "vitest";
import {
	BEZIER_INSTANCE_FLOATS,
	FILL_TRIANGLE_INSTANCE_FLOATS,
	type LoweredRun,
	LoweringScratch,
	lowerScene,
	type OverlayGroup,
} from "./lowering";
import type { UIPrimitive } from "./primitives";
import type { RGBA } from "./theme";

const RED: RGBA = [1, 0, 0, 1];
const GREEN: RGBA = [0, 1, 0, 1];
const BLUE: RGBA = [0, 0, 1, 1];

describe("lowering", () => {
	describe("stroke width resolution", () => {
		it("should resolve screen stroke widths with the AA-compensated (px+1)/2/zoom formula", () => {
			const out = lower(
				[line(0, 0, 10, 0, { stroke: { color: RED, width: 1.5 } })],
				2,
			);
			expect(out.length).toBe(BEZIER_INSTANCE_FLOATS);
			expect(out[12]).toBe((1.5 + 1) / 2 / 2);
			expect(out[13]).toBe((1.5 + 1) / 2 / 2);
		});

		it("should resolve world stroke widths as exact half-width without AA padding", () => {
			const out = lower([
				line(0, 0, 10, 0, { stroke: { color: RED, width: { world: 44 } } }),
			]);
			expect(out[12]).toBe(22);
			expect(out[13]).toBe(22);
		});

		it("should resolve line fill widths as exact size (px/zoom) without AA padding", () => {
			const out = lower(
				[line(0, 0, 10, 0, { fill: { color: RED, width: { screen: 2 } } })],
				2,
			);
			// halfWidth = (2 / zoom) / 2 = 0.5
			expect(out[12]).toBe(0.5);
		});
	});

	describe("size Dim resolution", () => {
		it("should sum world and screen components (screen divided by zoom)", () => {
			const out = lower(
				[
					{
						kind: "circle",
						cx: 0,
						cy: 0,
						radius: { world: 48, screen: 0.5 },
						stroke: { color: RED, width: 1.5 },
					},
				],
				2,
			);
			// 4 quarter arcs; instance 0 starts at (cx + radius, cy)
			expect(out.length).toBe(4 * BEZIER_INSTANCE_FLOATS);
			expect(out[0]).toBe(48.25);
			expect(out[1]).toBe(0);
		});

		it("should apply screenOffset divided by zoom along world axes", () => {
			const out = lower(
				[
					line(0, 0, 10, 0, {
						screenOffset: { x: 2, y: 4 },
						stroke: { color: RED, width: 1 },
					}),
				],
				2,
			);
			expect(out[0]).toBe(1);
			expect(out[1]).toBe(2);
			expect(out[6]).toBe(11);
			expect(out[7]).toBe(2);
		});
	});

	describe("circle lowering", () => {
		it("should triangulate a filled circle without overlapping stroke bands", () => {
			const { fills, runs, strokes } = lowerAll(
				[
					{
						kind: "circle",
						cx: 0,
						cy: 0,
						radius: 10,
						fill: { color: RED },
					},
				],
				2,
			);

			expect(strokes.length).toBe(0);
			expect(fills.length).toBeGreaterThan(0);
			expect(runs).toEqual([
				{ kind: "fill", firstInstance: 0, instanceCount: fills.length / 11 },
			]);
			expect(fillArea(fills)).toBeGreaterThan(Math.PI * 100 * 0.99);
			expect(fillArea(fills)).toBeLessThanOrEqual(Math.PI * 100);
		});
	});

	describe("rounded rect lowering", () => {
		it("should cut the corners of a filled rect when cornerRadius is set", () => {
			const sharp = lowerAll(
				[
					{
						kind: "rect",
						cx: 0,
						cy: 0,
						width: 40,
						height: 20,
						fill: { color: RED },
					},
				],
				2,
			);
			const rounded = lowerAll(
				[
					{
						kind: "rect",
						cx: 0,
						cy: 0,
						width: 40,
						height: 20,
						cornerRadius: 10,
						fill: { color: RED },
					},
				],
				2,
			);

			// Sharp rect = 40 x 20. Rounded corners (r=10) cut 4*(1 - pi/4)*r^2 ~= 86.
			expect(fillArea(sharp.fills)).toBeCloseTo(800, 0);
			expect(fillArea(rounded.fills)).toBeLessThan(780);
			expect(fillArea(rounded.fills)).toBeGreaterThan(690);
		});
	});

	describe("arc lowering", () => {
		const K = 0.5522847498;

		it("should lower a full circle sweep to 4 quarter-arc cubics", () => {
			const out = lower([arc(100, 0, Math.PI * 2)]);
			expect(out.length).toBe(4 * BEZIER_INSTANCE_FLOATS);
			// Quarter 1: right → top
			expect(out[0]).toBe(100); // p0.x
			expect(out[1]).toBe(0); // p0.y
			expect(out[2]).toBe(100); // cp1.x
			expect(out[3]).toBeCloseTo(K * 100, 4); // cp1.y
			expect(out[4]).toBeCloseTo(K * 100, 4); // cp2.x
			expect(out[5]).toBe(100); // cp2.y
			expect(out[6]).toBe(0); // p1.x
			expect(out[7]).toBe(100); // p1.y
		});

		it("should lower a 90° arc to a single cubic with k = 4/3·tan(θ/4)", () => {
			const out = lower([arc(100, 0, Math.PI / 2)]);
			expect(out.length).toBe(BEZIER_INSTANCE_FLOATS);
			const k = (4 / 3) * Math.tan(Math.PI / 8);
			expect(out[0]).toBe(100);
			expect(out[1]).toBe(0);
			expect(out[2]).toBeCloseTo(100, 4);
			expect(out[3]).toBeCloseTo(k * 100, 4);
			expect(out[4]).toBeCloseTo(k * 100, 4);
			expect(out[5]).toBeCloseTo(100, 4);
			expect(out[6]).toBeCloseTo(0, 4);
			expect(out[7]).toBeCloseTo(100, 4);
		});

		it("should lower an arbitrary sweep with endpoints on the arc", () => {
			const sweep = Math.PI / 3; // 60°
			const out = lower([arc(100, 0, sweep)]);
			expect(out.length).toBe(BEZIER_INSTANCE_FLOATS);
			const k = (4 / 3) * Math.tan(sweep / 4);
			expect(out[0]).toBe(100);
			expect(out[1]).toBe(0);
			// cp1 = p0 + k·tangent(0) = (100, k·100)
			expect(out[2]).toBeCloseTo(100, 4);
			expect(out[3]).toBeCloseTo(k * 100, 4);
			// cp2 = p1 − k·tangent(60°)
			expect(out[4]).toBeCloseTo(
				Math.cos(sweep) * 100 + k * Math.sin(sweep) * 100,
				4,
			);
			expect(out[5]).toBeCloseTo(
				Math.sin(sweep) * 100 - k * Math.cos(sweep) * 100,
				4,
			);
			expect(out[6]).toBeCloseTo(Math.cos(sweep) * 100, 4);
			expect(out[7]).toBeCloseTo(Math.sin(sweep) * 100, 4);
		});

		it("should split sweeps over 90° into multiple segments", () => {
			const out = lower([arc(100, 0, Math.PI)]);
			expect(out.length).toBe(2 * BEZIER_INSTANCE_FLOATS);
			// Second segment ends at 180°
			expect(out[BEZIER_INSTANCE_FLOATS + 6]).toBeCloseTo(-100, 4);
			expect(out[BEZIER_INSTANCE_FLOATS + 7]).toBeCloseTo(0, 4);
		});

		it("should apply ellipse radii and rotation to control points", () => {
			const rotation = 0.4;
			const out = lower([
				{
					kind: "arc",
					cx: 10,
					cy: -5,
					radiusX: 60,
					radiusY: 25,
					rotation,
					startAngle: 0,
					endAngle: Math.PI * 2,
					stroke: { color: RED, width: 1.5 },
				},
			]);
			expect(out.length).toBe(4 * BEZIER_INSTANCE_FLOATS);
			// p0 = center + rotate((rx, 0))
			expect(out[0]).toBeCloseTo(10 + 60 * Math.cos(rotation), 4);
			expect(out[1]).toBeCloseTo(-5 + 60 * Math.sin(rotation), 4);
			// Quarter 1 ends at top: center + rotate((0, ry))
			expect(out[6]).toBeCloseTo(10 - 25 * Math.sin(rotation), 4);
			expect(out[7]).toBeCloseTo(-5 + 25 * Math.cos(rotation), 4);
		});
	});

	describe("diamond lowering", () => {
		it("should triangulate a fill into two non-overlapping triangles", () => {
			const { fills, strokes } = lowerAll([
				{
					kind: "diamond",
					cx: 5,
					cy: 7,
					halfSize: 3,
					fill: { color: RED },
				},
			]);
			expect(strokes.length).toBe(0);
			expect(fills.length).toBe(2 * FILL_TRIANGLE_INSTANCE_FLOATS);
			expect(fillArea(fills)).toBe(18);
		});

		it("should lower a stroke to four edge lines (top→right→bottom→left)", () => {
			const out = lower([
				{
					kind: "diamond",
					cx: 0,
					cy: 0,
					halfSize: 2,
					stroke: { color: RED, width: { world: 1 } },
				},
			]);
			expect(out.length).toBe(4 * BEZIER_INSTANCE_FLOATS);
			// First edge: top (0, 2) → right (2, 0)
			expect([out[0], out[1], out[6], out[7]]).toEqual([0, 2, 2, 0]);
			// Last edge: left (-2, 0) → top (0, 2)
			const o4 = 3 * BEZIER_INSTANCE_FLOATS;
			expect([out[o4], out[o4 + 1], out[o4 + 6], out[o4 + 7]]).toEqual([
				-2, 0, 0, 2,
			]);
		});
	});

	describe("rect dash lowering", () => {
		it("should split each edge into dash segments clipped to the edge end", () => {
			// 10x10 rect, dash 3 + gap 2 (period 5) at zoom 1 → 2 dashes per edge.
			const out = lower([
				{
					kind: "rect",
					cx: 5,
					cy: 5,
					width: { world: 10 },
					height: { world: 10 },
					stroke: {
						color: RED,
						width: { world: 1 },
						dash: { length: 3, gap: 2 },
					},
				},
			]);
			expect(out.length).toBe(8 * BEZIER_INSTANCE_FLOATS);
			// First edge (top, left→right at y=10): dashes [0,3] and [5,8].
			expect([out[0], out[1], out[6], out[7]]).toEqual([0, 10, 3, 10]);
			const o2 = BEZIER_INSTANCE_FLOATS;
			expect([out[o2], out[o2 + 1], out[o2 + 6], out[o2 + 7]]).toEqual([
				5, 10, 8, 10,
			]);
		});

		it("should render solid when no dash is set", () => {
			const out = lower([
				{
					kind: "rect",
					cx: 0,
					cy: 0,
					width: { world: 4 },
					height: { world: 4 },
					stroke: { color: RED, width: { world: 1 } },
				},
			]);
			expect(out.length).toBe(4 * BEZIER_INSTANCE_FLOATS);
		});
	});

	describe("arrow lowering", () => {
		it("should emit a stroke shaft followed by a filled triangle head", () => {
			const { fills, runs, strokes } = lowerAll([
				{
					kind: "arrow",
					x1: 0,
					y1: 0,
					x2: 10,
					y2: 0,
					color: RED,
					width: { world: 2 },
					headLength: 4,
					headWidth: 6,
				},
			]);
			expect(strokes.length).toBe(BEZIER_INSTANCE_FLOATS);
			// Shaft: tail → head base, halfWidth = 1
			expect([strokes[0], strokes[1], strokes[6], strokes[7]]).toEqual([
				0, 0, 6, 0,
			]);
			expect(strokes[12]).toBe(1);
			expect(strokes[13]).toBe(1);
			expect(fills.length).toBe(FILL_TRIANGLE_INSTANCE_FLOATS);
			expect(fillArea(fills)).toBe(12);
			expect(runs).toEqual([
				{ kind: "stroke", firstInstance: 0, instanceCount: 1 },
				{ kind: "fill", firstInstance: 0, instanceCount: 1 },
			]);
		});

		it("should emit nothing for a zero-length arrow", () => {
			const out = lower([
				{
					kind: "arrow",
					x1: 5,
					y1: 5,
					x2: 5,
					y2: 5,
					color: RED,
					width: 1,
					headLength: 4,
					headWidth: 6,
				},
			]);
			expect(out.length).toBe(0);
		});
	});

	describe("bezier fill lowering", () => {
		it("should triangulate a closed fill without emitting a stroke", () => {
			const { fills, runs, strokes } = lowerAll([
				{
					kind: "bezierPath",
					closed: true,
					fill: { color: RED },
					segments: [
						straightBezier(0, 0, 10, 0),
						straightBezier(10, 0, 10, 10),
						straightBezier(10, 10, 0, 10),
						straightBezier(0, 10, 0, 0),
					],
				},
			]);

			expect(strokes.length).toBe(0);
			expect(fills.length).toBe(2 * FILL_TRIANGLE_INSTANCE_FLOATS);
			expect(fillArea(fills)).toBe(100);
			expect(runs).toEqual([
				{ kind: "fill", firstInstance: 0, instanceCount: 2 },
			]);
		});
	});

	describe("hitOnly primitives", () => {
		it("should exclude hitOnly primitives from the lowered instance stream", () => {
			const out = lower([
				{ ...colorLine(RED), hitOnly: true, hitId: "hit-only" },
				colorLine(GREEN),
			]);
			expect(out.length).toBe(BEZIER_INSTANCE_FLOATS);
			expect(instanceColor(out, 0)).toEqual(GREEN);
		});
	});

	describe("z ordering", () => {
		it("should retain painter order across fill and stroke runs", () => {
			const { runs } = lowerAll([
				colorLine(RED),
				{
					kind: "rect",
					cx: 0,
					cy: 0,
					width: 10,
					height: 10,
					fill: { color: GREEN },
					stroke: { color: BLUE, width: 1 },
				},
			]);
			expect(runs.map(({ kind }) => kind)).toEqual([
				"stroke",
				"fill",
				"stroke",
			]);
		});

		it("should order groups by base z regardless of push order", () => {
			const out = lowerGroups([
				{ z: 10, prims: [colorLine(RED)] },
				{ z: 0, prims: [colorLine(GREEN)] },
			]);
			expect(instanceColor(out, 0)).toEqual(GREEN);
			expect(instanceColor(out, 1)).toEqual(RED);
		});

		it("should apply primitive zIndex as an offset within the group", () => {
			const out = lowerGroups([
				{
					z: 0,
					prims: [{ ...colorLine(RED), zIndex: 5 }, colorLine(GREEN)],
				},
			]);
			expect(instanceColor(out, 0)).toEqual(GREEN);
			expect(instanceColor(out, 1)).toEqual(RED);
		});

		it("should keep insertion order for equal z (stable sort)", () => {
			const out = lowerGroups([
				{ z: 0, prims: [colorLine(RED), colorLine(GREEN)] },
				{ z: 0, prims: [colorLine(BLUE)] },
			]);
			expect(instanceColor(out, 0)).toEqual(RED);
			expect(instanceColor(out, 1)).toEqual(GREEN);
			expect(instanceColor(out, 2)).toEqual(BLUE);
		});
	});
});

// --- Test helpers ---

function lower(prims: UIPrimitive[], zoom = 1): Float32Array {
	return lowerGroups([{ z: 0, prims }], zoom);
}

function lowerGroups(groups: OverlayGroup[], zoom = 1): Float32Array {
	return lowerAllGroups(groups, zoom).strokes;
}

function lowerAll(prims: UIPrimitive[], zoom = 1) {
	return lowerAllGroups([{ z: 0, prims }], zoom);
}

function lowerAllGroups(
	groups: OverlayGroup[],
	zoom = 1,
): {
	fills: Float32Array;
	runs: LoweredRun[];
	strokes: Float32Array;
} {
	const scratch = new LoweringScratch();
	lowerScene(groups, zoom, scratch);
	return {
		fills: scratch.fills.view.slice(),
		runs: scratch.runs.map((run) => ({ ...run })),
		strokes: scratch.strokes.view.slice(),
	};
}

function line(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	rest: Partial<Extract<UIPrimitive, { kind: "line" }>>,
): UIPrimitive {
	return { kind: "line", x1, y1, x2, y2, ...rest };
}

function colorLine(color: RGBA): UIPrimitive {
	return line(0, 0, 1, 0, { stroke: { color, width: 1 } });
}

function arc(radius: number, startAngle: number, endAngle: number) {
	return {
		kind: "arc",
		cx: 0,
		cy: 0,
		radiusX: radius,
		startAngle,
		endAngle,
		stroke: { color: RED, width: 1.5 },
	} satisfies UIPrimitive;
}

function instanceColor(out: Float32Array, index: number): RGBA {
	const base = index * BEZIER_INSTANCE_FLOATS;
	return [out[base + 8], out[base + 9], out[base + 10], out[base + 11]];
}

function straightBezier(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
) {
	return {
		start: { x: startX, y: startY },
		cp1: { x: startX, y: startY },
		cp2: { x: endX, y: endY },
		end: { x: endX, y: endY },
	};
}

function fillArea(out: Float32Array): number {
	let area = 0;
	for (
		let offset = 0;
		offset < out.length;
		offset += FILL_TRIANGLE_INSTANCE_FLOATS
	) {
		area +=
			Math.abs(
				(out[offset + 2] - out[offset]) * (out[offset + 5] - out[offset + 1]) -
					(out[offset + 4] - out[offset]) * (out[offset + 3] - out[offset + 1]),
			) / 2;
	}
	return area;
}

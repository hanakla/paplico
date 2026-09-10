import { describe, expect, it } from "vitest";
import type { CubicBezierSegment, PathSegment } from "../../schema";
import { applyCornerRadius } from "./CornerRadiusProcessor";

/**
 * Creates a closed rectangle using the same structure as ShapeTool's createClosedPolygonSegments.
 * Vertices: TL(0,100) TR(100,100) BR(100,0) BL(0,0) in world coords (Y-up).
 * Edge length = 100.
 */
function makeRectSegments(): CubicBezierSegment[] {
	const vertices = [
		{ x: 0, y: 100 }, // TL
		{ x: 100, y: 100 }, // TR
		{ x: 100, y: 0 }, // BR
		{ x: 0, y: 0 }, // BL
	];

	const segments: CubicBezierSegment[] = [];
	for (let i = 0; i < vertices.length; i++) {
		const p1 = vertices[i];
		const p2 = vertices[(i + 1) % vertices.length];
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;
		segments.push({
			start: i === 0 ? p1 : undefined,
			cp1: { x: dx * 0.33, y: dy * 0.33 },
			cp2: { x: -dx * 0.33, y: -dy * 0.33 },
			end: p2,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
			isClosed: i === vertices.length - 1 || undefined,
		});
	}
	return segments;
}

/** Set cornerRadius (and optionally cornerSuperellipseK) on specified segment indices. */
function withCornerRadius(
	segments: CubicBezierSegment[],
	indices: number[],
	radius: number,
	k?: number,
): CubicBezierSegment[] {
	return segments.map((seg, i) => {
		if (indices.includes(i)) {
			const ext: Record<string, unknown> = { cornerRadius: radius };
			if (k !== undefined) ext.cornerSuperellipseN = k;
			return { ...seg, ...ext } as CubicBezierSegment;
		}
		return seg;
	});
}

describe("CornerRadiusProcessor", () => {
	describe("applyCornerRadius", () => {
		it("returns same reference when no cornerRadius is set", () => {
			const segs = makeRectSegments();
			const result = applyCornerRadius(segs);
			expect(result).toBe(segs);
		});

		it("adds fillet for a single vertex (seg count increases by 1)", () => {
			// seg[0].end = TR vertex gets cornerRadius
			const segs = withCornerRadius(makeRectSegments(), [0], 10);
			const result = applyCornerRadius(segs);
			// Original 4 segs -> seg[0] trimmed + fillet + seg[1] trimmed + seg[2] + seg[3] = 5
			expect(result.length).toBe(5);
		});

		it("adds fillets for all 4 vertices of closed rectangle", () => {
			const segs = withCornerRadius(makeRectSegments(), [0, 1, 2, 3], 10);
			const result = applyCornerRadius(segs);
			// 4 vertices x (trimmed + fillet) = 8 segments
			expect(result.length).toBe(8);
		});

		it("handles closed path wrap-around vertex (last seg -> first seg)", () => {
			// seg[3] has cornerRadius -> seg[3].end = TL vertex (wraps to seg[0])
			const segs = withCornerRadius(makeRectSegments(), [3], 10);
			const result = applyCornerRadius(segs);
			// Wrap-around fillet: seg[0] start-trimmed + seg[1] + seg[2] + seg[3] end-trimmed + fillet = 5
			expect(result.length).toBe(5);
		});

		it("does not let one vertex's fillet distort another vertex's shape", () => {
			// Set cornerRadius on seg[0] (TR) and seg[2] (BL), radius=40
			// Edge length=100, so maxRadius=min(40, 50, 50)=40
			const segs = withCornerRadius(makeRectSegments(), [0, 2], 40);
			const result = applyCornerRadius(segs);

			// 2 fillets -> 4 + 2 = 6 segments
			expect(result.length).toBe(6);
		});

		it("clamps radius to chord_length / 2", () => {
			// Edge length=100, so maxRadius = min(60, 50, 50) = 50
			const segs = withCornerRadius(makeRectSegments(), [0], 60);
			const result = applyCornerRadius(segs);
			expect(result.length).toBe(5);

			// Fillet is the second segment (after trimmed seg[0])
			// TR vertex at (100,100), edge TL->TR is horizontal
			// trimIn should be at (50, 100) = vertex - 50 along incoming edge
			const filletSeg = result[1];
			expect(filletSeg.start?.x).toBeCloseTo(50, 0);
			expect(filletSeg.start?.y).toBeCloseTo(100, 0);
			// Edge TR->BR is vertical
			// trimOut should be at (100, 50) = vertex - 50 along outgoing edge
			expect(filletSeg.end.x).toBeCloseTo(100, 0);
			expect(filletSeg.end.y).toBeCloseTo(50, 0);
		});

		it("closes the subpath after the wrap-around fillet, not before it", () => {
			const segments = makeRectSegments();
			for (const seg of segments) (seg as PathSegment).cornerRadius = 10;
			const result = applyCornerRadius(segments);
			expect(result.at(-1)?.isClosed).toBe(true);
			expect(result.filter((s) => s.isClosed).length).toBe(1);
		});

		it("preserves isMoved and isClosed flags in output", () => {
			const r = 15;
			const segs = withCornerRadius(makeRectSegments(), [0, 1, 2, 3], r);
			const result = applyCornerRadius(segs);

			expect(result.length).toBe(8);
			expect(result[0].isMoved).toBe(true);
			expect(result.some((s) => s.isClosed === true)).toBe(true);
		});

		it("fillet positions are identical whether applied alone or with all vertices", () => {
			const r = 20;
			// Apply radius to only seg[0] (TR vertex)
			const segsAlone = withCornerRadius(makeRectSegments(), [0], r);
			const resultAlone = applyCornerRadius(segsAlone);
			const filletAlone = resultAlone[1]; // fillet after trimmed seg[0]

			// Apply radius to all 4 vertices
			const segsAll = withCornerRadius(makeRectSegments(), [0, 1, 2, 3], r);
			const resultAll = applyCornerRadius(segsAll);
			const filletAll = resultAll[1]; // fillet after trimmed seg[0]

			// TR vertex fillet position should be identical in both cases
			expect(filletAll.start?.x).toBeCloseTo(filletAlone.start!.x, 5);
			expect(filletAll.start?.y).toBeCloseTo(filletAlone.start!.y, 5);
			expect(filletAll.end.x).toBeCloseTo(filletAlone.end.x, 5);
			expect(filletAll.end.y).toBeCloseTo(filletAlone.end.y, 5);
			expect(filletAll.cp1.x).toBeCloseTo(filletAlone.cp1.x, 5);
			expect(filletAll.cp1.y).toBeCloseTo(filletAlone.cp1.y, 5);
			expect(filletAll.cp2.x).toBeCloseTo(filletAlone.cp2.x, 5);
			expect(filletAll.cp2.y).toBeCloseTo(filletAlone.cp2.y, 5);
		});

		it("wrap-around fillet position matches expected geometry", () => {
			const r = 20;
			// seg[3].end = TL(0,100), wrap-around vertex
			const segs = withCornerRadius(makeRectSegments(), [3], r);
			const result = applyCornerRadius(segs);
			// Result: seg[0] start-trimmed + seg[1] + seg[2] + seg[3] end-trimmed + fillet = 5
			expect(result.length).toBe(5);

			const filletSeg = result[4]; // fillet at wrap-around
			// Incoming edge: BL(0,0) -> TL(0,100), vertical
			// trimIn = TL - 20 along incoming = (0, 80)
			expect(filletSeg.start?.x).toBeCloseTo(0, 0);
			expect(filletSeg.start?.y).toBeCloseTo(80, 0);
			// Outgoing edge: TL(0,100) -> TR(100,100), horizontal
			// trimOut = TL + 20 along outgoing = (20, 100)
			expect(filletSeg.end.x).toBeCloseTo(20, 0);
			expect(filletSeg.end.y).toBeCloseTo(100, 0);
		});

		describe("superellipse k value", () => {
			it("cornerSuperellipseK=undefined → same as k=2 (backward compatible)", () => {
				const segsDefault = withCornerRadius(makeRectSegments(), [0], 10);
				const segsUndefined = withCornerRadius(
					makeRectSegments(),
					[0],
					10,
					undefined,
				);
				const r1 = applyCornerRadius(segsDefault);
				const r2 = applyCornerRadius(segsUndefined);
				expect(r2[1].cp1.x).toBeCloseTo(r1[1].cp1.x, 5);
				expect(r2[1].cp2.x).toBeCloseTo(r1[1].cp2.x, 5);
			});

			it("cornerSuperellipseK=2 → same fillet as default circular arc", () => {
				const segsDefault = withCornerRadius(makeRectSegments(), [0], 10);
				const segsK2 = withCornerRadius(makeRectSegments(), [0], 10, 2);
				const r1 = applyCornerRadius(segsDefault);
				const r2 = applyCornerRadius(segsK2);
				expect(r2[1].cp1.x).toBeCloseTo(r1[1].cp1.x, 5);
				expect(r2[1].cp1.y).toBeCloseTo(r1[1].cp1.y, 5);
			});

			it("cornerSuperellipseK=5 → cp1/cp2 farther from anchor than k=2 (squircle-like)", () => {
				const segsK2 = withCornerRadius(makeRectSegments(), [0], 10, 2);
				const segsK5 = withCornerRadius(makeRectSegments(), [0], 10, 5);
				const rK2 = applyCornerRadius(segsK2);
				const rK5 = applyCornerRadius(segsK5);
				const cp1LenK2 = Math.hypot(rK2[1].cp1.x, rK2[1].cp1.y);
				const cp1LenK5 = Math.hypot(rK5[1].cp1.x, rK5[1].cp1.y);
				expect(cp1LenK5).toBeGreaterThan(cp1LenK2);
			});

			it("cornerSuperellipseK=10 → clamped to same k as k=5 (smoothing saturates at 1.0)", () => {
				const segsK5 = withCornerRadius(makeRectSegments(), [0], 10, 5);
				const segsK10 = withCornerRadius(makeRectSegments(), [0], 10, 10);
				const rK5 = applyCornerRadius(segsK5);
				const rK10 = applyCornerRadius(segsK10);
				const cp1LenK5 = Math.hypot(rK5[1].cp1.x, rK5[1].cp1.y);
				const cp1LenK10 = Math.hypot(rK10[1].cp1.x, rK10[1].cp1.y);
				// smoothing = min(1, (k-2)/3): k=5 → 1.0, k=10 → 1.0 → same fillet k
				expect(cp1LenK10).toBeCloseTo(cp1LenK5, 5);
			});
		});

		it("does not apply wrap-around for open paths", () => {
			const vertices = [
				{ x: 0, y: 100 },
				{ x: 100, y: 100 },
				{ x: 100, y: 0 },
			];
			const segments: CubicBezierSegment[] = vertices
				.slice(0, -1)
				.map((p1, i) => {
					const p2 = vertices[i + 1];
					const dx = p2.x - p1.x;
					const dy = p2.y - p1.y;
					return {
						start: i === 0 ? p1 : undefined,
						cp1: { x: dx * 0.33, y: dy * 0.33 },
						cp2: { x: -dx * 0.33, y: -dy * 0.33 },
						end: p2,
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
						isMoved: i === 0,
					};
				});
			// seg[0] cornerRadius on TR vertex
			const segsWithR = withCornerRadius(segments, [0], 10);
			const result = applyCornerRadius(segsWithR);
			// 2 segs -> 1 fillet -> 3 segs
			expect(result.length).toBe(3);
		});
	});
});

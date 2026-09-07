import type { BezierPoint } from "../schema";
import { processStroke } from "../utils/geometry/strokeFitting";
import { BrushStrokeSession } from "./BrushStrokeSession";

function point(x: number, y: number, deltaTime: number): BezierPoint {
	return { x, y, pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, deltaTime };
}

function makeSession() {
	return new BrushStrokeSession({
		stabilization: 0.5,
		zoom: 1,
		smoothingMethod: "smooth",
	});
}

describe("BrushStrokeSession", () => {
	it("should build preview segments incrementally from appended points", () => {
		const session = makeSession();
		for (let i = 0; i < 60; i++) {
			session.append(point(i * 3, Math.sin(i * 0.2) * 10, i * 8));
		}
		const segments = session.getPreviewSegments();
		expect(segments.length).toBeGreaterThan(0);
		expect(segments[0].start).toBeDefined();
	});

	it("should accept coalesced point batches", () => {
		const session = makeSession();
		session.appendCoalesced([
			point(0, 0, 0),
			point(2, 0, 4),
			point(4, 0, 8),
			point(6, 0, 12),
		]);
		expect(session.pointCount).toBe(4);
	});

	describe("airbrush hold points", () => {
		it("should advance time at the stroke end and record the point", () => {
			const session = makeSession();
			session.append(point(0, 0, 0));
			session.append(point(10, 0, 16));

			session.injectHold(200);

			// The hold point is part of the raw point record, so a replay
			// (commit -> full processStroke) sees the same timing.
			expect(session.pointCount).toBe(3);
			const segments = session.getPreviewSegments();
			const last = segments[segments.length - 1];
			expect(last.endDeltaTime).toBe(200);
		});

		it("should be a no-op before any point exists", () => {
			const session = makeSession();
			session.injectHold(100);
			expect(session.pointCount).toBe(0);
		});
	});

	describe("lifecycle (commit/abort are the only exits)", () => {
		it("should return the raw points on commit and refuse further input", () => {
			const session = makeSession();
			const inputs = [point(0, 0, 0), point(5, 0, 8), point(10, 0, 16)];
			for (const p of inputs) session.append(p);

			const committed = session.commit();
			expect(session.outcome).toBe("committed");
			expect(committed).toHaveLength(3);
			// The commit result feeds the exact full-fit pipeline.
			expect(
				processStroke(
					committed,
					0.5,
					{ x: 0, y: 0, zoom: 1, rotation: 0 },
					"smooth",
				).length,
			).toBeGreaterThan(0);

			session.append(point(20, 0, 24));
			expect(session.pointCount).toBe(3);
			expect(session.commit()).toHaveLength(3);
		});

		it("should clear preview state on abort and refuse further input", () => {
			const session = makeSession();
			session.append(point(0, 0, 0));
			session.append(point(5, 0, 8));

			session.abort();
			expect(session.outcome).toBe("aborted");
			expect(session.getPreviewSegments()).toHaveLength(0);

			session.append(point(20, 0, 24));
			expect(session.pointCount).toBe(0);
		});

		it("should not allow abort to override a commit", () => {
			const session = makeSession();
			session.append(point(0, 0, 0));
			session.append(point(5, 0, 8));
			session.commit();
			session.abort();
			expect(session.outcome).toBe("committed");
		});
	});
});

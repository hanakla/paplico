import type { BezierPoint } from "../schema";
import { processStroke } from "../utils/geometry/strokeFitting";
import { BrushStrokeSession } from "./BrushStrokeSession";

function point(
	x: number,
	y: number,
	deltaTime: number,
	pressure = 0.5,
): BezierPoint {
	return { x, y, pressure, tiltX: 0, tiltY: 0, twist: 0, deltaTime };
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

	describe("impact spike at pen-down", () => {
		function pressures(session: BrushStrokeSession): number[] {
			return session.rawPoints.map((p) => +(p.pressure ?? -1).toFixed(6));
		}

		it("should lower a spike that the following sample does not explain", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.95));
			session.append(point(0.5, 0, 8, 0.8));
			session.append(point(1, 0, 16, 0.6));
			// The settled sample supplies the reference pressure.
			session.append(point(1.5, 0, 100, 0.4));

			expect(pressures(session)).toEqual([0.45, 0.4, 0.4, 0.4]);
		});

		it("should keep pressure that stays high after the window", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.95));
			session.append(point(0.5, 0, 8, 0.9));
			session.append(point(1.5, 0, 100, 0.85));

			expect(pressures(session)).toEqual([0.95, 0.9, 0.85]);
		});

		it("should ignore an excess below the threshold", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.6));
			session.append(point(1.5, 0, 100, 0.5));

			expect(pressures(session)).toEqual([0.6, 0.5]);
		});

		it("should correct a moving stroke before the contact window ends", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.95));
			session.append(point(4, 0, 8, 0.4));

			expect(pressures(session)).toEqual([0.45, 0.4]);
		});

		it("should preserve the same tap radius at every zoom", () => {
			const session = new BrushStrokeSession({
				stabilization: 0.5,
				zoom: 2,
				smoothingMethod: "smooth",
			});
			session.append(point(0, 0, 0, 0.95));
			// This motion leaves the tap radius at zoom 2.
			session.append(point(2, 0, 8, 0.4));

			expect(pressures(session)).toEqual([0.45, 0.4]);
		});

		it("should show the stroke while contact pressure is still settling", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.95));
			session.append(point(1, 0, 8, 0.5));
			expect(session.getPreviewSegments().length).toBeGreaterThan(0);

			session.append(point(10, 0, 16, 0.5));
			expect(session.getPreviewSegments().length).toBeGreaterThan(0);
		});

		it("should continue correcting after a fast contact has crossed the tap radius", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.9));
			session.append(point(5, 0, 8, 0.85));
			session.append(point(20, 0, 40, 0.8));
			session.append(point(50, 0, 100, 0.4));
			expect(pressures(session)).toEqual([0.4, 0.4, 0.4, 0.4]);
			expect(session.getPreviewSegments()[0].startPressure).toBe(0.4);
		});

		it("should correct a contact spike when the entire stroke uses light pressure", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.06));
			session.append(point(5, 0, 8, 0.06));
			session.append(point(50, 0, 100, 0.02));
			expect(pressures(session)).toEqual([0.02, 0.02, 0.02]);
		});

		it("should reconsider original pressures rather than compound a provisional correction", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.9));
			session.append(point(5, 0, 8, 0.4));
			session.append(point(10, 0, 100, 0.9));
			expect(pressures(session)).toEqual([0.9, 0.4, 0.9]);
		});

		it("should keep correcting after the pointer returns inside the tap radius", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.95));
			session.append(point(4, 0, 8, 0.4));
			session.append(point(2, 0, 16, 0.4));
			expect(pressures(session)).toEqual([0.45, 0.4, 0.4]);
		});

		it("should commit a tap that ends inside the window untouched", () => {
			const session = makeSession();
			session.append(point(0, 0, 0, 0.95));
			session.append(point(1, 0, 8, 0.5));

			expect(session.commit().map((p) => p.pressure)).toEqual([0.95, 0.5]);
		});
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

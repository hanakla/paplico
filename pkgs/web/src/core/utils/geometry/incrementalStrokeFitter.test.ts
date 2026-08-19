import type { BezierPoint, CubicBezierSegment } from "../../schema";
import { maxTurnNear } from "../../testUtils/strokeGeometry";
import {
	IncrementalStrokeFitter,
	processStroke,
	type SmoothingMethod,
	subdivideSegmentsAtTimeKnots,
} from "./strokeFitting";

const METHODS: SmoothingMethod[] = ["smooth", "pulled-string", "inertia"];

function wavePoints(n: number): BezierPoint[] {
	const out: BezierPoint[] = [];
	for (let i = 0; i < n; i++) {
		out.push({
			x: i * 2,
			y: Math.sin(i * 0.08) * 30,
			pressure: 0.5 + 0.3 * Math.sin(i * 0.05),
			tiltX: 0,
			tiltY: 0,
			twist: 0,
			deltaTime: i * 8,
		});
	}
	return out;
}

function zigzagPoints(): BezierPoint[] {
	// Right 100 units, then a sharp 90° turn upward for 100 units.
	const out: BezierPoint[] = [];
	for (let i = 0; i <= 50; i++) {
		out.push({ x: i * 2, y: 0, pressure: 0.5, deltaTime: i * 8 });
	}
	for (let i = 1; i <= 50; i++) {
		out.push({ x: 100, y: i * 2, pressure: 0.5, deltaTime: (50 + i) * 8 });
	}
	return out;
}

function makeFitter(method: SmoothingMethod, stabilization = 0.5) {
	return new IncrementalStrokeFitter({
		stabilization,
		zoom: 1,
		smoothingMethod: method,
	});
}

function segmentAnchor(
	segments: CubicBezierSegment[],
	index: number,
): { x: number; y: number } {
	return segments[index].end;
}

function sampleSegments(
	segments: CubicBezierSegment[],
): { x: number; y: number }[] {
	const pts: { x: number; y: number }[] = [];
	let prevEnd = { x: 0, y: 0 };
	for (const seg of segments) {
		const sx = seg.start ? seg.start.x : prevEnd.x;
		const sy = seg.start ? seg.start.y : prevEnd.y;
		const c1x = sx + seg.cp1.x;
		const c1y = sy + seg.cp1.y;
		const c2x = seg.end.x + seg.cp2.x;
		const c2y = seg.end.y + seg.cp2.y;
		for (let i = 0; i <= 16; i++) {
			const t = i / 16;
			const omt = 1 - t;
			pts.push({
				x:
					omt * omt * omt * sx +
					3 * omt * omt * t * c1x +
					3 * omt * t * t * c2x +
					t * t * t * seg.end.x,
				y:
					omt * omt * omt * sy +
					3 * omt * omt * t * c1y +
					3 * omt * t * t * c2y +
					t * t * t * seg.end.y,
			});
		}
		prevEnd = seg.end;
	}
	return pts;
}

function nearestAnchorTo(
	segments: CubicBezierSegment[],
	x: number,
	y: number,
): { x: number; y: number } {
	let best = segments[0].end;
	for (const seg of segments) {
		if (
			Math.hypot(seg.end.x - x, seg.end.y - y) <
			Math.hypot(best.x - x, best.y - y)
		) {
			best = seg.end;
		}
	}
	return best;
}

function distanceToPolyline(
	x: number,
	y: number,
	poly: { x: number; y: number }[],
): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 1; i < poly.length; i++) {
		const ax = poly[i - 1].x;
		const ay = poly[i - 1].y;
		const bx = poly[i].x;
		const by = poly[i].y;
		const dx = bx - ax;
		const dy = by - ay;
		const lenSq = dx * dx + dy * dy;
		const t =
			lenSq > 0
				? Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / lenSq, 0), 1)
				: 0;
		const px = ax + dx * t;
		const py = ay + dy * t;
		best = Math.min(best, Math.hypot(x - px, y - py));
	}
	return best;
}

describe("IncrementalStrokeFitter", () => {
	for (const method of METHODS) {
		describe(`method=${method}`, () => {
			it("should never mutate a frozen segment after later pushes", () => {
				const fitter = makeFitter(method);
				const points = wavePoints(600);
				const frozenHistory: {
					count: number;
					segments: CubicBezierSegment[];
				}[] = [];
				for (const p of points) {
					fitter.push(p);
					const segments = fitter.getSegments();
					frozenHistory.push({
						count: fitter.frozenSegmentCount,
						segments: segments.slice(0, fitter.frozenSegmentCount),
					});
				}

				const final = fitter.getSegments();
				let prevCount = 0;
				for (const step of frozenHistory) {
					expect(step.count).toBeGreaterThanOrEqual(prevCount);
					prevCount = step.count;
					for (let i = 0; i < step.count; i++) {
						expect(step.segments[i]).toEqual(final[i]);
					}
				}
				expect(fitter.frozenSegmentCount).toBeGreaterThan(0);
			});

			it("should keep per-push processing bounded on long strokes", () => {
				const fitter = makeFitter(method);
				const points = wavePoints(2000);
				let maxProcessed = 0;
				for (const p of points) {
					fitter.push(p);
					fitter.getSegments();
					maxProcessed = Math.max(maxProcessed, fitter.lastProcessedPoints);
				}
				// The tail window is bounded: per-push work must not grow with
				// stroke length (2000 points here).
				expect(maxProcessed).toBeLessThan(300);
			});
		});
	}

	it("should stay close to the input points (smooth method)", () => {
		const fitter = makeFitter("smooth");
		const points = wavePoints(400);
		for (const p of points) fitter.push(p);
		const segments = fitter.getSegments();
		const poly = sampleSegments(segments);

		// tolerance at stabilization 0.5 / zoom 1 is 2.5; allow fitting slack.
		for (const p of points) {
			expect(distanceToPolyline(p.x, p.y, poly)).toBeLessThan(10);
		}

		const last = segments[segments.length - 1].end;
		const rawLast = points[points.length - 1];
		expect(Math.hypot(last.x - rawLast.x, last.y - rawLast.y)).toBeLessThan(
			1e-6,
		);
	});

	it("should keep a sharp anchor at the corner", () => {
		const fitter = makeFitter("smooth", 0.3);
		for (const p of zigzagPoints()) fitter.push(p);
		const segments = fitter.getSegments();
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < segments.length; i++) {
			const a = segmentAnchor(segments, i);
			best = Math.min(best, Math.hypot(a.x - 100, a.y - 0));
		}
		expect(best).toBeLessThan(1.5);
		expect(maxTurnNear(segments, 100, 0, 1.5)).toBeGreaterThanOrEqual(60);
	});

	it("should place the corner anchor where processStroke places it", () => {
		const points = zigzagPoints();
		const fitter = makeFitter("smooth", 0.5);
		for (const p of points) fitter.push(p);
		const incremental = nearestAnchorTo(fitter.getSegments(), 100, 0);
		const full = nearestAnchorTo(
			processStroke(
				points,
				0.5,
				{ x: 0, y: 0, zoom: 1, rotation: 0 },
				"smooth",
			),
			100,
			0,
		);
		expect(
			Math.hypot(incremental.x - full.x, incremental.y - full.y),
		).toBeLessThanOrEqual(1.0);
	});

	it("should work with stabilization 0 (no smoothing)", () => {
		const fitter = makeFitter("smooth", 0);
		for (const p of wavePoints(200)) fitter.push(p);
		expect(fitter.getSegments().length).toBeGreaterThan(0);
	});

	it("should produce a segment count comparable to the full processStroke", () => {
		const points = wavePoints(500);
		const fitter = makeFitter("smooth");
		for (const p of points) fitter.push(p);
		const incremental = fitter.getSegments();
		const full = processStroke(
			points,
			0.5,
			{ x: 0, y: 0, zoom: 1, rotation: 0 },
			"smooth",
		);
		expect(incremental.length).toBeGreaterThan(0);
		expect(incremental.length).toBeLessThan(full.length * 3 + 8);
	});

	describe("time-knot subdivision (live speed width)", () => {
		it("should keep per-segment timing close to the input speed profile", () => {
			const fitter = makeFitter("smooth");
			for (const p of fastSlowPoints()) fitter.push(p);
			const segments = fitter.getSegments();

			// Per-segment average speed, bucketed by segment midpoint x. A single
			// fit over the whole run would linearize time and flatten this.
			const speeds: { x: number; v: number }[] = [];
			let prevEnd = { x: 0, y: 0 };
			for (const seg of segments) {
				const sx = seg.start?.x ?? prevEnd.x;
				const len = Math.abs(seg.end.x - sx);
				const duration = seg.endDeltaTime - seg.startDeltaTime;
				if (len > 1 && duration > 0) {
					speeds.push({ x: (sx + seg.end.x) / 2, v: len / duration });
				}
				prevEnd = seg.end;
			}
			const mean = (values: number[]) =>
				values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
			const fast = mean(
				speeds.filter((s) => s.x > 15 && s.x < 85).map((s) => s.v),
			);
			const slow = mean(
				speeds.filter((s) => s.x > 115 && s.x < 185).map((s) => s.v),
			);
			// True speeds are 1.0 and 0.08 px/ms. The whole run stays inside one
			// tail fit (< 128 points, no freeze), so without time knots both
			// halves collapse to one linearized schedule.
			expect(fast).toBeGreaterThan(slow * 5);
			expect(slow).toBeLessThan(0.15);
		});

		it("should not change the fitted geometry", () => {
			const points = fastSlowPoints();
			const fitted = processStroke(
				points,
				0.5,
				{ x: 0, y: 0, zoom: 1, rotation: 0 },
				"smooth",
			);
			const subdivided = subdivideSegmentsAtTimeKnots(fitted, points);

			expect(subdivided.length).toBeGreaterThan(fitted.length);
			for (const sample of sampleSegments(subdivided)) {
				expect(
					distanceToPolyline(sample.x, sample.y, sampleSegments(fitted)),
				).toBeLessThan(0.01);
			}
		});
	});
});

/**
 * Straight line: fast first half (2px / 2ms), slow second half (2px / 25ms).
 * Kept under 128 points so the whole run fits into a single live tail
 * (no forced freeze) — the hardest case for speed preservation.
 */
function fastSlowPoints(): BezierPoint[] {
	const out: BezierPoint[] = [];
	let t = 0;
	for (let x = 0; x <= 100; x += 2) {
		out.push({ x, y: 0, pressure: 0.5, deltaTime: t });
		t += 2;
	}
	for (let x = 102; x <= 200; x += 2) {
		out.push({ x, y: 0, pressure: 0.5, deltaTime: t });
		t += 25;
	}
	return out;
}

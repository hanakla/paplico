import type { BezierPoint, CubicBezierSegment } from "../../schema";
import {
	IncrementalStrokeFitter,
	processStroke,
	type SmoothingMethod,
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

	it("should keep an anchor near a sharp corner", () => {
		const fitter = makeFitter("smooth", 0.3);
		for (const p of zigzagPoints()) fitter.push(p);
		const segments = fitter.getSegments();
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < segments.length; i++) {
			const a = segmentAnchor(segments, i);
			best = Math.min(best, Math.hypot(a.x - 100, a.y - 0));
		}
		expect(best).toBeLessThan(6);
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
});

import type { BezierPoint, Viewport } from "../../schema";
import {
	anchorTurns,
	maxChordBackTravel,
	maxTurnNear,
} from "../../testUtils/strokeGeometry";
import { evalCubicBezier } from "./pathSampling";
import { resolveSegment } from "./segmentOps";
import {
	detectRawCorners,
	IncrementalStrokeFitter,
	processStroke,
} from "./strokeFitting";

const viewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

function linePoints(
	twistOf: (index: number) => number,
	count = 20,
): BezierPoint[] {
	return Array.from({ length: count }, (_, i) => ({
		x: i * 10,
		y: 0,
		pressure: 0.5,
		tiltX: 0,
		tiltY: 0,
		twist: twistOf(i),
		deltaTime: i * 10,
	}));
}

describe("processStroke twist propagation", () => {
	it("should carry twist endpoints into every fitted segment", () => {
		const segments = processStroke(
			linePoints((i) => 10 + i * 2),
			0.5,
			viewport,
			"smooth",
		);
		expect(segments.length).toBeGreaterThan(0);
		for (const segment of segments) {
			expect(segment.startTwist).toBeDefined();
			expect(segment.endTwist).toBeDefined();
			expect(segment.startTwist).toBeGreaterThanOrEqual(0);
			expect(segment.startTwist).toBeLessThan(360);
		}
		// Twist grows along the stroke, so the fitted endpoints must too.
		const first = segments[0];
		const last = segments[segments.length - 1];
		expect((last.endTwist ?? 0) > (first.startTwist ?? 0)).toBe(true);
	});

	it("should average twist across the 0/360 wrap without collapsing to 180", () => {
		// Alternating 350 and 10 degrees: the angular mean is 0 (or 360), and a
		// naive linear average would land at 180.
		const segments = processStroke(
			linePoints((i) => (i % 2 === 0 ? 350 : 10)),
			0.8,
			viewport,
			"smooth",
		);
		for (const segment of segments) {
			for (const twist of [segment.startTwist ?? 0, segment.endTwist ?? 0]) {
				const wrapped = ((twist % 360) + 360) % 360;
				const nearWrap = wrapped >= 330 || wrapped <= 30;
				expect(nearWrap).toBe(true);
			}
		}
	});
});

describe("processStroke corner preservation (smooth)", () => {
	it("should keep a sharp anchor at a hand-drawn 90° corner", () => {
		const segments = processStroke(cornerStroke(90), 0.5, viewport, "smooth");
		expect(maxTurnNear(segments, 100, 0, 1.0)).toBeGreaterThanOrEqual(60);
	});

	it("should keep a sharp anchor at a 120° turn (60° interior angle)", () => {
		const segments = processStroke(cornerStroke(120), 0.5, viewport, "smooth");
		expect(maxTurnNear(segments, 100, 0, 1.0)).toBeGreaterThanOrEqual(90);
	});

	it("should keep the corner on jittered input", () => {
		const segments = processStroke(
			cornerStroke(90, 0.4),
			0.5,
			viewport,
			"smooth",
		);
		expect(maxTurnNear(segments, 100, 0, 2.5)).toBeGreaterThanOrEqual(45);
	});

	it("should keep the corner when stabilization is 0", () => {
		const segments = processStroke(cornerStroke(90), 0, viewport, "smooth");
		expect(maxTurnNear(segments, 100, 0, 1.0)).toBeGreaterThanOrEqual(60);
	});

	it("should not create sharp anchors on a semicircle", () => {
		const segments = processStroke(semicircle(), 0.5, viewport, "smooth");
		expect(segments.length).toBeGreaterThan(0);
		for (const turn of anchorTurns(segments)) {
			expect(turn.turnDeg).toBeLessThan(20);
		}
	});

	it("should not create sharp anchors on a jittered straight line", () => {
		const segments = processStroke(jitteredLine(0.4), 0.5, viewport, "smooth");
		expect(segments.length).toBeGreaterThan(0);
		for (const turn of anchorTurns(segments)) {
			expect(turn.turnDeg).toBeLessThan(20);
		}
	});

	it("should keep a single clean corner when the pen dwells at the apex", () => {
		const segments = processStroke(
			cornerStrokeWithDwell(90, 0.8, 8),
			0.5,
			viewport,
			"smooth",
		);

		// One sharp anchor at the corner...
		expect(maxTurnNear(segments, 100, 0, 3.0)).toBeGreaterThanOrEqual(45);
		// ...and no direction reversals: a zigzag through the dwell noise shows
		// up as near-180° turns at the extra anchors.
		for (const turn of anchorTurns(segments)) {
			expect(turn.turnDeg).toBeLessThan(135);
		}
		// The dwell cluster must not split into several corner anchors.
		const sharpNearApex = anchorTurns(segments).filter(
			(turn) => turn.turnDeg >= 45 && Math.hypot(turn.x - 100, turn.y) <= 5,
		);
		expect(sharpNearApex).toHaveLength(1);
	});
});

describe("fold-back on strokes drawn in one direction", () => {
	// Two-point runs carry no least-squares solve: their handles are fixed at
	// a third of the chord along the corner tangents, so a tangent that opens
	// more than a right angle to the chord leaves a residue no handle length
	// can remove. It stays two orders of magnitude below a brush width.
	const VISIBLE_FOLD_PX = 0.05;

	it("should not fold back for any stabilization strength", () => {
		for (const stabilization of [0, 0.02, 0.06, 0.1, 0.5, 1]) {
			const fitted = processStroke(
				jitteredDrag(400, 3),
				stabilization,
				viewport,
				"smooth",
			);
			expect(
				maxChordBackTravel(fitted),
				`stabilization ${stabilization}`,
			).toBeLessThan(VISIBLE_FOLD_PX);
		}
	});

	it("should not fold back at any drawing speed or jitter amplitude", () => {
		for (const speed of [20, 150, 400, 900]) {
			for (const jitter of [0.6, 1.5, 3]) {
				const fitted = processStroke(
					jitteredDrag(speed, jitter),
					0.06,
					viewport,
					"smooth",
				);
				expect(
					maxChordBackTravel(fitted),
					`speed ${speed}, jitter ${jitter}`,
				).toBeLessThan(VISIBLE_FOLD_PX);
			}
		}
	});

	it("should not fold back in the live preview while the stroke is drawn", () => {
		const fitter = new IncrementalStrokeFitter({
			stabilization: 0.06,
			zoom: 1,
		});

		for (const point of jitteredDrag(400, 3)) {
			fitter.push(point);
			const segments = fitter.getSegments();
			if (segments.length === 0) continue;
			expect(
				maxChordBackTravel(segments),
				`after ${point.deltaTime}ms`,
			).toBeLessThan(VISIBLE_FOLD_PX);
		}
	});
});

describe("anchor count after simplification", () => {
	// A hand-drawn wave: five crests, 120 Hz, with the jitter a hand adds.
	// The corner detector reads the waver at each crest as a run of corners,
	// and every corner is a forced section boundary.
	const wave = wavyLine(5, 3);

	it("should keep far fewer anchors than the corner detector proposes", () => {
		const fitted = processStroke(wave, 0.5, viewport, "smooth");
		// The corner detector proposes 56 segments for this wave, one per
		// detected corner. Five crests and five troughs need about a dozen;
		// merging is refused wherever two cubics still meet at a corner-sized
		// turn, which leaves 31 here. The bound keeps most of the reduction
		// without pinning the exact count.
		expect(fitted.length).toBeLessThanOrEqual(36);
	});

	it("should keep a deliberate corner however short its legs", () => {
		// Two straight legs meeting at `angle`, legs short enough that one
		// cubic stays within tolerance of both — the tolerance test alone
		// would merge them and round the corner away. 45° sits on the
		// detection threshold itself.
		for (const [leg, angle, stabilization] of [
			[40, 45, 0.5],
			[8, 60, 0.5],
			[15, 75, 0.5],
			[20, 90, 0.5],
			[40, 75, 1.0],
			[40, 90, 1.0],
		] as const) {
			const fitted = processStroke(
				corneredLegs(leg, angle),
				stabilization,
				viewport,
				"smooth",
			);
			const sharpest = anchorTurns(fitted).reduce(
				(max, turn) => Math.max(max, turn.turnDeg),
				0,
			);
			expect(
				fitted.length,
				`leg ${leg}px, ${angle}°, stabilization ${stabilization}`,
			).toBeGreaterThanOrEqual(2);
			expect(
				sharpest,
				`leg ${leg}px, ${angle}°, stabilization ${stabilization}`,
			).toBeGreaterThanOrEqual(angle - 15);
		}
	});

	it("should not leave two anchors within a few px of each other", () => {
		const fitted = processStroke(wave, 0.5, viewport, "smooth");
		let px = fitted[0].start?.x ?? 0;
		let py = fitted[0].start?.y ?? 0;
		for (const segment of fitted) {
			expect(
				Math.hypot(segment.end.x - px, segment.end.y - py),
			).toBeGreaterThan(3);
			px = segment.end.x;
			py = segment.end.y;
		}
	});

	it("should stay within tolerance of the input after merging", () => {
		// No jitter and no smoothing, so the input points are exactly what the
		// fit must reproduce: merging measures its error against them and may
		// not stray further than the fit's own 0.5px tolerance allows. The fit
		// measures that error at each point's chord parameter rather than at
		// the true nearest point of the curve, which lets the nearest distance
		// run a hair over — 0.5512px here — so the bound carries that slack
		// rather than the merge's.
		const clean = wavyLine(5, 0);
		const fitted = processStroke(clean, 0, viewport, "smooth");
		const curve = samplePath(fitted, 64);
		for (const p of clean) {
			let best = Number.POSITIVE_INFINITY;
			for (const c of curve) {
				best = Math.min(best, Math.hypot(c.x - p.x, c.y - p.y));
			}
			expect(best).toBeLessThanOrEqual(0.6);
		}
	});

	it("should read pressure and time at every surviving anchor from the input", () => {
		const fitted = processStroke(wave, 0.5, viewport, "smooth");
		let previousTime = Number.NEGATIVE_INFINITY;
		for (const segment of fitted) {
			// Anchors are input points; their metadata must be that point's,
			// not an average or a guess.
			const source = wave.reduce((best, p) =>
				Math.hypot(p.x - segment.end.x, p.y - segment.end.y) <
				Math.hypot(best.x - segment.end.x, best.y - segment.end.y)
					? p
					: best,
			);
			expect(segment.endDeltaTime).toBeGreaterThanOrEqual(previousTime);
			expect(segment.endPressure).toBeCloseTo(source.pressure ?? 0.5, 1);
			previousTime = segment.endDeltaTime;
		}
	});

	it("should keep a deliberate 90° corner through the merge pass", () => {
		const cornered: BezierPoint[] = [];
		for (let i = 0; i <= 50; i++) {
			cornered.push({ x: i * 2, y: 0, pressure: 0.5, deltaTime: i * 8 });
		}
		for (let i = 1; i <= 50; i++) {
			cornered.push({
				x: 100,
				y: i * 2,
				pressure: 0.5,
				deltaTime: (50 + i) * 8,
			});
		}
		const fitted = processStroke(cornered, 0, viewport, "smooth");
		// No single cubic gets through a right angle within 0.5px, so the two
		// legs must stay two segments meeting at the apex.
		expect(fitted.length).toBeGreaterThanOrEqual(2);
		const nearest = fitted.reduce((best, s) =>
			Math.hypot(s.end.x - 100, s.end.y) <
			Math.hypot(best.end.x - 100, best.end.y)
				? s
				: best,
		);
		expect(Math.hypot(nearest.end.x - 100, nearest.end.y)).toBeLessThan(1.5);
	});
});

describe("detectRawCorners", () => {
	it("should report exactly one interior corner at the apex of a 90° polyline", () => {
		const interior = detectRawCorners(cornerStroke(90)).slice(1, -1);
		expect(interior).toHaveLength(1);
		expect(Math.abs(interior[0] - 50)).toBeLessThanOrEqual(2);
	});

	it("should report exactly one interior corner on a jittered 90° polyline", () => {
		const interior = detectRawCorners(cornerStroke(90, 0.4)).slice(1, -1);
		expect(interior).toHaveLength(1);
		expect(Math.abs(interior[0] - 50)).toBeLessThanOrEqual(2);
	});

	it("should report no interior corners on a jittered straight line", () => {
		expect(detectRawCorners(jitteredLine(0.4)).slice(1, -1)).toHaveLength(0);
	});

	it("should report no interior corners on a semicircle", () => {
		expect(detectRawCorners(semicircle()).slice(1, -1)).toHaveLength(0);
	});

	it("should report exactly one interior corner when the pen dwells at the apex", () => {
		const points = cornerStrokeWithDwell(90, 0.8, 8);
		const interior = detectRawCorners(points).slice(1, -1);
		expect(interior).toHaveLength(1);
		const corner = points[interior[0]];
		expect(Math.hypot(corner.x - 100, corner.y)).toBeLessThanOrEqual(3);
	});

	it("should report no interior corners when the pen dwells on a straight line", () => {
		const interior = detectRawCorners(lineWithDwell(0.8, 8)).slice(1, -1);
		expect(interior).toHaveLength(0);
	});
});

function pt(x: number, y: number, i: number): BezierPoint {
	return {
		x,
		y,
		pressure: 0.5,
		tiltX: 0,
		tiltY: 0,
		twist: 0,
		deltaTime: i * 8,
	};
}

/**
 * Two 100-unit legs in 2-unit steps turning by `turnDeg` at (100, 0), with
 * optional deterministic perpendicular jitter.
 */
function cornerStroke(turnDeg: number, jitterAmp = 0): BezierPoint[] {
	const rad = (turnDeg * Math.PI) / 180;
	const base: { x: number; y: number }[] = [];
	for (let i = 0; i <= 50; i++) base.push({ x: i * 2, y: 0 });
	for (let i = 1; i <= 50; i++) {
		base.push({ x: 100 + Math.cos(rad) * i * 2, y: Math.sin(rad) * i * 2 });
	}
	return withPerpendicularJitter(base, jitterAmp);
}

/**
 * cornerStroke with a hand-like approach: the pen decelerates into the
 * corner (steps shrink toward the apex), jitters more while moving slowly,
 * and sits nearly still at (100, 0) for `dwellCount` samples with jitter
 * that survives dedup, so the dwell tempts the detector into several corners.
 */
function cornerStrokeWithDwell(
	turnDeg: number,
	dwellJitterAmp: number,
	dwellCount: number,
): BezierPoint[] {
	const rad = (turnDeg * Math.PI) / 180;
	const rand = mulberry32(5678);
	const jitterAt = (distToApex: number): number =>
		distToApex < 6 ? dwellJitterAmp : distToApex < 15 ? 0.5 : 0.3;
	const points: BezierPoint[] = [];
	let i = 0;
	let x = 0;
	while (x < 100) {
		const distToApex = 100 - x;
		const jitter = jitterAt(distToApex);
		points.push(
			pt(x + (rand() * 2 - 1) * jitter * 0.5, (rand() * 2 - 1) * jitter, i++),
		);
		x += Math.max(0.6, Math.min(3, distToApex * 0.15));
	}
	for (let d = 0; d < dwellCount; d++) {
		points.push(
			pt(
				100 + (rand() * 2 - 1) * dwellJitterAmp,
				(rand() * 2 - 1) * dwellJitterAmp,
				i++,
			),
		);
	}
	let s = 0;
	while (s <= 100) {
		const jitter = jitterAt(s);
		const jx = (rand() * 2 - 1) * jitter;
		const js = s + (rand() * 2 - 1) * jitter * 0.5;
		points.push(
			pt(
				100 + Math.cos(rad) * js - Math.sin(rad) * jx,
				Math.sin(rad) * js + Math.cos(rad) * jx,
				i++,
			),
		);
		s += Math.max(0.6, Math.min(3, s * 0.15 + 0.6));
	}
	return points;
}

/** Straight line with a mid-stroke dwell (near-stationary jittered samples). */
function lineWithDwell(
	dwellJitterAmp: number,
	dwellCount: number,
): BezierPoint[] {
	const rand = mulberry32(9012);
	const points: BezierPoint[] = [];
	let i = 0;
	for (let s = 0; s <= 50; s++) points.push(pt(s * 2, 0, i++));
	for (let d = 0; d < dwellCount; d++) {
		points.push(
			pt(
				100 + (rand() * 2 - 1) * dwellJitterAmp,
				(rand() * 2 - 1) * dwellJitterAmp,
				i++,
			),
		);
	}
	for (let s = 1; s <= 50; s++) points.push(pt(100 + s * 2, 0, i++));
	return points;
}

function jitteredLine(jitterAmp: number): BezierPoint[] {
	const base: { x: number; y: number }[] = [];
	for (let i = 0; i <= 100; i++) base.push({ x: i * 2, y: 0 });
	return withPerpendicularJitter(base, jitterAmp);
}

function semicircle(radius = 30, step = 2): BezierPoint[] {
	const n = Math.round((Math.PI * radius) / step);
	const base: { x: number; y: number }[] = [];
	for (let i = 0; i <= n; i++) {
		const a = (Math.PI * i) / n;
		base.push({ x: radius * Math.cos(a), y: radius * Math.sin(a) });
	}
	return withPerpendicularJitter(base, 0);
}

/**
 * Displace interior points perpendicular to the local direction using a
 * seeded PRNG so tests stay reproducible.
 */
function withPerpendicularJitter(
	base: { x: number; y: number }[],
	amp: number,
): BezierPoint[] {
	const rand = mulberry32(1234);
	return base.map((p, i) => {
		if (amp === 0 || i === 0 || i === base.length - 1) return pt(p.x, p.y, i);
		const prev = base[i - 1];
		const next = base[i + 1];
		const dx = next.x - prev.x;
		const dy = next.y - prev.y;
		const len = Math.hypot(dx, dy) || 1;
		const offset = (rand() * 2 - 1) * amp;
		return pt(p.x + (-dy / len) * offset, p.y + (dx / len) * offset, i);
	});
}

/**
 * A straight drag carrying hand jitter. The two end tangents come out nearly
 * parallel, which is where the solve for the handle lengths stops having a
 * meaningful answer, and weak stabilization leaves the jitter in the input
 * while the fit tolerance stays loose.
 */
function jitteredDrag(
	pxPerSecond: number,
	jitter: number,
	seconds = 2,
	hz = 120,
): BezierPoint[] {
	const rand = mulberry32(20260828);
	const noise = () => (rand() - 0.5) * jitter;
	return Array.from({ length: Math.floor(seconds * hz) }, (_unused, i) => {
		const t = i / hz;
		return {
			x: pxPerSecond * t + noise(),
			y: noise(),
			pressure: 0.5,
			tiltX: 0,
			tiltY: 0,
			twist: 0,
			deltaTime: t * 1000,
		};
	});
}

/**
 * A wave drawn left to right: `crests` full periods at 120 Hz over a steady
 * hand speed, with `jitter` px of per-sample tremor on both axes.
 */
function wavyLine(crests: number, jitter: number): BezierPoint[] {
	const rand = mulberry32(20260829);
	const noise = () => (rand() - 0.5) * jitter;
	const hz = 120;
	const seconds = 2.5;
	const width = 500;
	const amplitude = 40;
	return Array.from({ length: Math.floor(seconds * hz) }, (_unused, i) => {
		const t = i / hz;
		const along = (t / seconds) * width;
		return {
			x: along + noise(),
			y: amplitude * Math.sin((along / width) * crests * 2 * Math.PI) + noise(),
			pressure: 0.3 + 0.4 * Math.sin(t * 3),
			tiltX: 0,
			tiltY: 0,
			twist: 0,
			deltaTime: t * 1000,
		};
	});
}

/** Two straight legs of `legPx` meeting at `angleDeg`, sampled every 2px. */
function corneredLegs(legPx: number, angleDeg: number): BezierPoint[] {
	const samples = Math.max(2, Math.round(legPx / 2));
	const heading = ((180 - angleDeg) * Math.PI) / 180;
	const points: BezierPoint[] = [];
	for (let i = 0; i <= samples; i++) {
		points.push({
			x: (i / samples) * legPx,
			y: 0,
			pressure: 0.5,
			deltaTime: i * 8,
		});
	}
	for (let i = 1; i <= samples; i++) {
		const along = (i / samples) * legPx;
		points.push({
			x: legPx + Math.cos(heading) * along,
			y: Math.sin(heading) * along,
			pressure: 0.5,
			deltaTime: (samples + i) * 8,
		});
	}
	return points;
}

/** Points along a fitted path, `per` per segment. */
function samplePath(
	segments: ReturnType<typeof processStroke>,
	per: number,
): Array<{ x: number; y: number }> {
	const out: Array<{ x: number; y: number }> = [];
	let previousEnd: BezierPoint | undefined;
	for (const segment of segments) {
		const { start, cp1, cp2, end } = resolveSegment(segment, previousEnd);
		for (let i = 1; i <= per; i++) {
			out.push(evalCubicBezier(start, cp1, cp2, end, i / per));
		}
		previousEnd = end;
	}
	return out;
}

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

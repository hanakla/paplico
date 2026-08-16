import type { BezierPoint, Viewport } from "../../schema";
import { anchorTurns, maxTurnNear } from "../../testUtils/strokeGeometry";
import { detectRawCorners, processStroke } from "./strokeFitting";

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

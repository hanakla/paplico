import type { BezierPoint, CubicBezierSegment } from "../schema";
import { evalCubicBezier } from "../utils/geometry/pathSampling";
import { resolveSegment } from "../utils/geometry/segmentOps";

/**
 * Turn angle (deg) at each interior anchor between consecutive fitted
 * segments: measured between the incoming tangent (-cp2 of the previous
 * segment) and the outgoing tangent (cp1 of the next). A sharp corner anchor
 * shows a large turn; tangent-continuous joints show ~0.
 */
export function anchorTurns(
	segments: CubicBezierSegment[],
): { x: number; y: number; turnDeg: number }[] {
	const turns: { x: number; y: number; turnDeg: number }[] = [];
	for (let i = 1; i < segments.length; i++) {
		const inX = -segments[i - 1].cp2.x;
		const inY = -segments[i - 1].cp2.y;
		const outX = segments[i].cp1.x;
		const outY = segments[i].cp1.y;
		const lenIn = Math.hypot(inX, inY);
		const lenOut = Math.hypot(outX, outY);
		if (lenIn < 1e-9 || lenOut < 1e-9) continue;
		const dot = Math.min(
			1,
			Math.max(-1, (inX * outX + inY * outY) / (lenIn * lenOut)),
		);
		const anchor = segments[i - 1].end;
		turns.push({
			x: anchor.x,
			y: anchor.y,
			turnDeg: (Math.acos(dot) * 180) / Math.PI,
		});
	}
	return turns;
}

/** Largest anchor turn (deg) within `radius` of (x, y); 0 when none. */
export function maxTurnNear(
	segments: CubicBezierSegment[],
	x: number,
	y: number,
	radius: number,
): number {
	let max = 0;
	for (const t of anchorTurns(segments)) {
		if (Math.hypot(t.x - x, t.y - y) <= radius) max = Math.max(max, t.turnDeg);
	}
	return max;
}

/**
 * Largest distance a fitted segment travels backwards along its own chord,
 * in world px. A stroke drawn in one direction fits to 0; anything above it
 * is the curve leaving, overshooting and doubling back — the visible
 * fold-back on the canvas.
 */
export function maxChordBackTravel(segments: CubicBezierSegment[]): number {
	let previousEnd: BezierPoint | undefined;
	let worst = 0;

	for (const segment of segments) {
		const { start, cp1, cp2, end } = resolveSegment(segment, previousEnd);
		previousEnd = end;

		const chord = Math.hypot(end.x - start.x, end.y - start.y);
		if (chord < 1e-9) continue;
		const ux = (end.x - start.x) / chord;
		const uy = (end.y - start.y) / chord;

		let previous = 0;
		for (let i = 1; i <= 64; i++) {
			const p = evalCubicBezier(start, cp1, cp2, end, i / 64);
			const projection = (p.x - start.x) * ux + (p.y - start.y) * uy;
			if (projection < previous) worst = Math.max(worst, previous - projection);
			previous = projection;
		}
	}

	return worst;
}

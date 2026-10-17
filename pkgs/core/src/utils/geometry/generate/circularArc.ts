import type { Point } from "../../../schema";

// ---------------------------------------------------------------------------
// Circular arc to cubic bezier conversion
// ---------------------------------------------------------------------------

const ARC_EPSILON = 1e-8;

export interface ArcBezierSegment {
	p0: Point;
	p1: Point;
	p2: Point;
	p3: Point;
	tangentIn: Point;
	tangentOut: Point;
}

/**
 * Convert a circular arc into cubic Bezier segments.
 * Arcs larger than π/2 are subdivided for accuracy.
 */
export function circularArcByCubics(
	center: Point,
	radius: number,
	startAngle: number,
	endAngle: number,
): ArcBezierSegment[] {
	let totalAngle = endAngle - startAngle;
	while (totalAngle > Math.PI * 2) totalAngle -= Math.PI * 2;
	while (totalAngle < -Math.PI * 2) totalAngle += Math.PI * 2;

	if (Math.abs(totalAngle) < ARC_EPSILON) return [];

	const maxArc = Math.PI / 2;
	const numArcs = Math.ceil(Math.abs(totalAngle) / maxArc);
	const arcAngle = totalAngle / numArcs;
	const result: ArcBezierSegment[] = [];

	let currentAngle = startAngle;
	for (let i = 0; i < numArcs; i++) {
		const nextAngle = currentAngle + arcAngle;
		const k = (4 / 3) * Math.tan(arcAngle / 4);

		const cosA = Math.cos(currentAngle);
		const sinA = Math.sin(currentAngle);
		const cosB = Math.cos(nextAngle);
		const sinB = Math.sin(nextAngle);

		const sp: Point = {
			x: center.x + cosA * radius,
			y: center.y + sinA * radius,
		};
		const ep: Point = {
			x: center.x + cosB * radius,
			y: center.y + sinB * radius,
		};

		result.push({
			p0: sp,
			p1: { x: sp.x + -sinA * k * radius, y: sp.y + cosA * k * radius },
			p2: { x: ep.x - -sinB * k * radius, y: ep.y - cosB * k * radius },
			p3: ep,
			tangentIn: { x: -sinA, y: cosA },
			tangentOut: { x: -sinB, y: cosB },
		});

		currentAngle = nextAngle;
	}

	return result;
}

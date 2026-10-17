import type { BezierPoint, CubicBezierSegment } from "../../../schema";

export function generateRectangleSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
): CubicBezierSegment[] {
	const minX = Math.min(start.x, end.x);
	const maxX = Math.max(start.x, end.x);
	const minY = Math.min(start.y, end.y);
	const maxY = Math.max(start.y, end.y);

	// Straight segments joining the four corners as a closed path
	const corners: BezierPoint[] = [
		{ x: minX, y: maxY }, // top-left
		{ x: maxX, y: maxY }, // top-right
		{ x: maxX, y: minY }, // bottom-right
		{ x: minX, y: minY }, // bottom-left
	];

	return createClosedPolygonSegments(corners);
}

/**
 * Regular polygon with a horizontal bottom edge, stretched to fill the box
 * spanned by start/end. Four sides give the same corners as a rectangle.
 */
export function generatePolygonSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
	sides: number,
): CubicBezierSegment[] {
	// Clockwise from the top vertex (the top edge's left end for even sides),
	// matching generateRectangleSegments' corner order.
	const unit = Array.from({ length: sides }, (_, i) => {
		const angle =
			-Math.PI / 2 +
			Math.PI / sides +
			(2 * Math.PI * (Math.floor(sides / 2) - i)) / sides;
		return { x: Math.cos(angle), y: Math.sin(angle) };
	});

	const unitMinX = Math.min(...unit.map((p) => p.x));
	const unitMaxX = Math.max(...unit.map((p) => p.x));
	const unitMinY = Math.min(...unit.map((p) => p.y));
	const unitMaxY = Math.max(...unit.map((p) => p.y));
	const minX = Math.min(start.x, end.x);
	const minY = Math.min(start.y, end.y);
	const width = Math.abs(end.x - start.x);
	const height = Math.abs(end.y - start.y);

	return createClosedPolygonSegments(
		unit.map((p) => ({
			x: minX + ((p.x - unitMinX) / (unitMaxX - unitMinX)) * width,
			y: minY + ((p.y - unitMinY) / (unitMaxY - unitMinY)) * height,
		})),
	);
}

/** Approximated with 4 cubic Bezier curves */
export function generateEllipseSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
): CubicBezierSegment[] {
	const cx = (start.x + end.x) / 2;
	const cy = (start.y + end.y) / 2;
	const rx = Math.abs(end.x - start.x) / 2;
	const ry = Math.abs(end.y - start.y) / 2;

	// Control-point factor for approximating a circle with Bezier curves
	// κ ≈ 0.5522847498
	const kappa = 0.5522847498;
	const kx = rx * kappa;
	const ky = ry * kappa;

	// Draw one quadrant per segment. cp1 and cp2 are relative offsets
	const segments: CubicBezierSegment[] = [
		// right to top: start=(cx+rx, cy), end=(cx, cy+ry)
		{
			start: { x: cx + rx, y: cy },
			cp1: { x: 0, y: ky },
			cp2: { x: kx, y: 0 },
			end: { x: cx, y: cy + ry },
			isMoved: true,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
		// top to left: start=prevEnd=(cx, cy+ry), end=(cx-rx, cy)
		{
			cp1: { x: -kx, y: 0 },
			cp2: { x: 0, y: ky },
			end: { x: cx - rx, y: cy },
			isMoved: false,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
		// left to bottom: start=prevEnd=(cx-rx, cy), end=(cx, cy-ry)
		{
			cp1: { x: 0, y: -ky },
			cp2: { x: -kx, y: 0 },
			end: { x: cx, y: cy - ry },
			isMoved: false,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
		// bottom to right, closing: start=prevEnd=(cx, cy-ry), end=(cx+rx, cy)
		{
			cp1: { x: kx, y: 0 },
			cp2: { x: 0, y: -ky },
			end: { x: cx + rx, y: cy },
			isMoved: false,
			isClosed: true,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
	];

	return segments;
}

export function generateLineSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
): CubicBezierSegment[] {
	// Line: control points sit on the line as relative offsets
	const dx = end.x - start.x;
	const dy = end.y - start.y;

	return [
		{
			start: { x: start.x, y: start.y },
			cp1: { x: dx / 2, y: dy / 2 },
			cp2: { x: -dx / 2, y: -dy / 2 },
			end: { x: end.x, y: end.y },
			isMoved: true,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		},
	];
}

/** Center at start, radius = distance to end, rotates toward mouse position */
export function generateStarSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
	points: number,
	depth: number,
): CubicBezierSegment[] {
	const cx = start.x;
	const cy = start.y;
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const outerRadius = Math.sqrt(dx * dx + dy * dy);
	// An inner corner on the line between two neighbouring tips sits at
	// cos(PI / points) of the outer radius; any farther out it bulges instead
	// of denting, so depth only scales inward from there.
	const innerRadius = outerRadius * Math.cos(Math.PI / points) * (1 - depth);

	// Vertices are placed at (cos, -sin), so negating dy here makes the first
	// tip face the pointer.
	const startAngle = Math.atan2(-dy, dx);

	const vertices: BezierPoint[] = [];
	const angleStep = Math.PI / points;

	for (let i = 0; i < points * 2; i++) {
		const angle = startAngle + i * angleStep;
		const radius = i % 2 === 0 ? outerRadius : innerRadius;
		vertices.push({
			x: cx + Math.cos(angle) * radius,
			y: cy - Math.sin(angle) * radius, // Flip the Y axis
		});
	}

	return createClosedPolygonSegments(vertices);
}

/** Smooth approximation using cubic Bezier curves */
export function generateSpiralSegments(
	start: { x: number; y: number },
	end: { x: number; y: number },
	turns: number,
	direction: 1 | -1,
): CubicBezierSegment[] {
	const cx = start.x;
	const cy = start.y;
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const maxRadius = Math.sqrt(dx * dx + dy * dy);
	const mouseAngle = Math.atan2(-dy, dx);

	const segments: CubicBezierSegment[] = [];
	const totalAngle = turns * 2 * Math.PI * direction;
	const steps = turns * 16;

	for (let i = 0; i < steps; i++) {
		const t0 = i / steps;
		const t1 = (i + 1) / steps;
		const r0 = maxRadius * t0;
		const r1 = maxRadius * t1;
		const dr = r1 - r0;

		const angle0 = mouseAngle + totalAngle * t0;
		const angle1 = mouseAngle + totalAngle * t1;
		const dTheta = angle1 - angle0;

		// Position in world coordinates. angle is screen-based, so flip the Y axis
		const cos0 = Math.cos(angle0);
		const sin0 = Math.sin(angle0);
		const cos1 = Math.cos(angle1);
		const sin1 = Math.sin(angle1);

		const p0 = {
			x: cx + cos0 * r0,
			y: cy - sin0 * r0,
		};
		const p1 = {
			x: cx + cos1 * r1,
			y: cy - sin1 * r1,
		};

		// Tangent of the spiral in world coordinates
		// d/dt [(r·cos θ, r·(-sin θ))] = (dr·cos θ - r·dθ·sin θ, -dr·sin θ - r·dθ·cos θ)
		const tangent0 = {
			x: dr * cos0 - r0 * dTheta * sin0,
			y: -dr * sin0 - r0 * dTheta * cos0,
		};
		const tangent1 = {
			x: dr * cos1 - r1 * dTheta * sin1,
			y: -dr * sin1 - r1 * dTheta * cos1,
		};

		// Control-point distance, empirically 1/3, as a relative offset
		const cp1 = {
			x: tangent0.x / 3,
			y: tangent0.y / 3,
		};
		const cp2 = {
			x: -tangent1.x / 3,
			y: -tangent1.y / 3,
		};

		segments.push({
			start: i === 0 ? p0 : undefined,
			cp1,
			cp2,
			end: p1,
			isMoved: i === 0,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		});
	}

	return segments;
}

// --- Utility Functions ---

function createClosedPolygonSegments(
	vertices: BezierPoint[],
): CubicBezierSegment[] {
	const segments: CubicBezierSegment[] = [];

	for (let i = 0; i < vertices.length; i++) {
		const p1 = vertices[i];
		const p2 = vertices[(i + 1) % vertices.length];

		// Straight segment. cp1 and cp2 are relative offsets
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;
		segments.push({
			start: i === 0 ? p1 : undefined,
			cp1: { x: dx * 0.33, y: dy * 0.33 },
			cp2: { x: -dx * 0.33, y: -dy * 0.33 },
			end: p2,
			isMoved: i === 0,
			isClosed: i === vertices.length - 1 || undefined,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
		});
	}

	return segments;
}

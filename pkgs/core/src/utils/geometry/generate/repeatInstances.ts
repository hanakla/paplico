import type { RepeatObject } from "../../../schema";
import {
	type Affine2D,
	applyAffineToPoint,
	composeAffine,
	IDENTITY_AFFINE,
} from "../space/affine";

/**
 * World-space affine placement for each instance a repeat produces, relative to
 * the source's authored world position. `result[0]` is always the identity.
 * `sourceCenter` is the world-space center of the source union bounds — the
 * pivot the radial ring and the mirror axis are measured from.
 */
export function computeRepeatInstances(
	repeat: RepeatObject,
	sourceCenter: { x: number; y: number },
): Affine2D[] {
	switch (repeat.mode) {
		case "grid":
			return gridInstances(repeat.grid);
		case "radial":
			return radialInstances(repeat.radial, sourceCenter);
		case "mirror":
			return mirrorInstances(repeat.mirror, sourceCenter);
		default:
			return [IDENTITY_AFFINE];
	}
}

/** Max copies per axis, so a tiny spacing over a large region can't explode. */
const GRID_MAX_PER_AXIS = 200;

/** Row / column count that fills `size` at `spacing` (at least 1). */
function gridCountForSize(size: number, spacing: number): number {
	if (spacing <= 0) return 1;
	return Math.min(
		GRID_MAX_PER_AXIS,
		Math.max(1, Math.floor(size / spacing) + 1),
	);
}

/**
 * The grid's fill-region rectangle in the source's authored space. Copies are
 * clipped to it, so the region grows continuously with width/height instead of
 * stepping per copy. It always covers at least the source tile (so a zero-size
 * region still shows the original) and extends right / down from the source
 * top-left (world is Y-up, so down = toward minY).
 */
export function repeatGridRegion(
	repeat: RepeatObject,
	union: { minX: number; minY: number; maxX: number; maxY: number },
): { minX: number; minY: number; maxX: number; maxY: number } {
	return {
		minX: union.minX,
		maxX: Math.max(union.maxX, union.minX + repeat.grid.width),
		minY: Math.min(union.minY, union.maxY - repeat.grid.height),
		maxY: union.maxY,
	};
}

function gridInstances(grid: RepeatObject["grid"]): Affine2D[] {
	const cols = gridCountForSize(grid.width, grid.spacingX);
	const rows = gridCountForSize(grid.height, grid.spacingY);
	const offsetX = grid.offsetX ?? 0;
	const offsetY = grid.offsetY ?? 0;
	const out: Affine2D[] = [];
	for (let r = 0; r < rows; r++) {
		// World space is Y-up, so rows grow downward (screen) at -y. The source
		// (r=0, c=0) stays at the top-left and the grid fills toward bottom-right.
		// Brick offset: odd rows shift right by offsetX.
		const rowShift = r % 2 === 1 ? offsetX : 0;
		const rowY = r === 0 ? 0 : -(r * grid.spacingY);
		for (let c = 0; c < cols; c++) {
			// Odd columns shift down by offsetY (down = -y).
			const colShift = c % 2 === 1 ? -offsetY : 0;
			out.push(translate(c * grid.spacingX + rowShift, rowY + colShift));
		}
	}
	return out;
}

function radialInstances(
	radial: RepeatObject["radial"],
	sourceCenter: { x: number; y: number },
): Affine2D[] {
	const count = Math.max(1, Math.floor(radial.count));
	// The ring is centered on the source object's own center (the pivot), so the
	// whole radial pattern sits around the object. Each copy is the source pushed
	// out by `radius` (upward at angle 0) then rotated about that center.
	const pivot = sourceCenter;
	const base = { x: sourceCenter.x, y: sourceCenter.y - radial.radius };
	// A full turn distributes count slots without the last overlapping the first;
	// a partial sweep spreads them end-to-end across the arc.
	const isFullTurn = Math.abs(radial.sweep) >= Math.PI * 2 - 1e-6;
	const out: Affine2D[] = [];
	for (let i = 0; i < count; i++) {
		const angle =
			radial.startAngle +
			(isFullTurn
				? (Math.PI * 2 * i) / count
				: count > 1
					? (radial.sweep * i) / (count - 1)
					: 0);
		const rot = rotationAbout(angle, pivot.x, pivot.y);
		if (radial.rotateInstances) {
			// Rigid rotation about the center: the copy also faces outward.
			out.push(composeAffine(rot, translate(0, -radial.radius)));
		} else {
			// Position rotates around the ring but orientation stays upright.
			const p = applyAffineToPoint(rot, base);
			out.push(translate(p.x - sourceCenter.x, p.y - sourceCenter.y));
		}
	}
	return out;
}

function mirrorInstances(
	mirror: RepeatObject["mirror"],
	sourceCenter: { x: number; y: number },
): Affine2D[] {
	// The axis normal is perpendicular to the axis; `offset` slides the axis away
	// from the source center along that normal. Using axisAngle - 90deg makes a
	// vertical axis (angle 90deg) slide along +x for a positive offset.
	const normalAngle = mirror.axisAngle - Math.PI / 2;
	const px = sourceCenter.x + Math.cos(normalAngle) * mirror.offset;
	const py = sourceCenter.y + Math.sin(normalAngle) * mirror.offset;
	// The original follows the axis: it rotates about the source center by the
	// axis's deviation from the default vertical axis (90deg), so tilting the
	// axis reorients the original in place. The reflection is that rotated
	// original mirrored across the (tilted) axis, keeping the pair a rigid
	// mirror. (The rotation delta equals normalAngle here, since the default
	// axis is also where the normal offset is zero.)
	const rot = rotationAbout(
		mirror.axisAngle - Math.PI / 2,
		sourceCenter.x,
		sourceCenter.y,
	);
	const reflect = reflectionAbout(mirror.axisAngle, px, py);
	return [rot, composeAffine(reflect, rot)];
}

function translate(tx: number, ty: number): Affine2D {
	return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

function rotationAbout(angle: number, px: number, py: number): Affine2D {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	// R about pivot: p -> R*(p - pivot) + pivot
	return {
		a: cos,
		b: sin,
		c: -sin,
		d: cos,
		e: px - cos * px + sin * py,
		f: py - sin * px - cos * py,
	};
}

function reflectionAbout(axisAngle: number, px: number, py: number): Affine2D {
	// Reflection across a line at `axisAngle` through the origin:
	// [[cos2θ, sin2θ], [sin2θ, -cos2θ]] (determinant -1), then offset to pivot.
	const c2 = Math.cos(2 * axisAngle);
	const s2 = Math.sin(2 * axisAngle);
	return {
		a: c2,
		b: s2,
		c: s2,
		d: -c2,
		e: px - c2 * px - s2 * py,
		f: py - s2 * px + c2 * py,
	};
}

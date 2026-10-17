import {
	readStoredBrushSize,
	readStoredBrushStroking,
	readStoredWetBleedRatio,
} from "../../../brush/access";
import { localAppearances } from "../../../document/appearancePresets";
import type {
	BezierPoint,
	BoundingBox,
	CubicBezierSegment,
	MeshGeometryVertex,
	Path,
	StrokeAppearance,
} from "../../../schema";
import { strokeOuterReach } from "../../elementQuery";
import { evalCubicBezier } from "../primitives/bezier";
import {
	brandLocalBBox,
	brandWorldBBox,
	type LocalBBox,
	type WorldBBox,
} from "../primitives/box";
import type { WorldBezierSegment } from "../space/coordinates";

/**
 * Anchor/control-point bounding box of a raw segment list (no stroke margin).
 * Returns null for an empty list.
 */
export function calculateSegmentListBounds(
	segments: CubicBezierSegment[],
): BoundingBox | null {
	if (segments.length === 0) return null;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	let prevEnd: BezierPoint | undefined;
	for (const segment of segments) {
		const start = segment.start ?? prevEnd!;
		const cp1x = start.x + segment.cp1.x;
		const cp1y = start.y + segment.cp1.y;
		const cp2x = segment.end.x + segment.cp2.x;
		const cp2y = segment.end.y + segment.cp2.y;
		const endX = segment.end.x;
		const endY = segment.end.y;

		// Individual comparisons instead of variadic Math.min/max
		if (start.x < minX) minX = start.x;
		if (cp1x < minX) minX = cp1x;
		if (cp2x < minX) minX = cp2x;
		if (endX < minX) minX = endX;

		if (start.y < minY) minY = start.y;
		if (cp1y < minY) minY = cp1y;
		if (cp2y < minY) minY = cp2y;
		if (endY < minY) minY = endY;

		if (start.x > maxX) maxX = start.x;
		if (cp1x > maxX) maxX = cp1x;
		if (cp2x > maxX) maxX = cp2x;
		if (endX > maxX) maxX = endX;

		if (start.y > maxY) maxY = start.y;
		if (cp1y > maxY) maxY = cp1y;
		if (cp2y > maxY) maxY = cp2y;
		if (endY > maxY) maxY = endY;

		prevEnd = segment.end;
	}

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

/**
 * Bounding box of the curves drawn by world-space segments: anchors plus each
 * cubic's axis extrema, so off-curve control points do not widen it and no
 * stroke margin is added. Returns null for an empty list.
 */
export function calculateSegmentListTightBounds(
	segments: readonly WorldBezierSegment[],
): WorldBBox | null {
	if (segments.length === 0) return null;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const include = (x: number, y: number) => {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	};

	let prevEnd: WorldBezierSegment["end"] | undefined;
	for (const segment of segments) {
		// biome-ignore lint/style/noNonNullAssertion: only the first segment may omit start, and it always carries one
		const start = segment.start ?? prevEnd!;
		const { cp1, cp2, end } = segment;
		include(start.x, start.y);
		include(end.x, end.y);
		for (const t of [
			...cubicExtremaParams(start.x, cp1.x, cp2.x, end.x),
			...cubicExtremaParams(start.y, cp1.y, cp2.y, end.y),
		]) {
			const p = evalCubicBezier(start, cp1, cp2, end, t);
			include(p.x, p.y);
		}
		prevEnd = end;
	}

	return brandWorldBBox({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});
}

/**
 * Calculate bounding box for a path element
 */
export function calculatePathBounds(path: Path): LocalBBox {
	const base = calculateSegmentListBounds(path.segments);
	if (!base) {
		return brandLocalBBox({
			minX: 0,
			minY: 0,
			maxX: 0,
			maxY: 0,
			width: 0,
			height: 0,
		});
	}
	let { minX, minY, maxX, maxY } = base;

	// Inline getStrokeWidth to avoid closure allocation in hot path.
	// Wet-ink extends the bound by `bleedWidth × size` so the wet-edge
	// halo and diffusion region are not culled by the viewport / cache.
	let strokeReach = 0;
	let wetExtra = 0;
	if (path.filters) {
		for (const f of localAppearances(path.filters)) {
			if (f.processor === "stroke" && f.enabled !== false) {
				const brush = (f as StrokeAppearance).paramData.params.brushSettings;
				const size = readStoredBrushSize(brush) ?? 0;
				strokeReach = strokeOuterReach(
					size,
					readStoredBrushStroking(brush)?.align ?? "center",
				);
				wetExtra = size * readStoredWetBleedRatio(brush);
				break;
			}
		}
	}
	const margin = strokeReach + wetExtra;
	minX -= margin;
	minY -= margin;
	maxX += margin;
	maxY += margin;

	return brandLocalBBox({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});
}

/** AABB over mesh vertices + their bezier handles. */
export function calculateMeshCoordinateBounds(
	vertices: readonly MeshGeometryVertex[],
): BoundingBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const include = (point: { x: number; y: number }) => {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	};

	for (const vertex of vertices) {
		include(vertex);
		for (const handle of Object.values(vertex.handles)) include(handle);
	}

	if (!Number.isFinite(minX)) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	}
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

/**
 * Parameters in (0, 1) where one axis of a cubic Bézier turns around, i.e.
 * the roots of its derivative, given that axis's four control values.
 */
function cubicExtremaParams(
	p0: number,
	p1: number,
	p2: number,
	p3: number,
): number[] {
	const a = -p0 + 3 * p1 - 3 * p2 + p3;
	const b = 2 * (p0 - 2 * p1 + p2);
	const c = p1 - p0;
	const eps = 1e-12;

	let roots: number[];
	if (Math.abs(a) < eps) {
		roots = Math.abs(b) < eps ? [] : [-c / b];
	} else {
		const disc = b * b - 4 * a * c;
		if (disc < 0) return [];
		const sq = Math.sqrt(disc);
		roots = [(-b + sq) / (2 * a), (-b - sq) / (2 * a)];
	}
	return roots.filter((t) => t > 0 && t < 1);
}

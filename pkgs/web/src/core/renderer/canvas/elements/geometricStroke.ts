import type {
	BrushSettings,
	CubicBezierSegment,
	LineCap,
	LineJoin,
	Path,
	StrokeAlign,
	StrokeWidthPoint,
} from "../../../schema";
import { splitIntoSubPaths } from "../../../utils/geometry/segmentOps";
import { flattenBezierPathWithPressure } from "../../geometry/bezierFlatten";
import { localCurveTolerance } from "../../geometry/strips/deviceGeometry";
import {
	applyDashPattern,
	polylineArcLength,
	tessellateStroke,
} from "../../geometry/strokeTessellator";
import { computePolylineSignedArea } from "../CanvasLayer.helpers";
import { resolveGeometricSizeByPressure } from "../pipeline/brush/strokeHalfWidth";

/** Everything that shapes the painted band of a geometric-engine stroke. */
export interface GeometricStrokeShape {
	width: number;
	sizeByPressure: number;
	lineCap: LineCap;
	lineJoin: LineJoin;
	miterLimit: number;
	dashArray?: readonly number[];
	dashOffset?: number;
	strokeWidths?: StrokeWidthPoint[];
	pathStart?: number;
	pathEnd?: number;
	align?: StrokeAlign;
}

/**
 * Read the band a geometric-engine stroke paints along `path`, so the
 * renderer and the exporters derive the same shape from the same inputs.
 */
export function resolveGeometricStrokeShape(
	path: Pick<
		Path,
		"strokeWidths" | "strokeWidthsBaked" | "pathStart" | "pathEnd"
	>,
	settings: BrushSettings,
): GeometricStrokeShape {
	const stroking = settings.stroking;
	return {
		width: settings.properties.size?.base ?? 1,
		// Baked paths carry the width in strokeWidths; the live pressure term
		// would apply it twice.
		sizeByPressure: path.strokeWidthsBaked
			? 0
			: resolveGeometricSizeByPressure(settings),
		lineCap: stroking?.lineCap ?? "round",
		lineJoin: stroking?.lineJoin ?? "round",
		miterLimit: stroking?.miterLimit ?? 4,
		dashArray: stroking?.dashArray,
		dashOffset: stroking?.dashOffset,
		strokeWidths: path.strokeWidths,
		pathStart: path.pathStart,
		pathEnd: path.pathEnd,
		align: stroking?.align,
	};
}

/** Whether the band's width changes along the path. */
export function hasVariableStrokeWidth(shape: GeometricStrokeShape): boolean {
	return !!shape.strokeWidths?.length || shape.sizeByPressure !== 0;
}

/**
 * Tessellate a geometric stroke into body triangles at the scale bucket's
 * local tolerance. The triangles overlap; the stroke is their nonzero union.
 */
export function tessellateGeometricStroke(
	segments: CubicBezierSegment[],
	shape: GeometricStrokeShape,
	scaleBucket: number,
	wantArcParams: boolean,
): { triangles: number[]; params: number[] } {
	const curveTolerance = localCurveTolerance(scaleBucket);
	const triangles: number[] = [];
	const params: number[] = [];
	const hasDash = !!shape.dashArray?.length;

	for (const subPath of splitIntoSubPaths(segments)) {
		const { points: flatPoints, pressures: flatPressures } =
			flattenBezierPathWithPressure(subPath, { curveTolerance });
		if (flatPoints.length < 4) continue;

		const isClosed = subPath.at(-1)!.isClosed === true;
		// Resolved on the whole ring: the open fragments a dash split yields
		// carry no winding for the sign to come from.
		const alignShift = resolveAlignShift(shape.align, isClosed, flatPoints);
		let dashPoints = flatPoints;
		let dashPressures = flatPressures;
		// For closed paths with dash, close the polyline before splitting.
		if (hasDash && isClosed) {
			const firstX = flatPoints[0];
			const firstY = flatPoints[1];
			const lastX = flatPoints[flatPoints.length - 2];
			const lastY = flatPoints[flatPoints.length - 1];
			if (Math.abs(firstX - lastX) > 1e-6 || Math.abs(firstY - lastY) > 1e-6) {
				dashPoints = [...flatPoints, firstX, firstY];
				dashPressures = [...flatPressures, flatPressures[0]];
			}
		}

		const subPolylines = hasDash
			? applyDashPattern(
					dashPoints,
					dashPressures,
					shape.dashArray!,
					shape.dashOffset ?? 0,
				)
			: [{ points: flatPoints, pressures: flatPressures, arcOffset: 0 }];

		// Whole-polyline arc length so dash sub-polylines map their local
		// t into the full stroke's range.
		const subPathArcTotal = wantArcParams
			? polylineArcLength(hasDash ? dashPoints : flatPoints)
			: 0;

		for (const { points, pressures, arcOffset } of subPolylines) {
			if (points.length < 4) continue;
			const result = tessellateStroke({
				points,
				pressures,
				baseWidth: shape.width,
				sizeByPressure: shape.sizeByPressure,
				lineCap: shape.lineCap,
				lineJoin: shape.lineJoin,
				miterLimit: shape.miterLimit,
				isClosed: hasDash ? false : isClosed,
				strokeWidths: shape.strokeWidths,
				pathStart: shape.pathStart,
				pathEnd: shape.pathEnd,
				alignShift,
				arcParams: wantArcParams
					? { arcOffset, totalArcLength: subPathArcTotal }
					: undefined,
				zoom: 2 ** scaleBucket,
			});
			for (const v of result.vertices) triangles.push(v);
			if (wantArcParams) {
				for (const v of result.vertexParams) params.push(v);
			}
		}
	}

	return { triangles, params };
}

/**
 * Turn a stroke alignment into the tessellator's signed centerline shift.
 * Only closed subpaths move: an open one has no inside to align to.
 */
function resolveAlignShift(
	align: StrokeAlign | undefined,
	isClosed: boolean,
	flatPoints: number[],
): number {
	if (!isClosed || !align || align === "center") return 0;
	// A positive area (CCW) leaves the left-of-travel normal pointing inward,
	// so the outward shift is the negative one.
	const outward = computePolylineSignedArea(flatPoints) >= 0 ? -1 : 1;
	return align === "outside" ? outward : -outward;
}

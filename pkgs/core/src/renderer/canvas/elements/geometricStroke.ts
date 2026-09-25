import {
	type BrushSettings,
	type CubicBezierSegment,
	type ElementTransform,
	type FillAppearance,
	type Filter,
	generateUid,
	isFilterEnabled,
	isVisibleStroke,
	type LineCap,
	type LineJoin,
	type PathGeometry,
	type SolidColor,
	type StrokeAlign,
	type StrokeAppearance,
	type StrokeWidthPoint,
} from "../../../schema";
import { transformLinearMatrix } from "../../../utils/geometry/geometry";
import { triangleSoupOutline } from "../../../utils/geometry/pathOps";
import { splitIntoSubPaths } from "../../../utils/geometry/segmentOps";
import { flattenBezierPathWithPressure } from "../../geometry/bezierFlatten";
import {
	deviceScaleBucket,
	localCurveTolerance,
} from "../../geometry/strips/deviceGeometry";
import {
	applyDashPattern,
	polylineArcLength,
	tessellateStroke,
} from "../../geometry/strokeTessellator";
import { computePolylineSignedArea } from "../CanvasLayer.helpers";
import { resolveGeometricSizeByPressure } from "../pipeline/brush/strokeHalfWidth";

/** Largest distance, in device pixels, an outlined stroke strays from its band. */
const OUTLINE_FIT_TOLERANCE_PX = 0.1;

/** A stroke whose band outlining can reproduce as a filled shape. */
export type OutlinableStroke = StrokeAppearance & {
	paramData: { params: { strokeColor: SolidColor } };
};

/**
 * Whether outlining can reproduce the stroke as a filled shape: a visible
 * solid-color stroke drawn by the geometric engine.
 */
export function isOutlinableStroke(filter: Filter): filter is OutlinableStroke {
	if (filter.processor !== "stroke" || !isFilterEnabled(filter)) return false;
	const stroke = filter as StrokeAppearance;
	const params = stroke.paramData.params;
	return (
		params.strokeColor.type === "solid" &&
		(params.brushSettings?.engine ?? "geometric") === "geometric" &&
		isVisibleStroke(stroke)
	);
}

/**
 * The fill that paints a stroke's outline: the stroke's color, opacity and
 * blend in its place, carrying the sub-filters the caller keeps on it.
 */
export function strokeToFill(
	stroke: OutlinableStroke,
	subFilters?: Filter[],
): FillAppearance {
	return {
		uid: generateUid("app"),
		processor: "fill",
		enabled: stroke.enabled,
		opacity: stroke.opacity,
		blendMode: stroke.blendMode,
		applyToBackdrop: stroke.applyToBackdrop,
		...(subFilters?.length ? { subFilters } : {}),
		paramData: {
			version: "1",
			params: { fill: stroke.paramData.params.strokeColor },
		},
	};
}

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
	strokeErasure?: StrokeWidthPoint[];
	pathStart?: number;
	pathEnd?: number;
	align?: StrokeAlign;
}

/**
 * Read the band a geometric-engine stroke paints along `path`, so the
 * renderer and the exporters derive the same shape from the same inputs.
 */
export function resolveGeometricStrokeShape(
	path: Omit<PathGeometry, "segments">,
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
		strokeErasure: path.strokeErasure,
		pathStart: path.pathStart,
		pathEnd: path.pathEnd,
		align: stroking?.align,
	};
}

/** Whether the band's width changes along the path. */
export function hasVariableStrokeWidth(shape: GeometricStrokeShape): boolean {
	return (
		!!shape.strokeWidths?.length ||
		!!shape.strokeErasure?.length ||
		shape.sizeByPressure !== 0
	);
}

/**
 * The band a geometric stroke paints along each of `geometries`, as one set
 * of closed cubic subpaths in the geometries' space. The fit stays within
 * {@link OUTLINE_FIT_TOLERANCE_PX} once drawn through `transform`.
 */
export function outlineGeometricStroke(
	geometries: readonly CubicBezierSegment[][],
	shape: GeometricStrokeShape,
	transform: ElementTransform,
): CubicBezierSegment[] {
	const m = transformLinearMatrix(transform);
	const scaleBucket = deviceScaleBucket({
		a: m.m00,
		b: m.m10,
		c: m.m01,
		d: m.m11,
		e: 0,
		f: 0,
	});
	return triangleSoupOutline(
		geometries.flatMap(
			(segments) =>
				tessellateGeometricStroke(segments, shape, scaleBucket, false)
					.triangles,
		),
		OUTLINE_FIT_TOLERANCE_PX / 2 ** scaleBucket,
	);
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
				strokeErasure: shape.strokeErasure,
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

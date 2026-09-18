/**
 * Rough Pre-Filter Processor
 * Deforms path geometry before rendering into an irregular, hand-torn outline.
 *
 * Algorithm:
 * 1. Sample the path at evenly spaced arc-length positions
 * 2. Offset each sample along its normal by a seeded random amount within ±size
 * 3. Connect offset points with straight line segments
 * 4. Optionally round corners with circular arcs (roundCorners > 0)
 */

import type { Appearance, CubicBezierSegment, Filter } from "../../schema";
import { lerpOptionalScalar } from "../../utils/color";
import {
	buildArcLengthTable,
	type SampledPoint,
	samplePathAtArcLength,
} from "../../utils/geometry/pathSampling";
import {
	buildRoundedPolyline,
	buildStraightPolyline,
} from "../../utils/geometry/polylineRounding";
import { splitIntoSubPaths } from "../../utils/geometry/segmentOps";
import { mulberry32 } from "../../utils/math";
import type { FilterHandler } from "../canvas/pipeline/FilterRenderer";

export interface RoughParams {
	/** Maximum displacement perpendicular to the path (in logical units) */
	size: number;
	/** Number of displaced points across the entire path */
	detail: number;
	/** Corner rounding amount (0.0~1.0, 0=sharp corners, 1=fully rounded) */
	roundCorners?: number;
	/** Seed of the displacement sequence; the same seed yields the same shape */
	seed?: number;
}

export interface RoughFilter extends Appearance<RoughParams> {
	processor: "rough";
}

export class RoughFilterHandler implements FilterHandler {
	public async initialize(
		_device: GPUDevice,
		_canvasFormat: GPUTextureFormat,
	): Promise<void> {
		/* no-op: Pre-filter does not use GPU pipelines */
	}

	public preProcess(
		segments: CubicBezierSegment[],
		filter: Filter,
	): CubicBezierSegment[] {
		const { params } = (filter as RoughFilter).paramData;
		const random = mulberry32(params.seed ?? 0);
		const result: CubicBezierSegment[] = [];

		for (const sub of splitIntoSubPaths(segments)) {
			const processed = applyRoughFilter(sub, params, random);
			if (processed.length === 0) continue;
			result.push({ ...processed[0], isMoved: true });
			for (let i = 1; i < processed.length; i++) {
				result.push(processed[i]);
			}
		}

		return result;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as RoughFilter;
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					size: f.paramData.params.size * Math.sqrt(scaleX * scaleY),
				},
			},
		};
	}

	public getExpansionMargin(filter: Filter): number {
		return (filter as RoughFilter).paramData.params.size ?? 0;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as RoughParams;
		const b = paramsB as RoughParams;
		return {
			size: a.size + (b.size - a.size) * t,
			detail: a.detail + (b.detail - a.detail) * t,
			roundCorners: lerpOptionalScalar(a.roundCorners, b.roundCorners, t, 0),
			// A blended seed would reshuffle every intermediate shape
			seed: a.seed,
		} satisfies RoughParams;
	}
}

function applyRoughFilter(
	segments: CubicBezierSegment[],
	{ size, detail, roundCorners = 0 }: RoughParams,
	random: () => number,
): CubicBezierSegment[] {
	if (segments.length === 0) return segments;

	const closed = segments.at(-1)?.isClosed === true;
	const arcLengthTable = buildArcLengthTable(segments);
	const totalLength = arcLengthTable.at(-1)?.cumulativeLength ?? 0;
	if (totalLength < 0.001) return segments;

	// Open paths keep both anchors on the path and displace `detail` points
	// between them; closed paths displace `detail` points around the loop.
	const pointCount = Math.max(1, Math.round(detail));
	const tValues = closed
		? Array.from({ length: pointCount }, (_, i) => i / pointCount)
		: Array.from({ length: pointCount + 2 }, (_, i) => i / (pointCount + 1));

	const points: SampledPoint[] = [];
	for (const [index, t] of tValues.entries()) {
		const sample = samplePathAtArcLength(
			segments,
			arcLengthTable,
			t * totalLength,
			totalLength,
		);
		if (!sample) continue;

		const isAnchor = !closed && (index === 0 || index === tValues.length - 1);
		if (isAnchor) {
			points.push(sample);
			continue;
		}

		const offset = (random() * 2 - 1) * size;
		points.push({
			...sample,
			x: sample.x + sample.normalX * offset,
			y: sample.y + sample.normalY * offset,
		});
	}

	if (points.length < 2) return segments;

	if (roundCorners > 0 && points.length >= 3) {
		return buildRoundedPolyline(points, roundCorners, closed);
	}
	return buildStraightPolyline(points, closed);
}

/**
 * Pucker & Bloat Pre-Filter Processor
 *
 * Moves anchors and control handles toward/away from the subpath centroid
 * to create pucker (star-like) or bloat (balloon-like) effects.
 * Winding-independent: CW/CCW path direction does not affect the result.
 *
 * Algorithm per subpath:
 * 1. Collect anchor points and compute centroid C
 * 2. Each anchor A  →  A' = lerp(A, C,  amount)
 * 3. Each handle H  →  H' = lerp(H, C, -amount)
 * 4. Convert handles back to relative offsets
 */

import type {
	Appearance,
	BezierPoint,
	CubicBezierSegment,
	Filter,
} from "../../schema";
import {
	getStartAnchor,
	resolveCP1,
	resolveCP2,
} from "../../utils/geometry/segmentOps";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";
import type { FilterHandler } from "../canvas/pipeline/FilterRenderer";

export interface PuckerBloatParams {
	/** -2.0 (pucker 200%) ~ +2.0 (bloat 200%). 0 = no effect. */
	amount: number;
}

export interface PuckerBloatFilter extends Appearance<PuckerBloatParams> {
	processor: "pucker-bloat";
}

export class PuckerBloatFilterHandler implements FilterHandler {
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
		const { amount } = (filter as PuckerBloatFilter).paramData.params;
		if (segments.length === 0 || Math.abs(amount) < 1e-9) return segments;

		const subPaths = splitIntoSubPaths(segments);
		const result: CubicBezierSegment[] = [];

		for (const sub of subPaths) {
			const processed = applyPuckerBloat(sub, amount);
			if (processed.length === 0) continue;
			result.push({ ...processed[0], isMoved: true });
			for (let i = 1; i < processed.length; i++) {
				result.push(processed[i]);
			}
		}

		return result;
	}

	public onScaleFilter(params: Filter, _scale: [number, number]): Filter {
		// amount is a dimensionless ratio — scaling does not affect it
		return params;
	}

	public getExpansionMargin(_filter: Filter): number {
		return 0;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as PuckerBloatParams;
		const b = paramsB as PuckerBloatParams;
		return { amount: a.amount + (b.amount - a.amount) * t };
	}
}

// ---------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------

function applyPuckerBloat(
	segments: CubicBezierSegment[],
	amount: number,
): CubicBezierSegment[] {
	const n = segments.length;

	// 1. Collect anchors: [seg0.start, seg0.end, seg1.end, ..., segN-1.end]
	const anchors: BezierPoint[] = [];
	anchors.push(getStartAnchor(segments[0], undefined));
	for (let i = 0; i < n; i++) {
		anchors.push(segments[i].end);
	}

	// Detect closed subpath
	const isClosed = segments[n - 1].isClosed === true;

	// 2. Compute centroid (exclude duplicate closing anchor)
	const anchorCount = isClosed ? n : n + 1;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < anchorCount; i++) {
		cx += anchors[i].x;
		cy += anchors[i].y;
	}
	cx /= anchorCount;
	cy /= anchorCount;

	// 3. Transform anchors: A' = A + amount * (C - A)
	const newAnchors: BezierPoint[] = anchors.map((a) => ({
		...a,
		x: a.x + amount * (cx - a.x),
		y: a.y + amount * (cy - a.y),
	}));

	// Force closing anchor to match first anchor for closed paths
	if (isClosed) {
		newAnchors[n] = {
			...newAnchors[n],
			x: newAnchors[0].x,
			y: newAnchors[0].y,
		};
	}

	// 4. Build output segments
	const result: CubicBezierSegment[] = [];

	for (let i = 0; i < n; i++) {
		const seg = segments[i];
		const oldStart = getStartAnchor(
			seg,
			i > 0 ? segments[i - 1].end : undefined,
		);
		const newStart = newAnchors[i];
		const newEnd = newAnchors[i + 1];

		// Resolve old control handles to absolute coordinates
		const oldCp1Abs = resolveCP1(seg.cp1, oldStart);
		const oldCp2Abs = resolveCP2(seg.cp2, seg.end);

		// Transform handles: H' = H + (-amount) * (C - H)
		const newCp1Abs = {
			x: oldCp1Abs.x + -amount * (cx - oldCp1Abs.x),
			y: oldCp1Abs.y + -amount * (cy - oldCp1Abs.y),
		};
		const newCp2Abs = {
			x: oldCp2Abs.x + -amount * (cx - oldCp2Abs.x),
			y: oldCp2Abs.y + -amount * (cy - oldCp2Abs.y),
		};

		// Convert back to relative offsets
		const newCp1Rel: BezierPoint = {
			...seg.cp1,
			x: newCp1Abs.x - newStart.x,
			y: newCp1Abs.y - newStart.y,
		};
		const newCp2Rel: BezierPoint = {
			...seg.cp2,
			x: newCp2Abs.x - newEnd.x,
			y: newCp2Abs.y - newEnd.y,
		};

		result.push({
			...seg,
			...(seg.start ? { start: newStart } : {}),
			cp1: newCp1Rel,
			cp2: newCp2Rel,
			end: newEnd,
		});
	}

	return result;
}

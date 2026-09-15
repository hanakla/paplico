/**
 * Transform Pre-Filter Processor
 *
 * Scales, reflects, rotates and moves the geometry around a reference point
 * on the input's bounding box, optionally
 * emitting cumulative copies (copy k is the transform applied k times).
 * With `random` on, every step draws its own scale / move / angle from a
 * seeded PRNG in the range [0, specified value], so the result is stable
 * across renders for the same seed. With `transformPatterns` or
 * `scaleStrokes` on, each appearance is drawn once per copy so its pattern
 * paint or stroke width can follow the copy's placement.
 */

import type {
	Appearance,
	BezierPoint,
	CubicBezierSegment,
	Filter,
	StrokeAppearance,
} from "../../schema";
import { calculateSegmentListBounds } from "../../utils/geometry/bounds";
import {
	type Affine2D,
	applyAffineToPoint,
	composeAffine,
	elementTransformToAffine,
	IDENTITY_AFFINE,
	invertAffine,
} from "../../utils/geometry/repeatInterpolation";
import { scaleStrokeAppearance } from "../../utils/geometry/resize";
import {
	getStartAnchor,
	reverseSubPath,
} from "../../utils/geometry/segmentOps";
import { degToRad, lerp, mulberry32 } from "../../utils/math";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";
import {
	type AppearanceGeometry,
	appearancePaintsPattern,
	type FilterHandler,
} from "../canvas/pipeline/FilterRenderer";

export type TransformOrigin =
	| "top-left"
	| "top"
	| "top-right"
	| "left"
	| "center"
	| "right"
	| "bottom-left"
	| "bottom"
	| "bottom-right";

export interface TransformParams {
	/** Horizontal scale ratio. 1 = 100%. */
	scaleX: number;
	/** Vertical scale ratio. 1 = 100%. */
	scaleY: number;
	/** Horizontal move in world units. */
	moveX: number;
	/** Vertical move in world units, positive downward as on screen. */
	moveY: number;
	/** Rotation in degrees, counter-clockwise. */
	angle: number;
	/** Mirror across the vertical axis through the origin. */
	reflectX: boolean;
	/** Mirror across the horizontal axis through the origin. */
	reflectY: boolean;
	/** Number of cumulative copies appended after the original. 0 = transform in place. */
	copies: number;
	/** Reference point on the input bounding box. */
	origin: TransformOrigin;
	/** Draw each step's scale / move / angle from [0, value] using `seed`. */
	random: boolean;
	seed: number;
	/** Whether pattern paints follow each copy's placement. */
	transformPatterns: boolean;
	/** Whether stroke widths scale with each copy's placement. */
	scaleStrokes: boolean;
}

export interface TransformFilter extends Appearance<TransformParams> {
	processor: "transform";
}

export class TransformFilterHandler implements FilterHandler {
	/**
	 * Placement is appearance-independent, but the hook runs once per
	 * appearance drawing the same input; remember the last placement per input
	 * segment list so fill and stroke share one computation.
	 */
	private readonly placed = new WeakMap<
		CubicBezierSegment[],
		{ fingerprint: string; placement: Placement | null }
	>();

	public async initialize(
		_device: GPUDevice,
		_canvasFormat: GPUTextureFormat,
	): Promise<void> {
		/* no-op: Pre-filter does not use GPU pipelines */
	}

	public preProcessAppearance(
		geometry: AppearanceGeometry,
		filter: Filter,
	): AppearanceGeometry[] {
		const params = (filter as TransformFilter).paramData.params;
		const placement = this.place(geometry.segments, filter);
		if (!placement) return [geometry];
		const patternsFollow =
			params.transformPatterns && appearancePaintsPattern(geometry.appearance);
		const strokesScale =
			params.scaleStrokes && geometry.appearance?.processor === "stroke";
		// Only a paint that follows the copies needs a draw per copy; the rest
		// keeps one draw so overlapping copies still union under nonzero fill.
		if (!patternsFollow && !strokesScale) {
			return [{ ...geometry, segments: placement.joined }];
		}
		return placement.copies.map((copy) => ({
			appearance: strokesScale
				? scaleStrokeAppearance(
						geometry.appearance as StrokeAppearance,
						uniformScale(copy.transform),
					)
				: geometry.appearance,
			segments: copy.segments,
			patternTransform: patternsFollow
				? composeAffine(
						geometry.patternTransform ?? IDENTITY_AFFINE,
						invertAffine(copy.transform),
					)
				: geometry.patternTransform,
		}));
	}

	/** The placed copies of `segments`, or null for a no-op. */
	private place(
		segments: CubicBezierSegment[],
		filter: Filter,
	): Placement | null {
		const params = (filter as TransformFilter).paramData.params;
		const fingerprint = JSON.stringify(params);
		const cached = this.placed.get(segments);
		if (cached?.fingerprint === fingerprint) return cached.placement;
		const copies = this.computeCopies(segments, params);
		// The joined list is shared too, so filters after this one see the same
		// array from every appearance and can share their own work on it.
		const placement = copies && {
			copies,
			joined: copies.flatMap((copy) => copy.segments),
		};
		this.placed.set(segments, { fingerprint, placement });
		return placement;
	}

	private computeCopies(
		segments: CubicBezierSegment[],
		params: TransformParams,
	): PlacedCopy[] | null {
		if (segments.length === 0) return null;

		const copies = Math.max(0, Math.floor(params.copies));
		if (copies === 0 && !params.random && isIdentityStep(params)) {
			return null;
		}

		const bounds = calculateSegmentListBounds(segments);
		if (!bounds) return null;
		const origin = resolveOrigin(params.origin, bounds);
		const nextStep = createStepSource(params, origin);

		// copies === 0 replaces the input; copies > 0 keeps the input in front.
		const result: PlacedCopy[] =
			copies === 0 ? [] : [{ segments, transform: IDENTITY_AFFINE }];
		let current = segments;
		let placement = IDENTITY_AFFINE;
		for (let k = 0; k < Math.max(1, copies); k++) {
			const step = nextStep();
			current = transformSegments(current, step);
			placement = composeAffine(step, placement);
			result.push({ segments: current, transform: placement });
		}
		return result;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as TransformFilter;
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					moveX: f.paramData.params.moveX * scaleX,
					moveY: f.paramData.params.moveY * scaleY,
				},
			},
		};
	}

	public getExpansionMargin(
		filter: Filter,
		bounds?: { width: number; height: number },
	): number {
		const params = (filter as TransformFilter).paramData.params;
		const steps = Math.max(1, Math.floor(params.copies));
		if (!bounds) {
			return Math.hypot(params.moveX, params.moveY) * steps;
		}

		// Track how far the box corners travel over every step; random draws
		// stay within [0, value], so the full values bound the displacement,
		// except that a random angle may land anywhere below the maximum —
		// then any corner can swing a full radius around the origin.
		const box = {
			minX: 0,
			minY: 0,
			maxX: bounds.width,
			maxY: bounds.height,
			width: bounds.width,
			height: bounds.height,
		};
		const origin = resolveOrigin(params.origin, box);
		const step = stepAffine(params, origin);
		const swings = params.random && params.angle !== 0;
		let corners = [
			{ x: box.minX, y: box.minY },
			{ x: box.maxX, y: box.minY },
			{ x: box.maxX, y: box.maxY },
			{ x: box.minX, y: box.maxY },
		];
		let margin = 0;
		for (let k = 0; k < steps; k++) {
			corners = corners.map((c) => applyAffineToPoint(step, c));
			for (const c of corners) {
				margin = Math.max(
					margin,
					box.minX - c.x,
					c.x - box.maxX,
					box.minY - c.y,
					c.y - box.maxY,
					swings ? Math.hypot(c.x - origin.x, c.y - origin.y) : 0,
				);
			}
		}
		return margin;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as TransformParams;
		const b = paramsB as TransformParams;
		const pick = <T>(x: T, y: T) => (t < 0.5 ? x : y);
		return {
			scaleX: lerp(a.scaleX, b.scaleX, t),
			scaleY: lerp(a.scaleY, b.scaleY, t),
			moveX: lerp(a.moveX, b.moveX, t),
			moveY: lerp(a.moveY, b.moveY, t),
			angle: lerp(a.angle, b.angle, t),
			reflectX: pick(a.reflectX, b.reflectX),
			reflectY: pick(a.reflectY, b.reflectY),
			copies: Math.round(lerp(a.copies, b.copies, t)),
			origin: pick(a.origin, b.origin),
			random: pick(a.random, b.random),
			seed: pick(a.seed, b.seed),
			transformPatterns: pick(a.transformPatterns, b.transformPatterns),
			scaleStrokes: pick(a.scaleStrokes, b.scaleStrokes),
		} satisfies TransformParams;
	}
}

// ---------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------

/** One output subpath group with the affine that placed it. */
interface PlacedCopy {
	segments: CubicBezierSegment[];
	transform: Affine2D;
}

/** Every copy of one input, plus all of them as one segment list. */
interface Placement {
	copies: PlacedCopy[];
	joined: CubicBezierSegment[];
}

function isIdentityStep(params: TransformParams): boolean {
	return (
		params.scaleX === 1 &&
		params.scaleY === 1 &&
		params.moveX === 0 &&
		params.moveY === 0 &&
		params.angle === 0 &&
		!params.reflectX &&
		!params.reflectY
	);
}

function resolveOrigin(
	origin: TransformOrigin,
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
): { x: number; y: number } {
	const midX = (bounds.minX + bounds.maxX) / 2;
	const midY = (bounds.minY + bounds.maxY) / 2;
	const x = origin.endsWith("left")
		? bounds.minX
		: origin.endsWith("right")
			? bounds.maxX
			: midX;
	const y = origin.startsWith("top")
		? bounds.maxY
		: origin.startsWith("bottom")
			? bounds.minY
			: midY;
	return { x, y };
}

/** Returns a step generator: fixed values, or a fresh random draw per call. */
function createStepSource(
	params: TransformParams,
	origin: { x: number; y: number },
): () => Affine2D {
	if (!params.random) {
		const step = stepAffine(params, origin);
		return () => step;
	}
	const rand = mulberry32(params.seed);
	return () =>
		stepAffine(
			{
				...params,
				scaleX: 1 + (params.scaleX - 1) * rand(),
				scaleY: 1 + (params.scaleY - 1) * rand(),
				moveX: params.moveX * rand(),
				moveY: params.moveY * rand(),
				angle: params.angle * rand(),
			},
			origin,
		);
}

/**
 * One application of the transform as a local affine: scale (with
 * reflection) then rotate about the origin, then move. Move Y reads as on
 * screen while world Y points up, so it is flipped here.
 */
function stepAffine(
	params: TransformParams,
	origin: { x: number; y: number },
): Affine2D {
	return elementTransformToAffine(
		{
			x: params.moveX,
			y: -params.moveY,
			rotation: degToRad(params.angle),
			scaleX: params.scaleX * (params.reflectX ? -1 : 1),
			scaleY: params.scaleY * (params.reflectY ? -1 : 1),
		},
		origin.x,
		origin.y,
	);
}

/** Square root of the affine's area factor: what a stroke width scales by. */
function uniformScale(m: Affine2D): number {
	return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/** The linear part of `m` applied to a relative offset. */
function applyLinear(p: BezierPoint, m: Affine2D): { x: number; y: number } {
	return {
		x: m.a * p.x + m.c * p.y,
		y: m.b * p.x + m.d * p.y,
	};
}

/**
 * Transform a whole segment list as one copy. The first segment always
 * carries an explicit start so the copy stands as its own subpath. A
 * reflecting step flips the winding, so closed subpaths are reversed back
 * to keep filling with the original under the nonzero rule; open ones keep
 * their direction so dashes, profiles and trims read from the same end.
 */
function transformSegments(
	segments: CubicBezierSegment[],
	step: Affine2D,
): CubicBezierSegment[] {
	const moved = moveSegments(segments, step);
	if (step.a * step.d - step.b * step.c >= 0) return moved;
	return splitIntoSubPaths(moved).flatMap((sub) => {
		if (sub.at(-1)?.isClosed !== true || sub.length < 2) return sub;
		const reversed = reverseSubPath(sub);
		return [{ ...reversed[0], isMoved: true }, ...reversed.slice(1)];
	});
}

function moveSegments(
	segments: CubicBezierSegment[],
	step: Affine2D,
): CubicBezierSegment[] {
	return segments.map((seg, i) => {
		const start = getStartAnchor(seg, i > 0 ? segments[i - 1].end : undefined);
		const needsStart = i === 0 || seg.start !== undefined;
		return {
			...seg,
			...(needsStart
				? { start: { ...start, ...applyAffineToPoint(step, start) } }
				: {}),
			...(i === 0 ? { isMoved: true } : {}),
			cp1: { ...seg.cp1, ...applyLinear(seg.cp1, step) },
			cp2: { ...seg.cp2, ...applyLinear(seg.cp2, step) },
			end: { ...seg.end, ...applyAffineToPoint(step, seg.end) },
		};
	});
}

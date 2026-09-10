/**
 * RibbonGenerator - Generate ribbon instance data from bezier segments.
 *
 * Pure function: segments → Float32Array of ribbon instance metadata.
 * GPU vertex shader evaluates bezier curves directly — no CPU mesh generation.
 * Each segment becomes one instanced draw with arc-length prefix sums for UV.
 */

import {
	bakeBrushProperties,
	createBrushInputs,
	evalBrushProperty,
} from "../../../../brush/evaluateProperties";
import { BRUSH_PROPERTY_REGISTRY } from "../../../../brush/properties";
import type {
	BrushColorMode,
	BrushSettings,
	CubicBezierSegment,
	StrokeWidthPoint,
} from "../../../../schema";
import { lerp } from "../../../../utils/math";
import { interpolateStrokeWidths } from "../../../geometry/strokeTessellator";
import { resolveTaper, taperFactor } from "../../../geometry/taper";

/**
 * UV layout mode for ribbon rendering.
 *
 * - "repeat" (pattern brush): tile the texture along the path; U wraps via
 *   the sampler addressMode and the shader writes U = arcPos / tileWidth.
 * - "stretch" (art brush): map the texture exactly once along the path;
 *   U = arcPos / totalArcLength, clamped to [0,1].
 */
export type RibbonUvMode = "repeat" | "stretch";

export interface RibbonOptions {
	uvMode: RibbonUvMode;
	flipU: boolean;
	flipV: boolean;
	/** Gap between tiles as ratio of tile width (0 = no gap; repeat mode only). */
	tileSpacing: number;
	/**
	 * Settings whose size/flow curves modulate the ribbon.
	 * Evaluated at each segment's endpoints and interpolated in between, the
	 * same granularity taper already uses. Absent, the flat pressure factor
	 * applies.
	 */
	curved?: BrushSettings;
}

export const DEFAULT_RIBBON_OPTIONS: RibbonOptions = {
	uvMode: "repeat",
	flipU: false,
	flipV: false,
	tileSpacing: 0,
};

/**
 * Per-segment instance data layout (28 floats = 112 bytes):
 *
 * [0-1]  p0x, p0y          — segment start
 * [2-3]  cp1x, cp1y        — control point 1 (absolute)
 * [4-5]  cp2x, cp2y        — control point 2 (absolute)
 * [6-7]  p1x, p1y          — segment end
 * [8-9]  halfWidth0, halfWidth1 — brush half-width at start/end
 * [10-11] side1Width0, side1Width1 — variable width profile side1
 * [12-13] side2Width0, side2Width1 — variable width profile side2
 * [14]   arcLengthOffset   — cumulative arc length before this segment
 * [15]   segmentArcLength  — this segment's arc length
 * [16-17] pathT0, pathT1   — gradient sampling positions
 * [18]   pathIndex         — u32-in-f32
 * [19]   totalArcLength    — total path arc length (for UV normalization)
 * [20-21] opacity, colorModeBit — opacity and colorMode flag
 * [22-23] joinAngle0, joinAngle1 — junction tangent blend angles (1e30 = no join)
 * [24]   uvModeBit         — 0 = repeat (pattern), 1 = stretch (art); u32-in-f32
 * [25]   flipBits          — bit0 = flipU, bit1 = flipV; u32-in-f32
 * [26]   tileSpacing       — gap between tiles (repeat mode only)
 * [27]   reserved          — padding for 16-byte alignment
 */
export const RIBBON_FLOATS_PER_INSTANCE = 28;

export interface RibbonBuffer {
	data: Float32Array;
	segmentCount: number;
	totalArcLength: number;
}

type CubicCurve = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

interface ResolvedRibbonSegment {
	curve: CubicCurve;
	arcLength: number;
	pathT0: number;
	pathT1: number;
	startPressure: number;
	endPressure: number;
	isMoved: boolean;
}

/** Bitcast helpers (same approach as StampGenerator) */
const _u32 = new Uint32Array(1);
const _f32 = new Float32Array(_u32.buffer);
function u32AsFloat(v: number): number {
	_u32[0] = v;
	return _f32[0];
}

const EMPTY_F32 = new Float32Array(0);

/** What the ribbon geometry needs from the brush, read off BrushSettings. */
export interface RibbonStrokeInput {
	size: number;
	opacity: number;
	flow: number;
	/** Pressure response of the width, 0..1 as the flat layer expressed it. */
	sizeByPressure: number;
	colorMode: BrushColorMode | undefined;
	taperStart: number | undefined;
	taperEnd: number | undefined;
}

export function generateRibbonInstances(
	segments: CubicBezierSegment[],
	settings: RibbonStrokeInput,
	pathIndex: number = 0,
	strokeWidths?: StrokeWidthPoint[],
	options: RibbonOptions = DEFAULT_RIBBON_OPTIONS,
	pathStart: number = 0,
	pathEnd: number = 1,
): RibbonBuffer {
	if (segments.length === 0)
		return { data: EMPTY_F32, segmentCount: 0, totalArcLength: 0 };

	const brushHalfWidth = settings.size * 0.5;
	const hasStrokeWidths = strokeWidths != null && strokeWidths.length > 0;

	// Curve matrix: size scales the half-width, flow scales the opacity.
	const baked = options.curved ? bakeBrushProperties(options.curved) : null;
	const curveInputs = createBrushInputs();
	const sizeBase =
		options.curved?.properties.size?.base ?? BRUSH_PROPERTY_REGISTRY.size.base;
	const evalAt = (
		property: "size" | "flow",
		pressure: number,
		strokeT: number,
	): number => {
		curveInputs.pressure = Math.min(Math.max(pressure, 0), 1);
		curveInputs.strokeT = strokeT;
		curveInputs.fade = strokeT;
		return evalBrushProperty(baked!, property, curveInputs);
	};

	// Pass 1: resolve source segments and their global path ranges.
	const sourceSegments: Array<{
		curve: CubicCurve;
		arcLength: number;
		startPressure: number;
		endPressure: number;
		isMoved: boolean;
	}> = [];
	let totalArcLength = 0;
	let peX = 0;
	let peY = 0;

	for (const segment of segments) {
		const sx = segment.start ? segment.start.x : peX;
		const sy = segment.start ? segment.start.y : peY;
		const c1x = sx + segment.cp1.x;
		const c1y = sy + segment.cp1.y;
		const c2x = segment.end.x + segment.cp2.x;
		const c2y = segment.end.y + segment.cp2.y;
		const ex = segment.end.x;
		const ey = segment.end.y;

		const curve: CubicCurve = [sx, sy, c1x, c1y, c2x, c2y, ex, ey];
		const len = approximateCubicLength(curve);
		sourceSegments.push({
			curve,
			arcLength: len,
			startPressure: segment.startPressure ?? 0.5,
			endPressure: segment.endPressure ?? 0.5,
			isMoved: segment.isMoved ?? false,
		});
		totalArcLength += len;
		peX = ex;
		peY = ey;
	}

	if (totalArcLength < 0.001) {
		return { data: EMPTY_F32, segmentCount: 0, totalArcLength: 0 };
	}

	// Split at every width control point so the GPU's linear per-instance
	// interpolation cannot skip an interior width value on a cubic segment.
	const resolved: ResolvedRibbonSegment[] = [];
	let sourceArcOffset = 0;
	for (const source of sourceSegments) {
		const pathT0 = sourceArcOffset / totalArcLength;
		const pathT1 = (sourceArcOffset + source.arcLength) / totalArcLength;
		const cutPathTs = hasStrokeWidths
			? strokeWidths!
					.map((point) => point.t)
					.filter((position) => position > pathT0 && position < pathT1)
					.toSorted((a, b) => a - b)
			: [];
		const boundaries = [pathT0, ...new Set(cutPathTs), pathT1];
		let remainingCurve = source.curve;
		let previousCurveT = 0;

		for (let i = 1; i < boundaries.length; i++) {
			const piecePathT0 = boundaries[i - 1];
			const piecePathT1 = boundaries[i];
			const arcFraction =
				(piecePathT1 - pathT0) / Math.max(pathT1 - pathT0, 1e-6);
			const curveT =
				i === boundaries.length - 1
					? 1
					: findCubicParameterAtArcFraction(source.curve, arcFraction);
			const relativeCurveT =
				(curveT - previousCurveT) / Math.max(1 - previousCurveT, 1e-6);
			const [piece, remainder] = splitCubic(remainingCurve, relativeCurveT);
			const startPressure = lerp(
				source.startPressure,
				source.endPressure,
				previousCurveT,
			);
			const endPressure = lerp(
				source.startPressure,
				source.endPressure,
				curveT,
			);
			resolved.push({
				curve: piece,
				arcLength: approximateCubicLength(piece),
				pathT0: piecePathT0,
				pathT1: piecePathT1,
				startPressure,
				endPressure,
				isMoved: i === 1 && source.isMoved,
			});
			remainingCurve = remainder;
			previousCurveT = curveT;
		}
		sourceArcOffset += source.arcLength;
	}
	totalArcLength = resolved.reduce(
		(sum, segment) => sum + segment.arcLength,
		0,
	);

	// Entry/exit taper, evaluated at segment endpoints and linear in between.
	const taper = resolveTaper(
		settings.taperStart,
		settings.taperEnd,
		totalArcLength / Math.max(pathEnd - pathStart, 1e-6),
		pathStart,
		pathEnd,
	);

	// Compute start/end tangent angles for junction blending
	const startAngles: number[] = [];
	const endAngles: number[] = [];
	for (let i = 0; i < resolved.length; i++) {
		const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = resolved[i].curve;
		let sdx = c1x - sx;
		let sdy = c1y - sy;
		if (Math.abs(sdx) < 1e-6 && Math.abs(sdy) < 1e-6) {
			sdx = ex - sx;
			sdy = ey - sy;
		}
		startAngles.push(Math.atan2(sdy, sdx));
		let edx = ex - c2x;
		let edy = ey - c2y;
		if (Math.abs(edx) < 1e-6 && Math.abs(edy) < 1e-6) {
			edx = ex - sx;
			edy = ey - sy;
		}
		endAngles.push(Math.atan2(edy, edx));
	}

	// Pass 2: pack instance data
	const segmentCount = resolved.length;
	const data = new Float32Array(segmentCount * RIBBON_FLOATS_PER_INSTANCE);
	let arcLengthOffset = 0;
	const opacity = settings.opacity * settings.flow;
	const colorModeBit = settings.colorMode === "color" ? 1 : 0;
	const uvModeBit = options.uvMode === "stretch" ? 1 : 0;
	const flipBits = (options.flipU ? 1 : 0) | (options.flipV ? 2 : 0);
	const tileSpacing = Math.max(options.tileSpacing, 0);

	for (let i = 0; i < segmentCount; i++) {
		const off = i * RIBBON_FLOATS_PER_INSTANCE;
		const segment = resolved[i];
		const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = segment.curve;
		const segArcLen = segment.arcLength;
		const { pathT0, pathT1 } = segment;

		// Stroke width at segment endpoints
		let s1w0 = 1;
		let s1w1 = 1;
		let s2w0 = 1;
		let s2w1 = 1;
		if (hasStrokeWidths) {
			const w0 = interpolateStrokeWidths(strokeWidths!, pathT0);
			const w1 = interpolateStrokeWidths(strokeWidths!, pathT1);
			s1w0 = w0.side1;
			s1w1 = w1.side1;
			s2w0 = w0.side2;
			s2w1 = w1.side2;
		}

		// Pressure-based half-width at segment endpoints
		const p0 = segment.startPressure;
		const p1 = segment.endPressure;
		let hw0: number;
		let hw1: number;
		if (baked) {
			hw0 = evalAt("size", p0, pathT0) * 0.5;
			hw1 = evalAt("size", p1, pathT1) * 0.5;
		} else {
			const pf0 = 1 - settings.sizeByPressure + settings.sizeByPressure * p0;
			const pf1 = 1 - settings.sizeByPressure + settings.sizeByPressure * p1;
			hw0 = brushHalfWidth * pf0;
			hw1 = brushHalfWidth * pf1;
		}
		if (taper) {
			hw0 *= taperFactor(taper, arcLengthOffset, totalArcLength);
			hw1 *= taperFactor(taper, arcLengthOffset + segArcLen, totalArcLength);
		}

		data[off] = sx;
		data[off + 1] = sy;
		data[off + 2] = c1x;
		data[off + 3] = c1y;
		data[off + 4] = c2x;
		data[off + 5] = c2y;
		data[off + 6] = ex;
		data[off + 7] = ey;
		data[off + 8] = hw0;
		data[off + 9] = hw1;
		data[off + 10] = s1w0;
		data[off + 11] = s1w1;
		data[off + 12] = s2w0;
		data[off + 13] = s2w1;
		data[off + 14] = arcLengthOffset;
		data[off + 15] = segArcLen;
		data[off + 16] = pathT0;
		data[off + 17] = pathT1;
		data[off + 18] = u32AsFloat(pathIndex);
		data[off + 19] = totalArcLength;
		data[off + 20] = baked
			? opacity *
				(evalAt("flow", (p0 + p1) * 0.5, (pathT0 + pathT1) * 0.5) /
					Math.max(BRUSH_PROPERTY_REGISTRY.flow.base, 1e-6))
			: opacity;
		data[off + 21] = colorModeBit;
		// Junction tangent angles for normal blending at segment boundaries
		const NO_JOIN = 1e30;
		let joinAngle0 = NO_JOIN;
		let joinAngle1 = NO_JOIN;

		if (i > 0 && !segment.isMoved) {
			joinAngle0 = angleBisect(endAngles[i - 1], startAngles[i]);
		}
		if (i < segmentCount - 1 && !resolved[i + 1].isMoved) {
			joinAngle1 = angleBisect(endAngles[i], startAngles[i + 1]);
		}
		const isClosed =
			segmentCount > 1 &&
			resolved.slice(1).every((resolvedSegment) => !resolvedSegment.isMoved) &&
			pointsEqual(
				resolved[0].curve[0],
				resolved[0].curve[1],
				resolved.at(-1)!.curve[6],
				resolved.at(-1)!.curve[7],
			);
		if (isClosed && i === 0) {
			joinAngle0 = angleBisect(endAngles.at(-1)!, startAngles[0]);
		}
		if (isClosed && i === segmentCount - 1) {
			joinAngle1 = angleBisect(endAngles.at(-1)!, startAngles[0]);
		}

		data[off + 22] = joinAngle0;
		data[off + 23] = joinAngle1;
		data[off + 24] = u32AsFloat(uvModeBit);
		data[off + 25] = u32AsFloat(flipBits);
		data[off + 26] = tileSpacing;
		data[off + 27] = 0;

		arcLengthOffset += segArcLen;
	}

	return { data, segmentCount, totalArcLength };
}

/** Compute the shortest-arc midpoint angle between two angles in radians. */
function angleBisect(a: number, b: number): number {
	let diff = b - a;
	if (diff > Math.PI) diff -= 2 * Math.PI;
	if (diff < -Math.PI) diff += 2 * Math.PI;
	return a + diff * 0.5;
}

function approximateCubicLength(curve: CubicCurve, endT: number = 1): number {
	let length = 0;
	let [previousX, previousY] = curve;
	for (let i = 1; i <= 10; i++) {
		const [x, y] = cubicPoint(curve, (endT * i) / 10);
		length += Math.hypot(x - previousX, y - previousY);
		previousX = x;
		previousY = y;
	}
	return length;
}

function findCubicParameterAtArcFraction(
	curve: CubicCurve,
	arcFraction: number,
): number {
	const totalLength = approximateCubicLength(curve);
	let lower = 0;
	let upper = 1;
	for (let i = 0; i < 12; i++) {
		const middle = (lower + upper) * 0.5;
		if (approximateCubicLength(curve, middle) / totalLength < arcFraction) {
			lower = middle;
		} else {
			upper = middle;
		}
	}
	return (lower + upper) * 0.5;
}

function splitCubic(curve: CubicCurve, t: number): [CubicCurve, CubicCurve] {
	const [p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y] = curve;
	const p01 = [lerp(p0x, p1x, t), lerp(p0y, p1y, t)] as const;
	const p12 = [lerp(p1x, p2x, t), lerp(p1y, p2y, t)] as const;
	const p23 = [lerp(p2x, p3x, t), lerp(p2y, p3y, t)] as const;
	const p012 = [lerp(p01[0], p12[0], t), lerp(p01[1], p12[1], t)] as const;
	const p123 = [lerp(p12[0], p23[0], t), lerp(p12[1], p23[1], t)] as const;
	const split = [lerp(p012[0], p123[0], t), lerp(p012[1], p123[1], t)] as const;
	return [
		[p0x, p0y, p01[0], p01[1], p012[0], p012[1], split[0], split[1]],
		[split[0], split[1], p123[0], p123[1], p23[0], p23[1], p3x, p3y],
	];
}

function cubicPoint(curve: CubicCurve, t: number): [number, number] {
	const [p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y] = curve;
	const inverseT = 1 - t;
	const inverseTSquared = inverseT * inverseT;
	const tSquared = t * t;
	return [
		inverseTSquared * inverseT * p0x +
			3 * inverseTSquared * t * p1x +
			3 * inverseT * tSquared * p2x +
			tSquared * t * p3x,
		inverseTSquared * inverseT * p0y +
			3 * inverseTSquared * t * p1y +
			3 * inverseT * tSquared * p2y +
			tSquared * t * p3y,
	];
}

function pointsEqual(ax: number, ay: number, bx: number, by: number): boolean {
	return Math.hypot(ax - bx, ay - by) < 1e-6;
}

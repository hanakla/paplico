import { neutralizeSizeCurves } from "../../../../brush/access";
import {
	bakeBrushProperties,
	createBrushInputs,
	evalBrushProperty,
} from "../../../../brush/evaluateProperties";
import type {
	BezierPoint,
	BrushSettings,
	CubicBezierSegment,
	StrokeWidthPoint,
} from "../../../../schema";
import { buildArcLengthTable } from "../../../../utils/geometry/pathSampling";
import { resolveTaper, taperFactor } from "../../../geometry/taper";
import { evaluateDabs } from "./DabEvaluator";
import { readDabField } from "./DabInstanceLayout";

/**
 * UI-facing sampler for the effective stroke half width at any arc-length
 * ratio t, matching what the render pipeline actually draws.
 *
 * - dab: runs the real DabEvaluator once and interpolates its emitted dab
 *   sizes, so speed/random/accel inputs match the render exactly.
 * - ribbon / geometric: mirrors the renderer's closed-form width evaluation.
 *
 * Deliberately NOT reproduced (nominal stamp width is reported instead):
 * the visual outline of textured tips (texture coverage sits inside the
 * stamp bounds) and wet bleed spread.
 */
export interface StrokeHalfWidthSampler {
	/** Pressure/taper-evaluated half width (before side1/side2 ratios) at
	 * whole-stroke arc ratio t, in stored-segment units. */
	halfWidthAt(t: number): number;
}

export function createStrokeHalfWidthSampler(options: {
	storedBrushSettings: BrushSettings | undefined;
	/** Stored path segments (pressure source; arc lengths derived here). */
	segments: CubicBezierSegment[];
	pathStart?: number;
	pathEnd?: number;
	/** Path.strokeWidthsBaked: size curves are neutralized for this path —
	 * the width lives in the strokeWidths profile the caller applies on top. */
	strokeWidthsBaked?: boolean;
}): StrokeHalfWidthSampler | null {
	const { storedBrushSettings, segments } = options;
	if (storedBrushSettings == null || segments.length === 0) return null;

	const pathStart = options.pathStart ?? 0;
	const pathEnd = options.pathEnd ?? 1;
	const { engine } = storedBrushSettings;

	if (options.strokeWidthsBaked) {
		return createCurveSampler(
			segments,
			neutralizeSizeCurves(storedBrushSettings),
			engine === "dab" ? "ribbon" : engine,
			pathStart,
			pathEnd,
		);
	}
	if (engine === "dab") {
		return createDabSampler(segments, storedBrushSettings, pathStart, pathEnd);
	}
	return createCurveSampler(
		segments,
		storedBrushSettings,
		engine,
		pathStart,
		pathEnd,
	);
}

/**
 * The geometric engine's pressure response, read back off the flat slider's
 * two-point curve (`[[0, -k], [1, 0]]`).
 * Multi-point or differently-shaped pressure curves are misread by this
 * inverse — a known limitation shared verbatim with the renderer so that the
 * tool display and the drawn stroke can never disagree.
 */
export function resolveGeometricSizeByPressure(
	settings: BrushSettings,
): number {
	const sizeCurve = settings.properties.size?.curves?.find(
		(curve) => curve.input === "pressure",
	);
	return sizeCurve ? -(sizeCurve.points[0][1] ?? 0) : 0;
}

const BAKE_SAMPLES = 256;
/** Profile simplification tolerance, in width-ratio units (1 = full width). */
const BAKE_TOLERANCE = 0.01;

/**
 * Straight-line profile segments over the stroke's raw input points, keeping
 * each point's real pressure and timestamp. Fitted segments only carry time
 * at their endpoints, so a fast-then-slow run fused into one cubic loses its
 * speed variation to linear interpolation — the bake below must therefore
 * evaluate on this polyline, not on the fitted geometry.
 */
export function polylineSegmentsFromPoints(
	points: BezierPoint[],
): CubicBezierSegment[] {
	const segments: CubicBezierSegment[] = [];
	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1];
		const point = points[i];
		segments.push({
			start: i === 1 ? { x: prev.x, y: prev.y } : undefined,
			cp1: { x: (point.x - prev.x) / 3, y: (point.y - prev.y) / 3 },
			cp2: { x: (prev.x - point.x) / 3, y: (prev.y - point.y) / 3 },
			end: { x: point.x, y: point.y },
			isMoved: i === 1,
			startPressure: prev.pressure,
			endPressure: point.pressure,
			startTiltX: prev.tiltX ?? 0,
			startTiltY: prev.tiltY ?? 0,
			endTiltX: point.tiltX ?? 0,
			endTiltY: point.tiltY ?? 0,
			startTwist: prev.twist,
			endTwist: point.twist,
			startDeltaTime: prev.deltaTime ?? 0,
			endDeltaTime: point.deltaTime ?? 0,
		});
	}
	return segments;
}

/**
 * Materialize the size-curve-driven width profile of a finished brush stroke
 * into strokeWidths ratios (actual half width ÷ base half width). The stored
 * settings are NOT touched — the committed path carries the profile plus the
 * strokeWidthsBaked flag, and renderers skip the size curves for such paths.
 * The curves must survive on the appearance because selection follow copies
 * a committed appearance back into the tool settings, and every following
 * stroke takes its pressure/speed width from them.
 *
 * Pressure and timing live only on the input samples, so without the bake a
 * vertex edit (or the fit's per-segment time linearization) flattens the
 * drawn width; the baked profile survives because it is arc-length
 * parameterized on the path.
 *
 * `segments` should be the raw input polyline (polylineSegmentsFromPoints),
 * not the fitted geometry: fitting fuses samples into few cubics whose
 * linearized timing erases speed-driven width within each segment.
 *
 * Taper is NOT baked — it stays in the settings and keeps applying live on
 * top of the profile, exactly as it composes with size curves today.
 *
 * Returns null when there is nothing to bake (no size curves, no length, or
 * a constant profile — the live curves then reproduce the same width).
 */
export function bakeStrokeWidthProfile(
	settings: BrushSettings | undefined,
	segments: CubicBezierSegment[],
): StrokeWidthPoint[] | null {
	if (settings == null || segments.length === 0) return null;

	const size = settings.properties.size;
	if (!size || (size.curves?.length ?? 0) === 0 || size.base <= 0) return null;

	// Sample without taper so the profile carries only the curve modulation.
	const sampler = createStrokeHalfWidthSampler({
		storedBrushSettings: {
			...settings,
			taperStart: undefined,
			taperEnd: undefined,
		},
		segments,
	});
	if (!sampler) return null;

	const baseHalf = size.base / 2;
	const ts = new Float64Array(BAKE_SAMPLES + 1);
	const ratios = new Float64Array(BAKE_SAMPLES + 1);
	let constant = true;
	for (let i = 0; i <= BAKE_SAMPLES; i++) {
		ts[i] = i / BAKE_SAMPLES;
		ratios[i] = sampler.halfWidthAt(ts[i]) / baseHalf;
		if (Math.abs(ratios[i] - ratios[0]) > 1e-3) constant = false;
	}
	if (constant) return null;

	return simplifyProfile(ts, ratios);
}

/**
 * Greedy polyline simplification of the (t, ratio) profile: keep the sample
 * with the largest linear-interpolation error until every gap is within
 * BAKE_TOLERANCE. Endpoints always survive.
 */
function simplifyProfile(
	ts: Float64Array,
	ratios: Float64Array,
): StrokeWidthPoint[] {
	const last = ts.length - 1;
	const keep = new Uint8Array(ts.length);
	keep[0] = 1;
	keep[last] = 1;

	const stack: Array<[number, number]> = [[0, last]];
	while (stack.length > 0) {
		const [a, b] = stack.pop()!;
		if (b - a < 2) continue;
		let worst = -1;
		let worstError = BAKE_TOLERANCE;
		for (let i = a + 1; i < b; i++) {
			const f = (ts[i] - ts[a]) / (ts[b] - ts[a]);
			const error = Math.abs(
				ratios[i] - (ratios[a] + (ratios[b] - ratios[a]) * f),
			);
			if (error > worstError) {
				worstError = error;
				worst = i;
			}
		}
		if (worst >= 0) {
			keep[worst] = 1;
			stack.push([a, worst], [worst, b]);
		}
	}

	const points: StrokeWidthPoint[] = [];
	for (let i = 0; i < ts.length; i++) {
		if (keep[i]) {
			points.push({ t: ts[i], side1: ratios[i], side2: ratios[i] });
		}
	}
	return points;
}

// --- dab route: interpolate the real evaluator's output --------------------

function createDabSampler(
	segments: CubicBezierSegment[],
	settings: BrushSettings,
	pathStart: number,
	pathEnd: number,
): StrokeHalfWidthSampler | null {
	// No textureAspectRatio option, so sizeX is exactly sizeVal * taperF.
	const buffer = evaluateDabs(segments, settings, { pathStart, pathEnd });
	if (buffer.count === 0) return null;

	const ts = new Float64Array(buffer.count);
	const halves = new Float64Array(buffer.count);
	for (let i = 0; i < buffer.count; i++) {
		ts[i] = readDabField(buffer.data, i, "pathT");
		halves[i] = readDabField(buffer.data, i, "sizeX") * 0.5;
	}

	return {
		halfWidthAt(t: number): number {
			if (t <= ts[0]) return halves[0];
			if (t >= ts[ts.length - 1]) return halves[halves.length - 1];

			let low = 0;
			let high = ts.length - 1;
			while (low < high - 1) {
				const mid = (low + high) >> 1;
				if (ts[mid] <= t) low = mid;
				else high = mid;
			}
			const span = ts[high] - ts[low];
			const mixT = span > 1e-9 ? (t - ts[low]) / span : 0;
			return halves[low] + (halves[high] - halves[low]) * mixT;
		},
	};
}

// --- ribbon / geometric routes: mirror the closed-form evaluation ----------

function createCurveSampler(
	segments: CubicBezierSegment[],
	settings: BrushSettings,
	kind: "ribbon" | "geometric",
	pathStart: number,
	pathEnd: number,
): StrokeHalfWidthSampler | null {
	const arcTable = buildArcLengthTable(segments);
	const totalLength = arcTable[arcTable.length - 1]?.cumulativeLength ?? 0;
	if (totalLength <= 0) return null;

	// The geometric renderer drops taper for closed paths and dashed strokes.
	const taperless =
		kind === "geometric" &&
		(segments.some((segment) => segment.isClosed) ||
			(settings.stroking?.dashArray?.length ?? 0) > 0);
	const taper = taperless
		? null
		: resolveTaper(
				settings.taperStart,
				settings.taperEnd,
				totalLength / Math.max(pathEnd - pathStart, 1e-6),
				pathStart,
				pathEnd,
			);

	const pressureAt = (t: number): number => {
		const target = Math.min(Math.max(t, 0), 1) * totalLength;
		let low = 0;
		let high = arcTable.length - 1;
		while (low < high - 1) {
			const mid = (low + high) >> 1;
			if (arcTable[mid].cumulativeLength <= target) low = mid;
			else high = mid;
		}
		const entry0 = arcTable[low];
		const entry1 = arcTable[high];
		const span = entry1.cumulativeLength - entry0.cumulativeLength;
		const mixT = span > 1e-9 ? (target - entry0.cumulativeLength) / span : 0;
		const segmentIndex =
			entry0.segmentIndex === entry1.segmentIndex || mixT < 0.5
				? entry0.segmentIndex
				: entry1.segmentIndex;
		const localT =
			entry0.segmentIndex === entry1.segmentIndex
				? entry0.localT + (entry1.localT - entry0.localT) * mixT
				: segmentIndex === entry0.segmentIndex
					? entry0.localT + (1 - entry0.localT) * mixT
					: entry1.localT * mixT;
		const segment = segments[segmentIndex];
		const start = segment.startPressure ?? 0.5;
		const end = segment.endPressure ?? 0.5;
		return start + (end - start) * localT;
	};

	let widthAt: (t: number) => number;
	if (kind === "geometric") {
		const base = settings.properties.size?.base ?? 1;
		const sizeByPressure = resolveGeometricSizeByPressure(settings);
		widthAt = (t) => base * 0.5 * (1 - sizeByPressure * (1 - pressureAt(t)));
	} else {
		const baked = bakeBrushProperties(settings);
		const inputs = createBrushInputs();
		widthAt = (t) => {
			inputs.pressure = Math.min(Math.max(pressureAt(t), 0), 1);
			inputs.strokeT = t;
			inputs.fade = t;
			return evalBrushProperty(baked, "size", inputs) * 0.5;
		};
	}

	return {
		halfWidthAt(t: number): number {
			const clamped = Math.min(Math.max(t, 0), 1);
			const taperF = taper
				? taperFactor(taper, clamped * totalLength, totalLength)
				: 1;
			return widthAt(clamped) * taperF;
		},
	};
}

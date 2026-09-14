import type { BezierPoint, CubicBezierSegment } from "../schema";
import {
	IncrementalStrokeFitter,
	type IncrementalStrokeFitterOptions,
} from "../utils/geometry/strokeFitting";

type BrushStrokeSessionOptions = IncrementalStrokeFitterOptions;

type BrushStrokeSessionOutcome = "active" | "committed" | "aborted";

/** Contact samples remain revisable while the stylus pressure settles. */
const IMPACT_WINDOW_MS = 100;
/** Correction starts once the pointer has travelled this many screen pixels. */
const IMPACT_WINDOW_PX = 3;
/** Ignore small pressure noise without excluding light stylus contact. */
const IMPACT_MIN_EXCESS = 0.01;
const IMPACT_MIN_EXCESS_RATIO = 0.25;
/** Cap on how much a held sample's pressure can be lowered. */
const IMPACT_MAX_DROP = 0.5;

/**
 * Owns the input record and its incremental preview fit. Contact samples
 * remain revisable for a bounded time window: once the pointer has moved
 * past the tap radius, each new reference pressure re-evaluates the original
 * samples and rebuilds only this short prefix. Travel alone does not end
 * correction. A tap that lifts
 * inside the window is committed as recorded. After contact settles, the
 * fitter only appends new samples.
 */
export class BrushStrokeSession {
	private readonly points: BezierPoint[] = [];
	private fitter: IncrementalStrokeFitter;
	private readonly options: BrushStrokeSessionOptions;
	private readonly impactWindowWorld: number;
	/** Original contact samples, so repeated correction never compounds. */
	private held: BezierPoint[] | null = [];
	/** Set once the pointer left the tap radius; correction then sticks. */
	private leftTapRadius = false;
	private sessionOutcome: BrushStrokeSessionOutcome = "active";

	public constructor(options: BrushStrokeSessionOptions) {
		this.options = options;
		this.impactWindowWorld = IMPACT_WINDOW_PX / options.zoom;
		this.fitter = new IncrementalStrokeFitter(options);
	}

	public get outcome(): BrushStrokeSessionOutcome {
		return this.sessionOutcome;
	}

	public get pointCount(): number {
		return this.points.length;
	}

	/** Raw point record (live view; commit() returns the same array). */
	public get rawPoints(): BezierPoint[] {
		return this.points;
	}

	/** Points touched by the last append+preview cycle (instrumentation). */
	public get lastProcessedPoints(): number {
		return this.fitter.lastProcessedPoints;
	}

	public append(point: BezierPoint): void {
		if (this.sessionOutcome !== "active") return;
		if (this.held === null) {
			this.points.push(point);
			this.fitter.push(point);
			return;
		}

		this.held.push(point);
		const corrected = this.held.map((sample) => ({ ...sample }));
		const settled = (point.deltaTime ?? 0) >= IMPACT_WINDOW_MS;
		const first = this.held[0];
		this.leftTapRadius ||=
			Math.hypot(point.x - first.x, point.y - first.y) >=
			this.impactWindowWorld;
		if (settled || this.leftTapRadius) {
			suppressImpactSpike(corrected, point.pressure);
		}
		this.points.splice(0, this.points.length, ...corrected);
		this.fitter = new IncrementalStrokeFitter(this.options);
		for (const sample of this.points) this.fitter.push(sample);
		if (settled) this.held = null;
	}

	/** Append a pointermove's coalesced batch in event order. */
	public appendCoalesced(points: readonly BezierPoint[]): void {
		for (const p of points) this.append(p);
	}

	/**
	 * Airbrush hold: while the pointer rests, time keeps flowing. The hold
	 * point repeats the last position with an advanced deltaTime and is part
	 * of the raw record, so replay/collaboration see identical timing.
	 */
	public injectHold(deltaTime: number): void {
		if (this.sessionOutcome !== "active") return;
		const last = this.points[this.points.length - 1];
		if (!last || (last.deltaTime ?? 0) >= deltaTime) return;
		this.append({ ...last, deltaTime });
	}

	public getPreviewSegments(): CubicBezierSegment[] {
		if (this.sessionOutcome !== "active") return [];
		return this.fitter.getSegments();
	}

	/** The preview fit without input knots: the geometry the committed path stores. */
	public getCommitSegments(): CubicBezierSegment[] {
		return this.fitter.getPlainSegments();
	}

	/** Exit 1: hand the raw record to the commit pipeline. */
	public commit(): BezierPoint[] {
		if (this.sessionOutcome === "active") this.sessionOutcome = "committed";
		return this.points;
	}

	/** Exit 2: discard everything. */
	public abort(): void {
		if (this.sessionOutcome !== "active") return;
		this.sessionOutcome = "aborted";
		this.points.length = 0;
	}
}

/**
 * Lower the held pressures toward the reference where they stick out above
 * it. Pressure that the reference explains is kept, so a stroke that starts
 * hard and stays hard is untouched.
 */
function suppressImpactSpike(
	held: BezierPoint[],
	reference: number | undefined,
): void {
	if (reference === undefined) return;
	let peak = 0;
	for (const point of held) {
		if (point.pressure === undefined) return;
		peak = Math.max(peak, point.pressure);
	}
	if (
		peak - reference <=
		Math.max(IMPACT_MIN_EXCESS, reference * IMPACT_MIN_EXCESS_RATIO)
	)
		return;
	for (const point of held) {
		const pressure = point.pressure ?? reference;
		point.pressure = Math.min(
			pressure,
			Math.max(reference, pressure - IMPACT_MAX_DROP),
		);
	}
}

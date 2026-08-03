import type { BezierPoint, CubicBezierSegment } from "../../../../schema";
import {
	IncrementalStrokeFitter,
	type SmoothingMethod,
} from "../../../../utils/geometry/strokeFitting";

export interface BrushStrokeSessionOptions {
	stabilization: number;
	zoom: number;
	smoothingMethod?: SmoothingMethod;
}

export type BrushStrokeSessionOutcome = "active" | "committed" | "aborted";

/**
 * Live-stroke state holder (design §8). Owns the raw point record and the
 * incremental fitter so every pointermove costs O(tail window) instead of
 * O(stroke length). The preview reads getPreviewSegments(); the committed
 * stroke re-fits the raw points through the full processStroke pipeline, so
 * the final geometry is identical to the pre-session behavior.
 *
 * commit() and abort() are the only exits — after either, the session
 * ignores all further input (appendix D lifecycle rule).
 */
export class BrushStrokeSession {
	private readonly points: BezierPoint[] = [];
	private readonly fitter: IncrementalStrokeFitter;
	private sessionOutcome: BrushStrokeSessionOutcome = "active";

	public constructor(options: BrushStrokeSessionOptions) {
		this.fitter = new IncrementalStrokeFitter({
			stabilization: options.stabilization,
			zoom: options.zoom,
			smoothingMethod: options.smoothingMethod,
		});
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
		this.points.push(point);
		this.fitter.push(point);
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

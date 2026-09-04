import type { BrushSettings, CubicBezierSegment } from "../../../../schema";
import {
	type DabEvalState,
	evaluateDabs,
	measureSegmentsLength,
} from "./DabEvaluator";
import { DAB_INSTANCE_FLOATS } from "./DabInstanceLayout";

export interface LiveDabOptions {
	textureAspectRatio?: number;
	variantCount?: number;
	startLayerIndex?: number;
	color?: { r: number; g: number; b: number; a: number };
}

export interface LiveDabFrame {
	/** Backing store of the committed prefix (read count*FLOATS floats). */
	committedData: Float32Array;
	committedCount: number;
	/** Committed dabs appended by this update (suffix of the prefix). */
	appendedCommitted: number;
	/** Volatile tail, re-evaluated every frame. */
	tailData: Float32Array;
	tailCount: number;
	totalCount: number;
	/** True when the accumulator restarted (new stroke / changed settings). */
	reset: boolean;
}

/**
 * Incremental dab evaluation for the live stroke (design §8).
 *
 * The preview fitter keeps frozen segments referentially stable, so the
 * shared object prefix between two frames is exactly the settled geometry.
 * Segments that stayed identical across frames are evaluated once via the
 * DabEvaluator resume state and appended to a committed buffer; only the
 * changing tail re-evaluates per frame. pathT of committed dabs keeps the
 * total-length ratio of its own frame (accepted live approximation — the
 * committed stroke re-evaluates through the normal full path).
 */
export class LiveDabAccumulator {
	private prevSegments: CubicBezierSegment[] = [];
	private committedSegCount = 0;
	private committedData = new Float32Array(0);
	private committedCount = 0;
	private committedState: DabEvalState | null = null;
	private committedLength = 0;
	private fingerprint = "";

	public update(
		segments: CubicBezierSegment[],
		settings: BrushSettings,
		options: LiveDabOptions,
	): LiveDabFrame {
		const fingerprint = JSON.stringify([
			settings,
			options.textureAspectRatio ?? 1,
			options.variantCount ?? 0,
			options.startLayerIndex ?? -1,
			options.color ?? null,
		]);

		let shared = 0;
		const maxShared = Math.min(this.prevSegments.length, segments.length);
		while (
			shared < maxShared &&
			this.prevSegments[shared] === segments[shared]
		) {
			shared++;
		}

		// Reset only when something committed must be discarded: a fingerprint
		// change or a prefix that no longer matches. With nothing committed a
		// fresh stroke needs no teardown — early frames (before the fitter
		// freezes anything) share no references and must not reset each frame.
		let reset = false;
		if (fingerprint !== this.fingerprint || shared < this.committedSegCount) {
			const hadCommitted = this.committedCount > 0;
			this.reset();
			this.fingerprint = fingerprint;
			shared = 0;
			reset = hadCommitted;
		}
		this.prevSegments = segments.slice();

		const evalOptions = {
			textureAspectRatio: options.textureAspectRatio,
			variantCount: options.variantCount,
			startLayerIndex: options.startLayerIndex,
			color: options.color,
		};

		// The last segment always stays volatile: the fitter's tail re-fit may
		// replace it next frame, and a committed-then-replaced segment would
		// force a full reset.
		const freezeLimit = Math.min(shared, segments.length - 1);

		const newlyFrozen = segments.slice(this.committedSegCount, freezeLimit);
		const newlyFrozenLength = measureSegmentsLength(
			newlyFrozen,
			this.committedState ?? undefined,
		);

		const tailSegments = segments.slice(
			this.committedSegCount + newlyFrozen.length,
		);
		const tailStateBase = this.committedState ?? undefined;
		// Tail length continues relative-cp resolution behind the frozen run;
		// measuring from the committed state is only valid when nothing new
		// freezes this frame, so measure the whole uncommitted run instead.
		const uncommittedLength =
			newlyFrozenLength +
			(newlyFrozen.length > 0
				? measureSegmentsLength(segments.slice(freezeLimit), {
						prevEndX: newlyFrozen[newlyFrozen.length - 1].end.x,
						prevEndY: newlyFrozen[newlyFrozen.length - 1].end.y,
						hasPrevEnd: true,
					})
				: measureSegmentsLength(tailSegments, tailStateBase));
		const totalLength = this.committedLength + uncommittedLength;

		let appendedCommitted = 0;
		if (newlyFrozen.length > 0) {
			const result = evaluateDabs(newlyFrozen, settings, {
				...evalOptions,
				resume: this.committedState ?? undefined,
				totalLength,
			});
			this.appendCommitted(result.data, result.count);
			appendedCommitted = result.count;
			this.committedState = result.state;
			this.committedSegCount = freezeLimit;
			this.committedLength += newlyFrozenLength;
		}

		const tail = evaluateDabs(tailSegments, settings, {
			...evalOptions,
			resume: this.committedState ?? undefined,
			totalLength,
		});

		return {
			committedData: this.committedData,
			committedCount: this.committedCount,
			appendedCommitted,
			tailData: tail.data,
			tailCount: tail.count,
			totalCount: this.committedCount + tail.count,
			reset,
		};
	}

	public reset(): void {
		this.prevSegments = [];
		this.committedSegCount = 0;
		this.committedCount = 0;
		this.committedState = null;
		this.committedLength = 0;
		this.fingerprint = "";
	}

	private appendCommitted(data: Float32Array, count: number): void {
		const needed = (this.committedCount + count) * DAB_INSTANCE_FLOATS;
		if (needed > this.committedData.length) {
			const grown = new Float32Array(
				Math.max(needed, this.committedData.length * 2, 256),
			);
			grown.set(this.committedData);
			this.committedData = grown;
		}
		this.committedData.set(
			data.subarray(0, count * DAB_INSTANCE_FLOATS),
			this.committedCount * DAB_INSTANCE_FLOATS,
		);
		this.committedCount += count;
	}
}

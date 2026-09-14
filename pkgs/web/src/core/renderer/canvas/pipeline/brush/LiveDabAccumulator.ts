import type {
	BrushSettings,
	CubicBezierSegment,
	StrokeWidthPoint,
} from "../../../../schema";
import {
	CONTACT_SPEED_WINDOW_MS,
	type DabEvalState,
	evaluateDabs,
	measureSegmentsLength,
} from "./DabEvaluator";
import { DAB_INSTANCE_FLOATS } from "./DabInstanceLayout";

interface LiveDabOptions {
	textureAspectRatio?: number;
	variantCount?: number;
	startLayerIndex?: number;
	color?: { r: number; g: number; b: number; a: number };
	/**
	 * Path.strokeWidths of the preview. A committed dab keeps the width it
	 * was evaluated with; the profile's t drifts a little against the fitted
	 * arc as the raw length grows, which is accepted like pathT is.
	 */
	strokeWidths?: StrokeWidthPoint[];
	strokeWidthsBaked?: boolean;
}

/** Tolerance on a width ratio when matching a committed width point across frames. */
const WIDTH_POINT_EPSILON = 1e-6;
/**
 * Tolerance on a width point's t across frames: t is normalized by the raw
 * polyline length, which grows a little relative to the fitted arc as the
 * stroke continues. This is an accepted live approximation, like pathT.
 */
const WIDTH_T_TOLERANCE = 0.05;

interface LiveDabFrame {
	/** Backing store of the committed prefix (read count*FLOATS floats). */
	committedData: Float32Array;
	committedCount: number;
	/** Committed dabs appended by this update (suffix of the prefix). */
	appendedCommitted: number;
	/** Volatile tail, re-evaluated every frame. */
	tailData: Float32Array;
	tailCount: number;
	totalCount: number;
	/**
	 * True when committed dabs were discarded: a new stroke or changed
	 * settings, a frozen segment that was replaced, or a width profile whose
	 * committed part was rewritten.
	 */
	reset: boolean;
}

/**
 * Incremental dab evaluation for the live stroke.
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
	/** Width profile the committed prefix was evaluated with, and the stroke length its t was read against. */
	private committedWidths: {
		points: StrokeWidthPoint[];
		totalLength: number;
	} | null = null;
	private readonly settingsFingerprints = new WeakMap<BrushSettings, string>();

	public update(
		segments: CubicBezierSegment[],
		settings: BrushSettings,
		options: LiveDabOptions,
	): LiveDabFrame {
		let settingsFingerprint = this.settingsFingerprints.get(settings);
		if (settingsFingerprint === undefined) {
			settingsFingerprint = JSON.stringify(settings);
			this.settingsFingerprints.set(settings, settingsFingerprint);
		}
		const fingerprint = JSON.stringify([
			settingsFingerprint,
			options.textureAspectRatio ?? 1,
			options.variantCount ?? 0,
			options.startLayerIndex ?? -1,
			options.color ?? null,
			options.strokeWidthsBaked ?? false,
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
		// change, a prefix that no longer matches, or a width profile whose
		// committed part was rewritten by a contact correction or by the
		// contact speed window re-evaluating the start. With nothing committed a
		// fresh stroke needs no teardown — early frames (before the fitter
		// freezes anything) share no references and must not reset each frame.
		let reset = false;
		if (
			fingerprint !== this.fingerprint ||
			shared < this.committedSegCount ||
			!this.extendsCommittedWidths(options.strokeWidths)
		) {
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
			strokeWidths: options.strokeWidths,
			strokeWidthsBaked: options.strokeWidthsBaked,
		};

		// The last segment always stays volatile: the fitter's tail re-fit may
		// replace it next frame, and a committed-then-replaced segment would
		// force a full reset. The first freeze also waits until the frozen run
		// reaches past the contact speed window: the speed floor is read off
		// the segments the first evaluation sees, so it must see the window.
		let freezeLimit = Math.min(shared, segments.length - 1);
		if (
			this.committedSegCount === 0 &&
			(freezeLimit === 0 ||
				segments[freezeLimit - 1].endDeltaTime <
					segments[0].startDeltaTime + CONTACT_SPEED_WINDOW_MS)
		) {
			freezeLimit = 0;
		}

		const newlyFrozen = segments.slice(this.committedSegCount, freezeLimit);
		const newlyFrozenLength = measureSegmentsLength(
			newlyFrozen,
			this.committedState ?? undefined,
		);

		const tailSegments = segments.slice(freezeLimit);
		// Tail length continues relative-cp resolution behind the frozen run;
		// measuring from the committed state is only valid when nothing new
		// freezes this frame, so measure the whole uncommitted run instead.
		const uncommittedLength =
			newlyFrozenLength +
			(newlyFrozen.length > 0
				? measureSegmentsLength(tailSegments, {
						prevEndX: newlyFrozen[newlyFrozen.length - 1].end.x,
						prevEndY: newlyFrozen[newlyFrozen.length - 1].end.y,
						hasPrevEnd: true,
					})
				: measureSegmentsLength(
						tailSegments,
						this.committedState ?? undefined,
					));
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
			this.committedWidths = options.strokeWidths
				? { points: options.strokeWidths, totalLength }
				: null;
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
		this.committedWidths = null;
	}

	/**
	 * Whether `next` still carries the width points the committed prefix was
	 * drawn with. Only points inside the committed arc are compared: the
	 * profile's last entries are provisional and move every frame, and the
	 * t of every point shifts a little as the raw length grows.
	 */
	private extendsCommittedWidths(
		next: StrokeWidthPoint[] | undefined,
	): boolean {
		const committed = this.committedWidths;
		if (committed === null) return true;
		if (!next) return false;
		const { points, totalLength } = committed;
		for (let i = 0; i < points.length; i++) {
			const point = points[i];
			if (point.t * totalLength >= this.committedLength) break;
			const other = next[i];
			if (
				!other ||
				Math.abs(other.side1 - point.side1) > WIDTH_POINT_EPSILON ||
				Math.abs(other.side2 - point.side2) > WIDTH_POINT_EPSILON ||
				Math.abs(other.t - point.t) > WIDTH_T_TOLERANCE
			)
				return false;
		}
		return true;
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

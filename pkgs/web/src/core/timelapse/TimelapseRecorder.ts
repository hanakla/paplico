import * as Y from "yjs";
import type { BoundingBox } from "../schema";
import {
	TimelapseBoundsLedger,
	type TimelapseChangeSet,
} from "./timelapseIndex";
import type {
	TimelapseData,
	TimelapseDirtyRect,
	TimelapseEntry,
	TimelapseIndex,
} from "./types";

/**
 * How long (ms) updates that keep touching the same objects are folded into
 * one entry. Playback advances one entry per fixed interval, so recording a
 * tool that writes every frame of a drag as-is would play back several times
 * longer than the drag took.
 */
const COALESCE_WINDOW_MS = 300;

/**
 * Records Yjs updates with timestamps, along with the world rect each update
 * changed. Playback uses the rects to skip updates outside the artboard.
 */
export class TimelapseRecorder {
	private entries: TimelapseEntry[] = [];
	private rects: (TimelapseDirtyRect | null)[] = [];
	/** Entry positions where the state starts over. @see appendBaseline */
	private baselines: number[] = [];
	private startedAt = Date.now();
	private readonly ledger = new TimelapseBoundsLedger();
	/** The entry still accepting updates that touch the same objects. */
	private openGroup: { index: number; key: string } | null = null;

	public constructor(
		private readonly getWorldBounds: (id: string) => BoundingBox | null,
	) {}

	/**
	 * Called from ydoc.on("update").
	 * An update whose `changes` is null (full sync, replaceDocument, layer-only
	 * changes) is recorded with an unknown affected area and is always drawn
	 * during playback.
	 *
	 * An update that touches exactly the objects of the previous entry, and
	 * arrives within COALESCE_WINDOW_MS of that entry's start, is merged into
	 * it instead of opening a new entry. A deletion or an update to different
	 * objects closes the entry.
	 */
	public onYjsUpdate(
		update: Uint8Array,
		changes: TimelapseChangeSet | null,
	): void {
		const t = Date.now() - this.startedAt;
		const rect = this.ledger.track(changes, this.getWorldBounds);
		const key = coalesceKey(changes);

		const group = this.openGroup;
		if (
			key !== null &&
			group?.key === key &&
			t - this.entries[group.index].t < COALESCE_WINDOW_MS
		) {
			const entry = this.entries[group.index];
			entry.u = Y.mergeUpdates([entry.u, update]);
			this.rects[group.index] = unionDirtyRect(this.rects[group.index], rect);
			return;
		}

		this.entries.push({ t, u: update });
		this.rects.push(rect);
		this.openGroup =
			key === null ? null : { index: this.entries.length - 1, key };
	}

	/**
	 * Reseeds the ledger after the document was swapped wholesale.
	 * Without it, the "before" position of elements that predate the swap is
	 * lost, and updates that move them out of the artboard go unrecorded.
	 */
	public seedBounds(elementIds: Iterable<string>): void {
		this.ledger.seed(elementIds, this.getWorldBounds);
	}

	public getTimelapseData(): TimelapseData | null {
		if (this.entries.length === 0) return null;
		return {
			version: 2,
			entries: this.entries,
			index: { rects: this.rects },
			baselines: [...this.baselines],
		};
	}

	/**
	 * Carries over the recording a loaded document brought with it.
	 * The recorder outlives the document, so pass undefined when switching to
	 * a document without a recording. Otherwise the previous document's history
	 * would play back as this one's.
	 */
	public restoreFrom(data: TimelapseData | undefined): void {
		this.openGroup = null;
		this.entries = data ? [...data.entries] : [];
		this.rects = data?.index
			? [...data.index.rects]
			: new Array<TimelapseDirtyRect | null>(this.entries.length).fill(null);
		this.baselines = data?.baselines ? [...data.baselines] : [];
		const lastT = this.entries.at(-1)?.t ?? 0;
		this.startedAt = Date.now() - lastT;
	}

	/**
	 * The document was replaced, so everything from here on is recorded as a
	 * new segment.
	 *
	 * `baseline` is a self-contained update built from the document's content.
	 * The update emitted by the replacement itself must not be used: it is a
	 * diff against the items that existed just before, and Yjs cannot integrate
	 * it into an empty Y.Doc.
	 *
	 * The carried-over recording is kept. Playback recreates its replay document
	 * at this position, so appending to the previous recording never stacks the
	 * same layer twice.
	 */
	public appendBaseline(baseline: Uint8Array): void {
		this.openGroup = null;
		this.baselines.push(this.entries.length);
		this.entries.push({ t: Date.now() - this.startedAt, u: baseline });
		this.rects.push(null);
	}

	/**
	 * Takes the rects rebuilt from a recording without an index and fills in
	 * only the ones still unknown. Entries appended during the rebuild already
	 * have their rects and are left alone.
	 */
	public adoptRebuiltIndex(index: TimelapseIndex): void {
		const count = Math.min(index.rects.length, this.rects.length);
		for (let i = 0; i < count; i++) {
			this.rects[i] ??= index.rects[i];
		}
	}
}

/**
 * Identity of "which objects this update touched", or null when the update
 * must stay its own entry: unknown scope, or a deletion.
 */
function coalesceKey(changes: TimelapseChangeSet | null): string | null {
	if (!changes || changes.deleted.size > 0) return null;
	return [...changes.upserted].sort().join("\0");
}

function unionDirtyRect(
	a: TimelapseDirtyRect | null,
	b: TimelapseDirtyRect | null,
): TimelapseDirtyRect | null {
	if (!a || !b) return null;
	return [
		Math.min(a[0], b[0]),
		Math.min(a[1], b[1]),
		Math.max(a[2], b[2]),
		Math.max(a[3], b[3]),
	];
}

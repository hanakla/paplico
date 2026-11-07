import * as Y from "yjs";
import {
	extractDocumentFromYDoc,
	extractLayersFromYDoc,
	yMapToObject,
} from "../collaboration/extractDocumentFromYDoc";
import { createDefaultDocument } from "../document/factory";
import {
	applyMigrations,
	LATEST_SCHEMA_VERSION,
	needsWholeDocumentMigration,
} from "../io/migrations";
import { decodeTimelapseBlock } from "../io/papf/reader";
import {
	type ChangedElementsAccumulator,
	emptyChanges,
} from "../renderer/changedElements";
import type {
	AnyArtObject,
	Artboard,
	CubicBezierSegment,
	Document,
	Path,
} from "../schema";
import { selectEntriesForArtboard } from "./artboardFilter";
import { TimelapseIndexBuilder } from "./timelapseIndex";
import type {
	PlaybackState,
	TimelapseData,
	TimelapseDirtyRect,
	TimelapseEntry,
	TimelapseFrame,
	TimelapseIndex,
	TimelapsePackedBlock,
} from "./types";

/**
 * Cache scope for replayed frames. The replayed document carries the same
 * element ids as the live one, so without a distinct id the renderer would
 * treat both as the same document and evict the editor's caches every frame.
 */
const TIMELAPSE_REPLAY_DOCUMENT_ID = "__paplico_timelapse_replay__";

interface PathAnimation {
	pathId: string;
	/** The path as recorded, restored once the draw-on animation finishes. */
	element: Path;
	segments: CubicBezierSegment[];
	duration: number;
	elapsed: number;
}

interface Keyframe {
	index: number;
	snapshot: Uint8Array;
}

const EVENT_INTERVAL_MS = 100;
const KEYFRAME_INTERVAL = 50;
/** Snapshots are full document states, so they are thinned instead of piling up. */
const MAX_KEYFRAMES = 64;
const INDEX_BUILD_YIELD_INTERVAL = 200;
const ANIM_MS_PER_SEGMENT = 30;
const ANIM_MIN_MS = 200;
const ANIM_MAX_MS = 2000;

const INTRO_COMPLETE_MS = 400;
const INTRO_FADEOUT_MS = 300;

/**
 * Timelapse playback engine.
 * Sequentially applies Yjs updates to an empty Y.Doc to reconstruct the Document,
 * animating path segments when a new path appears.
 *
 * Cost per frame is kept proportional to what actually changed:
 * - entries whose recorded rect misses the target artboard are applied to the
 *   replay document but neither rebuilt nor drawn
 * - the reconstructed Document is patched per changed object instead of being
 *   extracted whole
 * - seeking forward reuses the replay document; only seeking backwards rewinds
 *   to a keyframe
 *
 * Packed blocks are expanded one at a time, when an entry inside one is
 * applied. Expanding them all would take several times the document's memory.
 * Expanding is asynchronous, so everything that walks the replay document
 * runs as one queued task at a time.
 *
 * Intro sequence: shows the completed work for INTRO_COMPLETE_MS, then
 * fades out over INTRO_FADEOUT_MS before starting normal playback.
 */
export class TimelapsePlayer {
	private replayDoc: Y.Doc;
	private packedBlocks: readonly TimelapsePackedBlock[];
	/** Entry position each packed block starts at, ascending. */
	private blockStarts: number[];
	/** The expanded entries after the packed blocks, starting at `tailStart`. */
	private tailEntries: TimelapseEntry[];
	private tailStart: number;
	/** The only packed block kept expanded. */
	private heldBlock: { start: number; entries: TimelapseEntry[] } | null = null;
	/** Settles once every queued replay task has run. @see enqueue */
	private replayQueue: Promise<unknown> = Promise.resolve();
	/** The position the latest seekTo asked for. Seeks queued before it skip. */
	private seekTarget: number | null = null;
	private index: TimelapseIndex | undefined;
	/** Entry positions where the recorded state starts over (document switch), ascending. */
	private baselines: readonly number[];
	private schemaVersions: NonNullable<TimelapseData["schemaVersions"]>;

	/** Entry indices worth drawing for the target artboard. */
	private visible: number[];
	/** Position within `visible`. -1 = nothing applied yet. */
	private visibleCursor = -1;
	private appliedUpToIndex = -1;

	private keyframes: Keyframe[] = [];
	private keyframeInterval = KEYFRAME_INTERVAL;

	/** Reconstructed document, patched in place. null forces a full extract. */
	private currentDoc: Document | null = null;

	private activePathAnim: PathAnimation | null = null;
	/** Path the previous frame showed shortened, whose object the next frame replaces. */
	private lastAnimatedPathId: string | null = null;
	private isPlaying = false;
	private isPreparing = false;
	private disposed = false;
	private speed = 1;
	private animFrameId: number | null = null;
	private lastTickTimestamp: number | null = null;
	private playbackTime = 0;

	// Intro sequence state
	private introPhase: "complete" | "fadeOut" | null = null;
	private introElapsed = 0;

	/**
	 * What the applied updates touched since the last emitted frame.
	 * `other` covers everything the Document carries besides objects and
	 * layers (artboards, meta, embedded files, brush presets, defs, 3D refs)
	 * and forces a full re-extract, which stays cheap because those change
	 * rarely during a drawing session.
	 * @see setupChangeTracking
	 */
	private touched = createTouchedState();

	public constructor(
		data: TimelapseData,
		private callbacks: {
			onFrame: (frame: TimelapseFrame) => void;
			onStateChange: (state: PlaybackState) => void;
			/** The live document, which is what the recording ends at. */
			getCompletedDocument: () => Document;
			/** Fired once a missing index has been rebuilt, so it can be persisted. */
			onIndexBuilt?: (index: TimelapseIndex) => void;
		},
		private filterArtboard?: Artboard,
	) {
		this.replayDoc = new Y.Doc();
		this.packedBlocks = data.packedBlocks ?? [];
		let start = 0;
		this.blockStarts = this.packedBlocks.map((block) => {
			const blockStart = start;
			start += block.count;
			return blockStart;
		});
		this.tailEntries = data.entries;
		this.tailStart = start;
		this.index = data.index;
		this.baselines = [...(data.baselines ?? [])].sort((a, b) => a - b);
		this.schemaVersions = data.schemaVersions ?? [];
		this.visible = selectEntriesForArtboard(
			this.entryCount,
			this.index,
			this.filterArtboard,
		);
		this.setupChangeTracking();
		// The timeline's length is known now, while the first seek may still
		// be waiting on a block.
		this.emitState();

		if (!this.index) void this.buildIndexAsync();
	}

	public get totalEvents(): number {
		return this.visible.length;
	}

	public get currentIndex(): number {
		return this.visibleCursor;
	}

	// --- Playback control ---

	public play(): void {
		if (this.isPlaying) return;
		this.isPlaying = true;
		this.lastTickTimestamp = performance.now();

		const atEnd = this.visibleCursor >= this.visible.length - 1;
		const atStart = this.visibleCursor <= 0;

		if (atEnd || atStart) {
			// Start intro sequence: show completed work, then fade out, then replay
			this.introPhase = "complete";
			this.introElapsed = 0;
			void this.enqueue(async () => this.resetReplay());
			this.callbacks.onFrame({
				document: this.buildCompletedDocument(),
				changedElements: undefined,
			});
		}

		this.animFrameId = requestAnimationFrame(this.tick);
		this.emitState();
	}

	public pause(): void {
		this.isPlaying = false;
		this.introPhase = null;
		if (this.animFrameId != null) {
			cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}
		this.lastTickTimestamp = null;
		this.emitState();
	}

	public setSpeed(speed: number): void {
		this.speed = speed;
		this.emitState();
	}

	/** Seek to a position in the filtered timeline. */
	public seekTo(visibleIndex: number): Promise<void> {
		this.introPhase = null;
		this.seekTarget = visibleIndex;
		return this.enqueue(async () => {
			// Dragging the seek bar queues a seek per move, and only the last
			// position is still worth walking to.
			if (this.seekTarget !== visibleIndex) return;
			await this.seekInternal(visibleIndex);
			this.emitFrame();
			this.emitState();
		});
	}

	/** The finished artwork, used as the first frame of an export. */
	public captureCompletedFrame(): Document {
		return this.buildCompletedDocument();
	}

	/**
	 * Move the playback clock forward and hand back the frame to show, or null
	 * when this step produced nothing new.
	 *
	 * Both the preview loop and the exporter drive playback through here, so a
	 * recording is drawn on the same timeline either way — including the
	 * segment-by-segment draw-on of each new path, which the video would
	 * otherwise skip straight past.
	 */
	public advanceBy(elapsedMs: number): Promise<TimelapseFrame | null> {
		return this.enqueue(async () => {
			switch (await this.stepClock(elapsedMs)) {
				case "drawOn":
					return this.consumeFrame();
				case "entry":
					return this.consumeFrame(true);
				default:
					return null;
			}
		});
	}

	/**
	 * Move the playback clock forward exactly as advanceBy does, without
	 * building the frame. For walking a recording when only its length on the
	 * clock matters. The next frame handed out is rebuilt in full.
	 */
	public skipBy(elapsedMs: number): Promise<void> {
		return this.enqueue(async () => {
			if ((await this.stepClock(elapsedMs)) !== "entry") return;

			const addedIds = [...this.touched.added];
			this.touched = createTouchedState();
			this.currentDoc = null;
			this.startPathAnimationIfNewPath(addedIds, (id) => this.readObject(id));
		});
	}

	/** True once every visible entry has played and no draw-on is running. */
	public get hasFinished(): boolean {
		return (
			!this.activePathAnim && this.visibleCursor + 1 >= this.visible.length
		);
	}

	/** Rewind to a blank canvas, for an export that walks the whole recording. */
	public restart(): Promise<TimelapseFrame> {
		return this.enqueue(async () => {
			this.resetReplay();
			return this.consumeFrame();
		});
	}

	public dispose(): void {
		this.disposed = true;
		this.pause();
		void this.enqueue(async () => this.replayDoc.destroy());
	}

	// --- Internal ---

	private setupChangeTracking(): void {
		const doc = this.replayDoc;
		const markOther = () => {
			this.touched.other = true;
		};

		doc.getMap("animation").observeDeep(() => {
			this.touched.animation = true;
		});

		doc.getMap("objects").observeDeep((events) => {
			for (const event of events) {
				if (event.path.length > 0) {
					this.touched.upserted.add(event.path[0] as string);
					continue;
				}
				if (!(event instanceof Y.YMapEvent)) continue;
				for (const [key, change] of event.changes.keys) {
					if (change.action === "delete") {
						this.touched.deleted.add(key);
						continue;
					}
					this.touched.upserted.add(key);
					if (change.action === "add") this.touched.added.add(key);
				}
			}
		});

		doc.getArray("layers").observeDeep(() => {
			this.touched.layers = true;
		});
		doc.getArray("artboards").observe(markOther);
		doc.getMap("meta").observe(markOther);
		// Extracted into the Document but never patched incrementally.
		doc.getMap("files").observe(markOther);
		doc.getMap("brushPresets").observe(markOther);
		doc.getMap("appearancePresets").observe(markOther);
		doc.getMap("defs").observeDeep(markOther);
		doc.getMap("references3d").observeDeep(markOther);
	}

	private tick = async (): Promise<void> => {
		const now = performance.now();
		const elapsed = now - this.lastTickTimestamp!;
		this.lastTickTimestamp = now;

		// Intro phase: speed does not affect intro timing
		if (this.introPhase === "complete") {
			this.introElapsed += elapsed;
			if (this.introElapsed >= INTRO_COMPLETE_MS) {
				this.introPhase = "fadeOut";
				this.introElapsed = 0;
			}
			this.emitState();
			this.animFrameId = requestAnimationFrame(this.tick);
			return;
		}

		if (this.introPhase === "fadeOut") {
			this.introElapsed += elapsed;
			if (this.introElapsed >= INTRO_FADEOUT_MS) {
				this.introPhase = null;
				// Show the first frame (blank canvas) and begin normal playback
				void this.enqueue(async () => this.emitFrame());
			}
			this.emitState();
			this.animFrameId = requestAnimationFrame(this.tick);
			return;
		}

		const frameId = this.animFrameId;
		const frame = await this.advanceBy(elapsed);
		// A pause while the step waited on a block ends this loop, and a play
		// after it has already started another.
		if (this.animFrameId !== frameId) return;
		if (frame) {
			this.callbacks.onFrame(frame);
			this.emitState();
		} else if (this.hasFinished) {
			this.pause();
			return;
		}

		if (this.isPlaying) {
			this.animFrameId = requestAnimationFrame(this.tick);
		}
	};

	/**
	 * Move the playback clock forward and report what the step reached: a
	 * draw-on still running or just ended, a newly applied entry that changed
	 * the drawing, or nothing new to show.
	 */
	private async stepClock(
		elapsedMs: number,
	): Promise<"drawOn" | "entry" | null> {
		const scaled = elapsedMs * this.speed;

		if (this.activePathAnim) {
			this.activePathAnim.elapsed += scaled;
			if (this.activePathAnim.elapsed >= this.activePathAnim.duration) {
				this.clearPathAnimation();
			}
			return "drawOn";
		}

		if (this.hasFinished) return null;

		this.playbackTime += scaled;
		if (this.playbackTime < EVENT_INTERVAL_MS) return null;
		this.playbackTime -= EVENT_INTERVAL_MS;

		const nextCursor = this.visibleCursor + 1;
		await this.applyEntriesUpTo(this.visible[nextCursor]);
		this.visibleCursor = nextCursor;

		// Animation-track edits leave the drawing untouched.
		if (this.touched.animation && !hasDocumentChange(this.touched)) {
			this.touched = createTouchedState();
			return null;
		}

		return "entry";
	}

	private async seekInternal(visibleIndex: number): Promise<void> {
		const target = Math.max(
			-1,
			Math.min(visibleIndex, this.visible.length - 1),
		);
		this.clearPathAnimation();

		const entryIndex = target < 0 ? -1 : this.visible[target];
		if (entryIndex < this.appliedUpToIndex) await this.rewindTo(entryIndex);
		else await this.applyEntriesUpTo(entryIndex);

		this.visibleCursor = target;
	}

	/** Apply every entry up to and including `entryIndex`, without drawing. */
	private async applyEntriesUpTo(entryIndex: number): Promise<void> {
		for (let i = this.appliedUpToIndex + 1; i <= entryIndex; i++) {
			const entry = this.loadedEntry(i) ?? (await this.expandBlockOf(i));
			// A baseline entry stands on its own. Everything recorded before it
			// belongs to a document that was swapped out, and its items would
			// stack on top of the new ones — the same layer twice.
			if (this.baselines.includes(i)) this.recreateReplayDoc();
			Y.applyUpdate(this.replayDoc, entry.u);
			this.appliedUpToIndex = i;
			this.captureKeyframe(i);
		}
	}

	private get entryCount(): number {
		return this.tailStart + this.tailEntries.length;
	}

	/**
	 * Run a task that walks the replay document after every task queued before
	 * it. A walk waits whenever it expands a block, and another walk starting
	 * meanwhile would apply entries to the same document out of order.
	 */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.replayQueue.then(task);
		this.replayQueue = run.catch(() => {});
		return run;
	}

	/** An entry that needs no expanding: one after the packed blocks, or one in the held block. */
	private loadedEntry(entryIndex: number): TimelapseEntry | undefined {
		if (entryIndex >= this.tailStart) {
			return this.tailEntries[entryIndex - this.tailStart];
		}
		const held = this.heldBlock;
		if (!held || entryIndex < held.start) return undefined;
		return held.entries[entryIndex - held.start];
	}

	/** Expand the packed block holding `entryIndex` in place of the held one. */
	private async expandBlockOf(entryIndex: number): Promise<TimelapseEntry> {
		const blockIndex = this.blockStarts.findLastIndex(
			(start) => start <= entryIndex,
		);
		// Let go of the held block first, so both are never expanded at once.
		this.heldBlock = null;
		const start = this.blockStarts[blockIndex];
		const entries = await decodeTimelapseBlock(this.packedBlocks[blockIndex]);
		this.heldBlock = { start, entries };
		return entries[entryIndex - start];
	}

	/** Every entry in order, expanding one packed block at a time. */
	private async *allEntries(): AsyncGenerator<TimelapseEntry> {
		for (const block of this.packedBlocks) {
			yield* await decodeTimelapseBlock(block);
		}
		yield* this.tailEntries;
	}

	/**
	 * The last position at or before `entryIndex` where the state starts over,
	 * which is the start of the recording when no baseline comes before it.
	 */
	private baselineAtOrBefore(entryIndex: number): number {
		let found = 0;
		for (const baseline of this.baselines) {
			if (baseline > entryIndex) break;
			found = baseline;
		}
		return found;
	}

	private recreateReplayDoc(): void {
		this.replayDoc.destroy();
		this.replayDoc = new Y.Doc();
		this.setupChangeTracking();
		this.touched = createTouchedState();
		this.currentDoc = null;
	}

	/** Rebuild the replay document from the nearest keyframe at or before the target. */
	private async rewindTo(entryIndex: number): Promise<void> {
		// A keyframe from before the last baseline holds the superseded
		// document, so the walk has to restart at the baseline instead.
		const baseline = this.baselineAtOrBefore(entryIndex);
		let startIndex = -1;
		let snapshot: Uint8Array | null = null;
		for (const keyframe of this.keyframes) {
			if (keyframe.index > entryIndex) break;
			if (keyframe.index < baseline) continue;
			startIndex = keyframe.index;
			snapshot = keyframe.snapshot;
		}

		this.recreateReplayDoc();

		if (snapshot) Y.applyUpdate(this.replayDoc, snapshot);
		// Without a usable keyframe, start at the baseline rather than at zero:
		// the entries before it build a document this one replaces.
		this.appliedUpToIndex = snapshot ? startIndex : baseline - 1;
		await this.applyEntriesUpTo(entryIndex);
	}

	private resetReplay(): void {
		this.recreateReplayDoc();
		this.appliedUpToIndex = -1;
		this.visibleCursor = -1;
		this.activePathAnim = null;
		this.playbackTime = 0;
	}

	private captureKeyframe(entryIndex: number): void {
		const lastIndex = this.keyframes.at(-1)?.index ?? -1;
		if (entryIndex < lastIndex + this.keyframeInterval) return;

		this.keyframes.push({
			index: entryIndex,
			snapshot: Y.encodeStateAsUpdate(this.replayDoc),
		});

		if (this.keyframes.length > MAX_KEYFRAMES) {
			this.keyframes = this.keyframes.filter((_, i) => i % 2 === 0);
			this.keyframeInterval *= 2;
		}
	}

	/**
	 * Start the draw-on of the first path among `addedIds`. A frame resolves
	 * them from its document, where each was migrated with its parents.
	 */
	private startPathAnimationIfNewPath(
		addedIds: readonly string[],
		resolveElement: (id: string) => AnyArtObject | null | undefined,
	): void {
		for (const addedId of addedIds) {
			const element = resolveElement(addedId);
			if (element?.type !== "path" || element.segments.length === 0) continue;

			this.activePathAnim = {
				pathId: element.id,
				element,
				segments: element.segments,
				duration: Math.min(
					ANIM_MAX_MS,
					Math.max(ANIM_MIN_MS, element.segments.length * ANIM_MS_PER_SEGMENT),
				),
				elapsed: 0,
			};
			return;
		}
	}

	private clearPathAnimation(): void {
		// The shortened path only ever lived on the emitted frame, never on the
		// accumulator, so there is nothing to put back.
		this.activePathAnim = null;
	}

	private emitFrame(): void {
		this.callbacks.onFrame(this.consumeFrame());
	}

	/**
	 * Bring the reconstructed Document up to date and overlay any draw-on
	 * animation. `animateNewPath` starts a draw-on for a path the applied
	 * entries added.
	 */
	private consumeFrame(animateNewPath = false): TimelapseFrame {
		const addedIds = animateNewPath ? [...this.touched.added] : [];
		const frame = this.syncDocument();
		if (addedIds.length > 0) {
			this.startPathAnimationIfNewPath(
				addedIds,
				(id) => frame.document.objects[id],
			);
		}
		const animation = this.activePathAnim;
		// The draw-on hands out a fresh shortened copy of its path every frame,
		// and the frame after it ends puts the recorded path back.
		if (frame.changedElements) {
			for (const id of [this.lastAnimatedPathId, animation?.pathId]) {
				if (id == null || frame.changedElements.deleted.has(id)) continue;
				frame.changedElements.upserted.add(id);
			}
		}
		this.lastAnimatedPathId = animation?.pathId ?? null;
		if (!animation) return frame;

		const progress = Math.min(1, animation.elapsed / animation.duration);
		const visibleCount = Math.max(
			1,
			Math.ceil(animation.segments.length * progress),
		);
		frame.document.objects[animation.pathId] = {
			...animation.element,
			segments: animation.segments.slice(0, visibleCount),
		};
		return frame;
	}

	/**
	 * Patch the reconstructed Document with whatever the applied updates touched,
	 * and hand back a frame the renderer will actually re-read.
	 *
	 * The accumulator is kept across frames so objects are not re-parsed from
	 * Yjs every time, but the frame itself has to be a new object: handing the
	 * renderer the same Document twice makes it redraw the first one, so the
	 * preview freezes on whatever was on screen when playback started.
	 *
	 * A full re-extract rebuilds every object, so it reports no change set.
	 */
	private syncDocument(): {
		document: Document;
		changedElements: ChangedElementsAccumulator | undefined;
	} {
		const touched = this.touched;
		this.touched = createTouchedState();

		// Anything outside objects and layers is rare enough that re-extracting
		// the whole document beats maintaining a patch path for each of them.
		// A migration that reads other elements cannot run on a lone object
		// read either.
		if (
			!this.currentDoc ||
			touched.other ||
			needsWholeDocumentMigration(this.replayedSchemaVersion())
		) {
			const document = extractDocumentFromYDoc(this.replayDoc, {
				skipUnreadableObjects: true,
			});
			document.schemaVersion = this.replayedSchemaVersion();
			applyMigrations(document);
			document.id = TIMELAPSE_REPLAY_DOCUMENT_ID;
			this.currentDoc = document;
			return {
				document: { ...document, objects: { ...document.objects } },
				changedElements: undefined,
			};
		}

		const document = this.currentDoc;
		if (touched.layers) {
			document.layers = extractLayersFromYDoc(this.replayDoc);
		}

		const changedElements = emptyChanges();
		for (const id of touched.deleted) {
			delete document.objects[id];
			changedElements.deleted.add(id);
		}
		for (const id of touched.upserted) {
			if (touched.deleted.has(id)) continue;
			const element = this.readObject(id);
			if (element) {
				document.objects[id] = element;
				changedElements.upserted.add(id);
			} else {
				delete document.objects[id];
				changedElements.deleted.add(id);
			}
		}

		return {
			document: { ...document, objects: { ...document.objects } },
			changedElements,
		};
	}

	/** Rebuild a single object from the replay document, in this build's shape. */
	private readObject(id: string) {
		const yObject = this.replayDoc.getMap("objects").get(id);
		if (!(yObject instanceof Y.Map)) return null;
		// A replayed stream can carry element types this build cannot decode.
		try {
			const element = yMapToObject(yObject);
			const schemaVersion = this.replayedSchemaVersion();
			if (schemaVersion >= LATEST_SCHEMA_VERSION) return element;

			const document = {
				...createDefaultDocument(TIMELAPSE_REPLAY_DOCUMENT_ID),
				objects: { [id]: element },
				schemaVersion,
			};
			applyMigrations(document);
			return document.objects[id];
		} catch {
			return null;
		}
	}

	/** Schema version the replay document's current contents were recorded in. */
	private replayedSchemaVersion(): number {
		return (
			this.schemaVersions.findLast(({ at }) => at <= this.appliedUpToIndex)
				?.version ?? LATEST_SCHEMA_VERSION
		);
	}

	private buildCompletedDocument(): Document {
		return {
			...this.callbacks.getCompletedDocument(),
			id: TIMELAPSE_REPLAY_DOCUMENT_ID,
		};
	}

	private emitState(): void {
		this.callbacks.onStateChange({
			isPlaying: this.isPlaying,
			isPreparing: this.isPreparing,
			currentIndex: this.visibleCursor,
			totalEvents: this.visible.length,
			speed: this.speed,
			pathAnimProgress: this.activePathAnim
				? Math.min(
						1,
						this.activePathAnim.elapsed / this.activePathAnim.duration,
					)
				: null,
			introPhase: this.introPhase,
		});
	}

	/**
	 * Recordings saved before the index existed carry no rects, so they are
	 * replayed once to derive them. The result is handed back to be persisted,
	 * which keeps this to a single pass over the lifetime of the file.
	 */
	private async buildIndexAsync(): Promise<void> {
		this.isPreparing = true;
		this.emitState();

		const builder = new TimelapseIndexBuilder();
		const rects: (TimelapseDirtyRect | null)[] = [];

		for await (const entry of this.allEntries()) {
			rects.push(builder.step(entry.u));

			if (rects.length % INDEX_BUILD_YIELD_INTERVAL === 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				if (this.disposed) {
					builder.destroy();
					return;
				}
			}
		}
		builder.destroy();

		const index: TimelapseIndex = { rects };
		this.index = index;
		// Re-filtering moves the cursor, which a queued walk may be stepping.
		await this.enqueue(async () => this.applyIndex(index));
		this.callbacks.onIndexBuilt?.(index);

		this.isPreparing = false;
		this.emitState();
	}

	/** Re-filter the timeline, keeping playback at the same point in the recording. */
	private applyIndex(index: TimelapseIndex): void {
		this.visible = selectEntriesForArtboard(
			this.entryCount,
			index,
			this.filterArtboard,
		);

		let cursor = -1;
		while (
			cursor + 1 < this.visible.length &&
			this.visible[cursor + 1] <= this.appliedUpToIndex
		) {
			cursor++;
		}
		this.visibleCursor = cursor;
	}
}

interface TouchedState {
	upserted: Set<string>;
	deleted: Set<string>;
	added: Set<string>;
	layers: boolean;
	other: boolean;
	animation: boolean;
}

function createTouchedState(): TouchedState {
	return {
		upserted: new Set(),
		deleted: new Set(),
		added: new Set(),
		layers: false,
		other: false,
		animation: false,
	};
}

function hasDocumentChange(touched: TouchedState): boolean {
	return (
		touched.upserted.size > 0 ||
		touched.deleted.size > 0 ||
		touched.layers ||
		touched.other
	);
}

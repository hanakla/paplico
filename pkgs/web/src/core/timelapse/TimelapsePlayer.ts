import * as Y from "yjs";
import { extractDocumentFromYDoc } from "../collaboration/extractDocumentFromYDoc";
import type { Artboard, CubicBezierSegment, Document } from "../schema";
import {
	changedObjectsIntersectArtboard,
	extractChangedObjectIds,
} from "./artboardFilter";
import type { PlaybackState, TimelapseData } from "./types";

interface PathAnimation {
	pathId: string;
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
const KEYFRAME_YIELD_INTERVAL = 50;
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
 * Intro sequence: shows the completed work for INTRO_COMPLETE_MS, then
 * fades out over INTRO_FADEOUT_MS before starting normal playback.
 */
export class TimelapsePlayer {
	private replayDoc: Y.Doc;
	private entries: TimelapseData["entries"];
	private appliedUpToIndex = -1;
	private activePathAnim: PathAnimation | null = null;
	private isPlaying = false;
	private speed = 1;
	private animFrameId: number | null = null;
	private lastTickTimestamp: number | null = null;
	private playbackTime = 0;
	private keyframes: Keyframe[] = [];

	// Cached final state snapshot built during keyframe construction
	private completedSnapshot: Uint8Array | null = null;

	// Intro sequence state
	private introPhase: "complete" | "fadeOut" | null = null;
	private introElapsed = 0;
	private completedDoc: Document | null = null;

	/**
	 * Tracks which Yjs maps changed in the last applied update.
	 * Used to skip animation-only updates during playback.
	 * @see setupChangeTracking
	 */
	private lastYjsUpdateChanged: {
		animation: boolean;
		other: boolean;
	} = {
		animation: false,
		other: false,
	};

	/** Object IDs added in the last Yjs update (used for new path detection) */
	private lastAddedObjectIds: Set<string> = new Set();

	public constructor(
		data: TimelapseData,
		private callbacks: {
			onFrame: (document: Document) => void;
			onStateChange: (state: PlaybackState) => void;
		},
		private filterArtboard?: Artboard,
	) {
		this.replayDoc = new Y.Doc();
		this.entries = data.entries;
		this.setupChangeTracking();

		// Start keyframe building eagerly in constructor
		this.buildKeyframesAsync();
	}

	private setupChangeTracking(): void {
		const yAnimation = this.replayDoc.getMap("animation");
		const yObjects = this.replayDoc.getMap("objects");
		const yLayers = this.replayDoc.getArray("layers");
		const yArtboards = this.replayDoc.getArray("artboards");
		const yMeta = this.replayDoc.getMap("meta");

		yAnimation.observeDeep(() => {
			this.lastYjsUpdateChanged.animation = true;
		});

		const markOtherChanged = () => {
			this.lastYjsUpdateChanged.other = true;
		};

		yObjects.observeDeep((events) => {
			markOtherChanged();

			// Track newly added object IDs for new path detection
			for (const event of events) {
				if (event instanceof Y.YMapEvent) {
					for (const [key, change] of event.changes.keys) {
						if (change.action === "add") {
							this.lastAddedObjectIds.add(key);
						}
					}
				}
			}
		});

		yLayers.observeDeep(markOtherChanged);
		yArtboards.observe(markOtherChanged);
		yMeta.observe(markOtherChanged);
	}

	public get totalEvents(): number {
		return this.entries.length;
	}

	public get currentIndex(): number {
		return this.appliedUpToIndex;
	}

	// --- Playback control ---

	public play(): void {
		if (this.isPlaying) return;
		this.isPlaying = true;
		this.lastTickTimestamp = performance.now();

		const atEnd = this.appliedUpToIndex >= this.entries.length - 1;
		const atStart = this.appliedUpToIndex <= 0;

		if (atEnd || atStart) {
			// Start intro sequence: show completed work, then fade out, then replay from beginning
			this.introPhase = "complete";
			this.introElapsed = 0;
			this.prepareCompletedDoc();
			this.callbacks.onFrame(this.completedDoc!);
		}

		this.animFrameId = requestAnimationFrame(this.tick);
		this.emitState();
	}

	public buildCurrentDocument(): Document {
		const doc = extractDocumentFromYDoc(this.replayDoc);
		if (!this.activePathAnim) return doc;

		const { pathId, segments, duration, elapsed } = this.activePathAnim;
		const progress = Math.min(1, elapsed / duration);
		const visibleCount = Math.max(1, Math.ceil(segments.length * progress));

		const newObjects = { ...doc.objects };
		const targetEl = newObjects[pathId];
		if (targetEl && targetEl.type === "path") {
			newObjects[pathId] = {
				...targetEl,
				segments: segments.slice(0, visibleCount),
			};
		}
		return { ...doc, objects: newObjects };
	}

	public pause(): void {
		this.isPlaying = false;
		this.introPhase = null;
		this.completedDoc = null;
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

	public seekTo(eventIndex: number): void {
		const target = Math.max(-1, Math.min(eventIndex, this.entries.length - 1));
		this.activePathAnim = null;
		this.introPhase = null;
		this.completedDoc = null;

		// Find nearest keyframe before target
		let startIndex = -1;
		let snapshotToApply: Uint8Array | null = null;
		for (const kf of this.keyframes) {
			if (kf.index <= target) {
				startIndex = kf.index;
				snapshotToApply = kf.snapshot;
			} else {
				break;
			}
		}

		this.replayDoc.destroy();
		this.replayDoc = new Y.Doc();
		this.setupChangeTracking();

		if (snapshotToApply) {
			Y.applyUpdate(this.replayDoc, snapshotToApply);
		}

		for (let i = snapshotToApply ? startIndex + 1 : 0; i <= target; i++) {
			Y.applyUpdate(this.replayDoc, this.entries[i].u);
		}
		this.appliedUpToIndex = target;

		this.callbacks.onFrame(this.buildCurrentDocument());
		this.emitState();
	}

	public dispose(): void {
		this.pause();
		this.replayDoc.destroy();
	}

	// --- Internal ---

	private prepareCompletedDoc(): void {
		if (this.completedSnapshot) {
			// Use cached snapshot from keyframe building (O(1))
			const tempDoc = new Y.Doc();
			Y.applyUpdate(tempDoc, this.completedSnapshot);
			this.completedDoc = extractDocumentFromYDoc(tempDoc);
			tempDoc.destroy();
		} else {
			// Fallback: build synchronously if keyframes haven't finished yet
			const tempDoc = new Y.Doc();
			for (const entry of this.entries) {
				Y.applyUpdate(tempDoc, entry.u);
			}
			this.completedDoc = extractDocumentFromYDoc(tempDoc);
			tempDoc.destroy();
		}

		// Reset replay doc to the beginning
		this.replayDoc.destroy();
		this.replayDoc = new Y.Doc();
		this.setupChangeTracking();
		this.appliedUpToIndex = -1;
		this.activePathAnim = null;
		this.playbackTime = 0;
	}

	private tick = (): void => {
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
				this.completedDoc = null;
				// Show the first frame (blank canvas) and begin normal playback
				this.callbacks.onFrame(this.buildCurrentDocument());
			}
			this.emitState();
			this.animFrameId = requestAnimationFrame(this.tick);
			return;
		}

		// Normal playback (apply speed multiplier)
		const scaledElapsed = elapsed * this.speed;
		this.playbackTime += scaledElapsed;

		if (this.activePathAnim) {
			this.activePathAnim.elapsed += scaledElapsed;
			if (this.activePathAnim.elapsed >= this.activePathAnim.duration) {
				this.activePathAnim = null;
			}
			this.callbacks.onFrame(this.buildCurrentDocument());
			this.emitState();
		} else if (this.appliedUpToIndex + 1 < this.entries.length) {
			// Check if enough time elapsed for next event
			if (this.playbackTime >= EVENT_INTERVAL_MS) {
				this.playbackTime -= EVENT_INTERVAL_MS;
				this.applyNextEvent();
			}
		} else {
			this.pause();
			return;
		}

		if (this.isPlaying) {
			this.animFrameId = requestAnimationFrame(this.tick);
		}
	};

	private applyNextEvent(): void {
		this.appliedUpToIndex++;
		const entry = this.entries[this.appliedUpToIndex];

		// Reset change tracking flags
		this.lastYjsUpdateChanged.animation = false;
		this.lastYjsUpdateChanged.other = false;
		this.lastAddedObjectIds.clear();

		// Extract changed IDs BEFORE applying the update (for artboard filter)
		let changedIds: string[] = [];
		if (this.filterArtboard) {
			changedIds = extractChangedObjectIds(entry.u, this.replayDoc);
		}

		Y.applyUpdate(this.replayDoc, entry.u);

		// Skip animation-only updates (don't render or animate)
		if (
			this.lastYjsUpdateChanged.animation &&
			!this.lastYjsUpdateChanged.other
		) {
			return;
		}

		const afterDoc = extractDocumentFromYDoc(this.replayDoc);

		// Skip updates outside target artboard if filterArtboard is specified
		if (this.filterArtboard) {
			if (
				changedIds.length > 0 &&
				!changedObjectsIntersectArtboard(
					changedIds,
					afterDoc,
					this.filterArtboard,
				)
			) {
				return;
			}
		}

		// Detect new paths using tracked added object IDs (no beforeDoc needed)
		if (this.lastAddedObjectIds.size > 0) {
			for (const addedId of this.lastAddedObjectIds) {
				const el = afterDoc.objects[addedId];
				if (el?.type === "path" && el.segments.length > 0) {
					const duration = Math.min(
						ANIM_MAX_MS,
						Math.max(ANIM_MIN_MS, el.segments.length * ANIM_MS_PER_SEGMENT),
					);
					this.activePathAnim = {
						pathId: el.id,
						segments: el.segments,
						duration,
						elapsed: 0,
					};
					break;
				}
			}
		}

		this.callbacks.onFrame(this.buildCurrentDocument());
		this.emitState();
	}

	private emitState(): void {
		this.callbacks.onStateChange({
			isPlaying: this.isPlaying,
			currentIndex: this.appliedUpToIndex,
			totalEvents: this.entries.length,
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

	private async buildKeyframesAsync(): Promise<void> {
		const tempDoc = new Y.Doc();

		for (let i = 0; i < this.entries.length; i++) {
			Y.applyUpdate(tempDoc, this.entries[i].u);

			if ((i + 1) % KEYFRAME_INTERVAL === 0) {
				this.keyframes.push({
					index: i,
					snapshot: Y.encodeStateAsUpdate(tempDoc),
				});
			}

			// Yield every KEYFRAME_YIELD_INTERVAL entries to avoid blocking
			if ((i + 1) % KEYFRAME_YIELD_INTERVAL === 0) {
				await new Promise<void>((r) => setTimeout(r, 0));
			}
		}

		// Cache the final state as completed snapshot
		this.completedSnapshot = Y.encodeStateAsUpdate(tempDoc);
		tempDoc.destroy();
	}
}

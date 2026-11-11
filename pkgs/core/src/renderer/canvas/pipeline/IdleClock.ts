/**
 * Document frames and wall-clock milliseconds a cached GPU resource must
 * BOTH sit unused before frame-start eviction frees it. Requiring both keeps
 * the working set of a view the user returns to after a pause, while a
 * stream of frames that no longer touch a resource still lets it go.
 */
export const IDLE_EVICT_FRAMES = 120;
export const IDLE_EVICT_MS = 8_000;

/**
 * Frames a cached GPU resource must sit out before a byte budget may free it.
 * The last frame's resources are what the next frame asks for, so freeing
 * them when a frame's working set exceeds the budget re-allocates that set
 * every frame, and each freed texture stays resident until the GPU finishes
 * with it.
 */
export const IDLE_FRAMES_BEFORE_BUDGET_EVICTION = 2;

/** When a cached GPU resource was last used. */
export interface UseStamp {
	readonly frame: number;
	readonly time: number;
}

/**
 * Frame counter for a cache that frees GPU resources nobody uses any more.
 * The owner ticks it once per document frame (never on composite-blit
 * frames, which use none of the cached resources) and stamps a resource
 * whenever a frame uses it.
 */
export class IdleClock {
	private currentFrame = 0;

	/** The frame being rendered, or the last rendered one between frames. */
	public get frame(): number {
		return this.currentFrame;
	}

	public tick(): void {
		this.currentFrame++;
	}

	public stamp(): UseStamp {
		return { frame: this.currentFrame, time: performance.now() };
	}

	/** Whether frame-start eviction may free a resource last used at `stamp`. */
	public isExpired(stamp: UseStamp, now: number): boolean {
		return (
			this.currentFrame - stamp.frame >= IDLE_EVICT_FRAMES &&
			now - stamp.time >= IDLE_EVICT_MS
		);
	}

	/**
	 * Whether a trim may free a resource last used at `stamp`: it sat out at
	 * least the last `minIdleFrames` frames. 0 matches every resource.
	 */
	public isIdleFor(stamp: UseStamp, minIdleFrames: number): boolean {
		return this.currentFrame - stamp.frame >= minIdleFrames;
	}
}

/**
 * Frees the entries used longest ago until `entries` holds at most
 * `maxBytes`. An entry used within the last
 * IDLE_FRAMES_BEFORE_BUDGET_EVICTION frames is kept, whatever the total.
 */
export function evictIdleOverBudget<Key, Entry>(
	entries: Map<Key, Entry>,
	maxBytes: number,
	currentFrame: number,
	read: {
		bytesOf(entry: Entry): number;
		lastUsedFrameOf(entry: Entry): number;
		destroy(entry: Entry): void;
	},
): void {
	let bytes = 0;
	for (const entry of entries.values()) bytes += read.bytesOf(entry);
	const oldestFirst = [...entries].sort(
		([, a], [, b]) => read.lastUsedFrameOf(a) - read.lastUsedFrameOf(b),
	);
	for (const [key, entry] of oldestFirst) {
		if (bytes <= maxBytes) return;
		if (
			currentFrame - read.lastUsedFrameOf(entry) <
			IDLE_FRAMES_BEFORE_BUDGET_EVICTION
		) {
			return;
		}
		bytes -= read.bytesOf(entry);
		read.destroy(entry);
		entries.delete(key);
	}
}

/**
 * Document frames and wall-clock milliseconds a cached GPU resource must
 * BOTH sit unused before frame-start eviction frees it. Requiring both keeps
 * the working set of a view the user returns to after a pause, while a
 * stream of frames that no longer touch a resource still lets it go.
 */
export const IDLE_EVICT_FRAMES = 120;
export const IDLE_EVICT_MS = 8_000;

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

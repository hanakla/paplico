/**
 * RenderScheduler - On-demand rendering management
 *
 * Dirty sources:
 * - Document changes (elements, layers, filters) via Valtio subscription
 * - Viewport changes (pan, zoom)
 * - Transient UI (preview path, selection UI, cursor)
 * - Collaboration sync (Yjs updates)
 * - Canvas resize
 */

import { IDLE_EVICT_MS } from "./canvas/pipeline/IdleClock";
import {
	accumulateChanges,
	type ChangedElementsAccumulator,
	emptyChanges,
} from "./changedElements";
import { RenderStrategy } from "./RenderOrchestrator";
import type { ChangedElements } from "./types";

export type DirtyReason =
	| "document" // Element/layer changes
	| "viewport" // Pan/zoom changes
	| "preview" // Preview path during drawing
	| "selection" // Selection UI changes
	| "editingScope" // Editing scope (isolation) changes
	| "cursor" // Tool cursor position
	| "resize" // Canvas resize
	| "collaboration" // Remote changes via Yjs
	| "render" // Async resource loaded (text path, brush texture) — needs re-render but not full cache invalidation
	| "elementMove"; // Shape-preserving document change (moves, paste, duplicate) — skips boundsCache invalidation

/** How long after the last viewport change a gesture counts as over. */
const SETTLE_DELAY_MS = 100;
/** How often a gesture's end re-checks the resources it waits for. */
const RESOURCE_POLL_MS = 16;
/** A frame this long holds back the input events behind it. */
const LONG_FRAME_MS = 50;

/** Dirty reasons that require full document re-rendering */
const FULL_RENDER_REASONS: ReadonlySet<DirtyReason> = new Set([
	"document",
	"editingScope",
	// "viewport" excluded: interaction frames blit the cached composite frame
	// (or fall through to a re-render inside CanvasLayer when it is stale).
	"resize",
	"collaboration",
]);

/** Dirty reasons that touch only the overlay layer. The document pixels are
 *  unchanged, so the cached composite frame is still exact for them. */
const OVERLAY_ONLY_REASONS: ReadonlySet<DirtyReason> = new Set([
	"selection",
	"cursor",
]);

/** Dirty reasons that mean DOCUMENT CONTENT changed. Arriving without an
 *  element-id change set, they void the frame's tracking (every element may
 *  have changed); any other reason leaves the tracked set untouched. */
const DOCUMENT_CONTENT_REASONS: ReadonlySet<DirtyReason> = new Set([
	"document",
	"elementMove",
	"collaboration",
]);

export class RenderScheduler {
	private dirty = false;
	private dirtyReasons = new Set<DirtyReason>();
	private pendingFrame: number | null = null;
	private renderCallback: (
		strategy: RenderStrategy,
		changedElements?: ChangedElements,
	) => void;
	private isDestroyed = false;

	/** Document-content changes accumulated since the last dispatched frame.
	 *  `null` = tracking lost (a content dirty arrived without ids). */
	private changedElements: ChangedElementsAccumulator | null = emptyChanges();

	/** Whether the user is actively interacting (zoom/pan). */
	private isInteracting = false;
	/** Debounce timer for settling after interaction stops. */
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	/** When the last frame that took LONG_FRAME_MS or more finished. */
	private lastLongFrameEnd = Number.NEGATIVE_INFINITY;
	/** Whether a `render` dirt arrived during the interaction and waits for
	 *  the settle frame. */
	private renderAwaitsSettle = false;
	/** Whether a document re-render with nothing new of the user's to show
	 *  has to wait. */
	private isDocumentRenderOnHold: () => boolean;
	/** The dirt of the frames that blitted in place of a held re-render. */
	private heldReasons = new Set<DirtyReason>();
	/** Whether volatile content (transient preview elements, element overrides)
	 *  is currently present. The composite frame cache never captures such
	 *  content, so blitting it would show a frame without them. */
	private hasVolatileContent: () => boolean;
	/** Called once when no frame has rendered for IDLE_EVICT_MS. Rendering is
	 *  on demand, so frame-start eviction alone never runs while idle. */
	private onIdle: () => void;
	/** Whether resources the gesture's last frames asked for are on their way,
	 *  so the settle frame draws with them instead of drawing again once they
	 *  arrive. */
	private isAwaitingResources: () => boolean;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	public constructor(
		renderCallback: (
			strategy: RenderStrategy,
			changedElements?: ChangedElements,
		) => void,
		hasVolatileContent: () => boolean = () => false,
		onIdle: () => void = () => {},
		isDocumentRenderOnHold: () => boolean = () => false,
		isAwaitingResources: () => boolean = () => false,
	) {
		this.renderCallback = renderCallback;
		this.hasVolatileContent = hasVolatileContent;
		this.onIdle = onIdle;
		this.isDocumentRenderOnHold = isDocumentRenderOnHold;
		this.isAwaitingResources = isAwaitingResources;
	}

	/** Schedule the re-render that waited while document renders were on hold. */
	public resumeDocumentRender(): void {
		if (this.isDestroyed || this.heldReasons.size === 0) return;

		this.dirty = true;
		for (const reason of this.heldReasons) this.dirtyReasons.add(reason);
		this.heldReasons.clear();
		this.scheduleFrame();
	}

	/**
	 * Mark renderer as dirty and schedule a render.
	 * Multiple calls within the same frame are coalesced.
	 * `changes` carries the element ids a document-content dirty covers; a
	 * content dirty WITHOUT ids voids the frame's tracking (see FrameRequest.
	 * changedElements for the consumer contract).
	 */
	public markDirty(reason: DirtyReason, changes?: ChangedElements): void {
		if (this.isDestroyed) return;

		this.dirty = true;
		this.dirtyReasons.add(reason);

		if (DOCUMENT_CONTENT_REASONS.has(reason)) {
			if (changes && this.changedElements) {
				accumulateChanges(this.changedElements, changes);
			} else {
				this.changedElements = null;
			}
		}

		// For viewport changes: use lightweight rendering during interaction, then re-render with full quality after settling.
		if (reason === "viewport") {
			this.isInteracting = true;

			this.armSettleTimer();
		}

		this.scheduleFrame();
	}

	/**
	 * Force immediate render (for critical updates like initial render).
	 */
	public renderNow(): void {
		if (this.isDestroyed) return;

		if (this.pendingFrame !== null) {
			cancelAnimationFrame(this.pendingFrame);
			this.pendingFrame = null;
		}

		this.dirty = false;
		this.dirtyReasons.clear();
		// Forced full render: pass no change set (= everything may have
		// changed) and restart tracking fresh.
		this.changedElements = emptyChanges();
		this.renderCallback("full");
		this.restartIdleTimer();
	}

	/** Re-enable a destroyed scheduler, resetting all internal state. */
	public revive(): void {
		if (this.pendingFrame != null) {
			cancelAnimationFrame(this.pendingFrame);
			this.pendingFrame = null;
		}
		if (this.settleTimer != null) {
			clearTimeout(this.settleTimer);
			this.settleTimer = null;
		}
		this.clearIdleTimer();

		this.dirty = false;
		this.dirtyReasons.clear();
		this.changedElements = emptyChanges();
		this.isInteracting = false;
		this.renderAwaitsSettle = false;
		this.heldReasons.clear();
		this.isDestroyed = false;
	}

	/**
	 * Destroy the scheduler and cancel any pending render.
	 */
	public destroy(): void {
		this.isDestroyed = true;

		if (this.pendingFrame != null) {
			cancelAnimationFrame(this.pendingFrame);
			this.pendingFrame = null;
		}

		if (this.settleTimer != null) {
			clearTimeout(this.settleTimer);
			this.settleTimer = null;
		}
		this.clearIdleTimer();
	}

	/**
	 * End the gesture after SETTLE_DELAY_MS unless more viewport changes arrive.
	 * A long frame or a GPU too busy to deliver the next one holds back the
	 * input events of a gesture still in progress, so the wait restarts after
	 * either. Without that, the settle frame's full render starts mid-gesture
	 * and is itself long enough to do the same again. Once the gesture is
	 * over, the settle frame also waits for the resources it would otherwise
	 * draw again for.
	 */
	private armSettleTimer(delayMs = SETTLE_DELAY_MS): void {
		if (this.settleTimer != null) clearTimeout(this.settleTimer);

		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			const sinceLongFrame = performance.now() - this.lastLongFrameEnd;
			if (this.pendingFrame !== null || sinceLongFrame < SETTLE_DELAY_MS) {
				this.armSettleTimer();
				return;
			}
			if (this.isAwaitingResources()) {
				this.armSettleTimer(RESOURCE_POLL_MS);
				return;
			}
			this.isInteracting = false;

			// After interaction stops, trigger a viewport dirty to re-render
			// at full quality (zoom tolerance may have degraded the cache).
			this.dirty = true;
			this.dirtyReasons.add("viewport");
			if (this.renderAwaitsSettle) {
				this.renderAwaitsSettle = false;
				this.dirtyReasons.add("render");
			}
			this.scheduleFrame();
		}, delayMs);
	}

	private scheduleFrame(): void {
		if (this.pendingFrame !== null) return;

		const scheduledAt = performance.now();
		this.pendingFrame = requestAnimationFrame(() => {
			this.pendingFrame = null;
			if (performance.now() - scheduledAt >= LONG_FRAME_MS) {
				this.lastLongFrameEnd = performance.now();
			}

			if (this.dirty && !this.isDestroyed) {
				this.dirty = false;

				const strategy = this.resolveStrategy();
				// Capture the change set for this frame and restart tracking —
				// consumption and reset live at the same point as dirtyReasons.
				const changedElements = this.changedElements ?? undefined;
				this.changedElements = emptyChanges();
				this.dirtyReasons.clear();
				const frameStart = performance.now();
				this.renderCallback(strategy, changedElements);
				const frameEnd = performance.now();
				if (frameEnd - frameStart >= LONG_FRAME_MS) {
					this.lastLongFrameEnd = frameEnd;
				}
				this.restartIdleTimer();
			}
		});
	}

	private restartIdleTimer(): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			this.onIdle();
		}, IDLE_EVICT_MS);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer == null) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private resolveStrategy(): RenderStrategy {
		for (const reason of this.dirtyReasons) {
			if (FULL_RENDER_REASONS.has(reason)) return RenderStrategy.full;
		}

		// Shape-preserving changes: re-render document but keep boundsCache
		// (local element bounds are unchanged by moves/paste/duplicate).
		if (this.dirtyReasons.has("elementMove")) {
			return RenderStrategy.fullTransformOnly;
		}

		// The composite blit reproduces the cached document pixels, which is
		// wrong only when this frame needs pixels the cache lacks: "preview"
		// (in-progress draw geometry) and "render" (async resource /
		// post-process) need real document pixels, and volatile content
		// (transient previews / overrides) is never captured into the cache.
		const needsLivePixels =
			this.dirtyReasons.has("preview") || this.hasVolatileContent();
		const canBlit = !needsLivePixels && !this.dirtyReasons.has("render");

		// A `render` dirt has no new content of the user's to show, so during
		// a gesture it waits for the settle frame. Re-rendering for it on every
		// frame of a pinch draws each frame at another zoom, and each of those
		// allocates a whole new set of offscreen textures before the last set
		// is freed.
		if (
			this.isInteracting &&
			this.dirtyReasons.has("render") &&
			!needsLivePixels
		) {
			this.renderAwaitsSettle = true;
			return RenderStrategy.viewportBlit;
		}

		if (this.dirtyReasons.has("viewport") && this.isInteracting) {
			// Any viewport interaction (pan/zoom/rotate) tries the composite
			// blit; CanvasLayer falls through to a re-render when the cached
			// frame no longer covers the visible world (e.g. a pan past the
			// store margin). Overlay-only reasons (selection/cursor) ride along
			// because the overlay layer re-renders every frame anyway.
			return canBlit
				? RenderStrategy.viewportBlit
				: RenderStrategy.fullInteraction;
		}

		// What remains re-renders the document without new content of the
		// user's to show: the settle frame after a gesture, or a `render` dirt.
		// On hold it blits what is cached and renders once resumed.
		if (
			!needsLivePixels &&
			!this.dirtyReasons.isSubsetOf(OVERLAY_ONLY_REASONS) &&
			this.isDocumentRenderOnHold()
		) {
			for (const reason of this.dirtyReasons) {
				if (!OVERLAY_ONLY_REASONS.has(reason)) this.heldReasons.add(reason);
			}
			return RenderStrategy.viewportBlit;
		}

		// The settle frame after a gesture.
		if (canBlit && this.dirtyReasons.has("viewport")) {
			return RenderStrategy.viewportSettle;
		}

		// Selection / cursor changes leave the document untouched, so the
		// cached composite is still exact: blit it and let the overlay layer
		// redraw on top. CanvasLayer re-renders when it holds no valid cache.
		if (canBlit && this.dirtyReasons.isSubsetOf(OVERLAY_ONLY_REASONS)) {
			return RenderStrategy.viewportBlit;
		}

		// "render" reason: async resource loaded (text path, brush texture), a
		// post-process change (HDR / soft proof), or a tile-convergence follow-up.
		// overlayOnly re-renders the document (to show the result) without full
		// cache invalidation (boundsCache, geometryCache), and stays
		// non-interacting — so a tile-convergence follow-up bakes at the settle
		// budget and keeps converging instead of trickling at the interaction one.
		return RenderStrategy.overlayOnly;
	}
}

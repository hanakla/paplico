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

/** Dirty reasons that require full document re-rendering */
const FULL_RENDER_REASONS: ReadonlySet<DirtyReason> = new Set([
	"document",
	"editingScope",
	// "viewport" excluded: pan/zoom uses oversize document cache in CanvasLayer
	"resize",
	"collaboration",
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
	private changedElements: {
		upserted: Set<string>;
		deleted: Set<string>;
	} | null = emptyChanges();

	/** Whether the user is actively interacting (zoom/pan). */
	private isInteracting = false;
	/** Whether the zoom (not just pan) changed among this frame's viewport
	 *  dirties. Only a zoom can blit the cached composite; a pan blit would
	 *  reveal unbaked edges beyond the screen-sized cache, so pans re-render. */
	private viewportZoomChanged = false;
	/** Debounce timer for settling after interaction stops. */
	private settleTimer: ReturnType<typeof setTimeout> | null = null;

	public constructor(
		renderCallback: (
			strategy: RenderStrategy,
			changedElements?: ChangedElements,
		) => void,
	) {
		this.renderCallback = renderCallback;
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
				for (const id of changes.upserted) {
					this.changedElements.deleted.delete(id);
					this.changedElements.upserted.add(id);
				}
				for (const id of changes.deleted) {
					this.changedElements.upserted.delete(id);
					this.changedElements.deleted.add(id);
				}
			} else {
				this.changedElements = null;
			}
		}

		// For viewport changes: use lightweight rendering during interaction, then re-render with full quality after settling.
		if (reason === "viewport") {
			this.isInteracting = true;

			if (this.settleTimer != null) {
				clearTimeout(this.settleTimer);
			}

			this.settleTimer = setTimeout(() => {
				this.settleTimer = null;
				this.isInteracting = false;

				// After interaction stops, trigger a viewport dirty to re-render
				// at full quality (zoom tolerance may have degraded the cache).
				this.dirty = true;
				this.dirtyReasons.add("viewport");
				this.scheduleFrame();
			}, 100);
		}

		this.scheduleFrame();
	}

	/**
	 * A viewport interaction dirty that also records whether the zoom changed.
	 * Panning re-renders (a translated blit of the screen-sized cache would show
	 * unbaked edges); zooming blits the cached composite. Callers that only pan
	 * may use `markDirty("viewport")` directly.
	 */
	public markViewportInteraction(zoomChanged: boolean): void {
		if (zoomChanged) this.viewportZoomChanged = true;
		this.markDirty("viewport");
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

		this.dirty = false;
		this.dirtyReasons.clear();
		this.changedElements = emptyChanges();
		this.isInteracting = false;
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
	}

	private scheduleFrame(): void {
		if (this.pendingFrame !== null) return;

		this.pendingFrame = requestAnimationFrame(() => {
			this.pendingFrame = null;

			if (this.dirty && !this.isDestroyed) {
				this.dirty = false;

				const strategy = this.resolveStrategy();
				// Capture the change set for this frame and restart tracking —
				// consumption and reset live at the same point as dirtyReasons.
				const changedElements = this.changedElements ?? undefined;
				this.changedElements = emptyChanges();
				this.dirtyReasons.clear();
				this.viewportZoomChanged = false;
				this.renderCallback(strategy, changedElements);
			}
		});
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

		if (this.dirtyReasons.has("viewport") && this.isInteracting) {
			// A ZOOM interaction can blit the cached composite frame instead of
			// re-rendering the document. Overlay-only reasons (selection/cursor)
			// ride along because the overlay layer re-renders every frame anyway.
			// A pan-only interaction re-renders (a translated blit of the
			// screen-sized cache would reveal unbaked edges). "preview"
			// (in-progress draw geometry) and "render" (async resource /
			// post-process) need real document pixels, so those re-render too.
			if (
				this.viewportZoomChanged &&
				!this.dirtyReasons.has("preview") &&
				!this.dirtyReasons.has("render")
			) {
				return RenderStrategy.viewportBlit;
			}
			return RenderStrategy.fullInteraction;
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

// Helpers

function emptyChanges(): { upserted: Set<string>; deleted: Set<string> } {
	return { upserted: new Set(), deleted: new Set() };
}

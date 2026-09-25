import { deepClone } from "valtio/utils";
import { buildSkewBarsOverlay } from "../renderer/ui/builders/skewBars";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type {
	AnyArtObject,
	BoundingBox,
	ElementTransform,
	Viewport,
} from "../schema";
import { screenToWorld } from "../utils/geometry/geometry";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

/** Screen-space pick radius for click-to-select, converted to world by zoom. */
const PICK_TOLERANCE_SCREEN_PX = 6;

interface SkewTarget {
	elementId: string;
	/** The element's transform at tool start (immutable baseline). */
	transform: ElementTransform;
}

/**
 * Skew (shear) transform tool. Drag on the selected element(s): the drag's
 * horizontal component shears horizontally (`skewX`), the vertical component
 * shears vertically (`skewY`). It writes `transform.skewX` / `transform.skewY`
 * (radians) directly on each selected element — a selected group shears its
 * children as one — with no geometry rewrite, since skew already flows through
 * the transform math and the renderer.
 */
export class SkewTool implements Tool {
	public readonly name = "skew";

	private context: ToolContext;
	private targets: SkewTarget[] = [];
	private combinedBounds: BoundingBox | null = null;
	private initialized = false;

	// Session-accumulated skew (radians), folded in on each pointer up so
	// successive drags compound.
	private accumSkewX = 0;
	private accumSkewY = 0;

	// Active drag start in world space; null when not dragging.
	private dragStart: { x: number; y: number } | null = null;
	private dragSkewX = 0;
	private dragSkewY = 0;
	/** Which shear axis the active drag controls: a bar restricts to one. */
	private dragAxis: "x" | "y" | "free" = "free";

	public constructor(context: ToolContext) {
		this.context = context;

		// Stay active even with no selection so the user can click an object
		// (Shift to multi-select) and skew it without pre-selecting.
		this.rebuildTargets();
		this.initialized = true;
	}

	/**
	 * Snapshot the current selection into skew targets + combined bounds and
	 * reset the accumulated skew (a fresh selection is a fresh baseline). Called
	 * on construction and whenever the selection changes while the tool is active.
	 */
	private rebuildTargets(): void {
		const selectedIds = this.context.getSelectedElementIds();
		this.targets = [];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		// Skew operates on the selected elements' transforms directly (not
		// flattened leaves): shearing a group's transform shears its children
		// together.
		for (const id of selectedIds) {
			const element = this.context.getElement(id);
			const bounds = this.context.getBounds(id);
			if (!element || !bounds) continue;
			this.targets.push({
				elementId: id,
				transform: deepClone(element.transform),
			});
			minX = Math.min(minX, bounds.minX);
			minY = Math.min(minY, bounds.minY);
			maxX = Math.max(maxX, bounds.maxX);
			maxY = Math.max(maxY, bounds.maxY);
		}
		this.combinedBounds = this.targets.length
			? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
			: null;
		this.accumSkewX = 0;
		this.accumSkewY = 0;
		this.dragSkewX = 0;
		this.dragSkewY = 0;
		this.dragStart = null;
		this.dragAxis = "free";
		this.emitGizmo();
	}

	/**
	 * Keep targets in sync when the selection changes from outside the tool.
	 * Called by many engine events (renders, zoom, document changes), so it must
	 * never disturb an in-progress skew: rebuilding resets dragStart/accumulated
	 * skew, which would wipe a live drag (text previews trigger these refreshes
	 * mid-drag). Rebuild only when idle and the selection set actually changed.
	 */
	public refreshUI(): void {
		if (!this.initialized || this.dragStart) return;
		const current = this.context.getSelectedElementIds();
		const unchanged =
			current.length === this.targets.length &&
			current.every((id, index) => this.targets[index]?.elementId === id);
		if (unchanged) {
			this.emitGizmo();
			return;
		}
		this.rebuildTargets();
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.initialized) return;
		if (event.button !== undefined && event.button !== 0) return;
		if (this.context.isReadonly()) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		// A press on a shear bar starts an axis-restricted drag.
		const barHit = this.context.uiHitTest({ x: event.x, y: event.y });
		if (
			barHit?.overlayKey === OVERLAY_KEYS.skewHandles &&
			this.combinedBounds
		) {
			if (
				!this.targets.some((t) => this.context.isElementLocked(t.elementId))
			) {
				this.dragAxis = barHit.hitId === "skew-x" ? "x" : "y";
				this.dragStart = world;
				this.dragSkewX = 0;
				this.dragSkewY = 0;
			}
			return;
		}

		const tolerance = PICK_TOLERANCE_SCREEN_PX / viewport.zoom;
		const hit = this.context.findElementAtPoint(world.x, world.y, tolerance);
		const selectedIds = this.context.getSelectedElementIds();

		// Shift+click toggles the hit element in/out of the selection (no skew).
		if (event.shiftKey) {
			if (hit && this.context.isElementEditable(hit.id)) {
				const bounds = this.context.getBounds(hit.id);
				if (bounds) {
					this.commitPendingSkew();
					this.context.elementToggleSelect(hit.id, bounds);
					this.rebuildTargets();
					this.context.uiRefreshSelectionUI(false);
				}
			}
			return;
		}

		// Click on an unselected element replaces the selection with it.
		if (
			hit &&
			this.context.isElementEditable(hit.id) &&
			!selectedIds.includes(hit.id)
		) {
			const bounds = this.context.getBounds(hit.id);
			if (bounds) {
				this.commitPendingSkew();
				this.context.elementSelect(hit.id, bounds);
				this.rebuildTargets();
				this.context.uiRefreshSelectionUI(false);
				// Continue the same gesture into a skew drag on the new selection.
				this.dragStart = world;
				this.dragSkewX = 0;
				this.dragSkewY = 0;
			}
			return;
		}

		// Click on the current selection begins a skew drag (unless it is locked).
		if (
			this.combinedBounds &&
			world.x >= this.combinedBounds.minX &&
			world.x <= this.combinedBounds.maxX &&
			world.y >= this.combinedBounds.minY &&
			world.y <= this.combinedBounds.maxY
		) {
			if (
				!this.targets.some((t) => this.context.isElementLocked(t.elementId))
			) {
				this.dragStart = world;
				this.dragSkewX = 0;
				this.dragSkewY = 0;
			}
			return;
		}

		// Empty-space click clears the selection.
		this.commitPendingSkew();
		this.context.selectionClear();
		this.rebuildTargets();
		this.context.uiRefreshSelectionUI(false);
	}

	/** Commit any previewed-but-uncommitted skew so a selection change keeps it. */
	private commitPendingSkew(): void {
		const totalX = this.accumSkewX + this.dragSkewX;
		const totalY = this.accumSkewY + this.dragSkewY;
		if (totalX === 0 && totalY === 0) return;
		const updates = this.buildUpdates(totalX, totalY);
		if (updates) this.context.applyDeformation(updates);
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.initialized || !this.dragStart || !this.combinedBounds) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		let dx = world.x - this.dragStart.x;
		let dy = world.y - this.dragStart.y;
		// A bar drag restricts the shear to its own axis; otherwise Shift locks
		// the shear to the dominant drag axis (skewX- or skewY-only).
		if (this.dragAxis === "x") {
			dy = 0;
		} else if (this.dragAxis === "y") {
			dx = 0;
		} else if (event.shiftKey) {
			if (Math.abs(dx) >= Math.abs(dy)) {
				dy = 0;
			} else {
				dx = 0;
			}
		}
		// Horizontal drag shears against the selection's half-height, vertical
		// drag against its half-width; atan yields the shear angle skew* expects.
		const refX = Math.max(this.combinedBounds.height / 2, 1e-3);
		const refY = Math.max(this.combinedBounds.width / 2, 1e-3);
		this.dragSkewX = Math.atan(dx / refX);
		this.dragSkewY = Math.atan(dy / refY);
		this.preview();
		// Slide the dragged bar along its axis so it follows the pointer.
		this.emitGizmo({
			x: this.dragAxis === "x" ? dx : 0,
			y: this.dragAxis === "y" ? dy : 0,
		});
	}

	public onPointerUp(): void {
		if (!this.initialized || !this.dragStart) return;
		// Fold this drag into the session total so the next drag compounds.
		this.accumSkewX += this.dragSkewX;
		this.accumSkewY += this.dragSkewY;
		this.dragSkewX = 0;
		this.dragSkewY = 0;
		this.dragStart = null;
		this.dragAxis = "free";
		this.emitGizmo();
	}

	public onKeyDown(event: KeyboardEvent): boolean {
		if (!this.initialized) return false;
		if (event.code === "Enter") {
			this.applyDeformation();
			return true;
		}
		// Escape falls through to onCancel.
		return false;
	}

	public onCancel(): void {
		if (!this.initialized) return;
		this.initialized = false;
		this.context.uiSetOverlay(OVERLAY_KEYS.skewHandles, null);
		this.context.clearDeformationPreview(this.targets.map((t) => t.elementId));
		this.restoreOriginal();
		this.context.complete();
	}

	public dispose(): void {
		this.context.uiSetOverlay(OVERLAY_KEYS.skewHandles, null);
	}

	public getCursor(): string {
		return this.dragStart ? "grabbing" : "grab";
	}

	/**
	 * Commit the accumulated skew to the document. Also called by Paplico when
	 * switching away from the tool (mirrors MeshDeformTool).
	 */
	public applyDeformation(options: { complete?: boolean } = {}): void {
		const shouldComplete = options.complete ?? true;
		if (!this.initialized) {
			if (shouldComplete) this.context.complete();
			return;
		}
		this.initialized = false;

		const totalX = this.accumSkewX + this.dragSkewX;
		const totalY = this.accumSkewY + this.dragSkewY;
		if (totalX === 0 && totalY === 0) {
			this.context.clearDeformationPreview(
				this.targets.map((t) => t.elementId),
			);
			if (shouldComplete) this.context.complete();
			return;
		}

		const updates = this.buildUpdates(totalX, totalY);
		if (updates) this.context.applyDeformation(updates);
		if (shouldComplete) this.context.complete();
	}

	private preview(): void {
		const updates = this.buildUpdates(
			this.accumSkewX + this.dragSkewX,
			this.accumSkewY + this.dragSkewY,
		);
		if (updates) this.context.previewDeformation(updates);
	}

	private restoreOriginal(): void {
		const layerId = this.context.getCurrentLayerId();
		if (!layerId) return;
		this.context.restoreOriginal(
			this.targets.map((t) => ({
				elementId: t.elementId,
				layerId,
				updates: { transform: { ...t.transform } },
			})),
		);
	}

	/** Publish the two capsule shear bars (or clear them with no selection). */
	private emitGizmo(offset: { x: number; y: number } = { x: 0, y: 0 }): void {
		if (!this.combinedBounds) {
			this.context.uiSetOverlay(OVERLAY_KEYS.skewHandles, null);
			return;
		}
		const zoom = this.context.getViewport()?.viewport.zoom ?? 1;
		this.context.uiSetOverlay(OVERLAY_KEYS.skewHandles, {
			zIndex: OVERLAY_Z.selection,
			primitives: buildSkewBarsOverlay(
				this.combinedBounds,
				zoom,
				offset,
				UI_THEME,
			),
		});
	}

	private buildUpdates(
		skewX: number,
		skewY: number,
	): Array<{
		elementId: string;
		layerId: string;
		updates: Partial<AnyArtObject>;
	}> | null {
		const layerId = this.context.getCurrentLayerId();
		if (!layerId) return null;
		return this.targets.map((t) => ({
			elementId: t.elementId,
			layerId,
			updates: {
				transform: {
					...t.transform,
					skewX: (t.transform.skewX ?? 0) + skewX,
					skewY: (t.transform.skewY ?? 0) + skewY,
				},
			} as Partial<AnyArtObject>,
		}));
	}
}

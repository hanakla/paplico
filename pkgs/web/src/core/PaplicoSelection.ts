import type { SpatialIndex } from "./document/SpatialIndex";
import type { RendererState } from "./Paplico";
import {
	setArtboardSelectionOverlay,
	setSelectionOverlay,
} from "./renderer/ui/overlaySink";
import type { ArtboardSelectionUIData } from "./renderer/ui/types";
import {
	type BoundingBox,
	getArtboardBounds,
	getContainerChildIds,
	isContainer,
} from "./schema";

/**
 * Public API facade for local UI state operations.
 *
 * Aggregates element selection, editing scope, artboard management,
 * layer switching, and selection-UI computation into a single entry point.
 * Exposed as `paplico.selection` and consumed by both core internals
 * (Paplico, ToolContext) and UI components (LayerPanel, EditingScopeBreadcrumb).
 *
 * All state managed here is local-only (NOT synced via Yjs) and operates
 * directly on the Valtio RendererState proxy.
 */
export class PaplicoSelection {
	public constructor(
		private store: RendererState,
		private spatial: SpatialIndex,
		/**
		 * Close the editing session that owns this scope entry, if one does, and
		 * report whether it closed. A session lends the tools a working layer and
		 * pushes it onto the scope stack; popping that entry from underneath
		 * leaves the session believing it is still open, with its layer stranded
		 * in the document. Every route out of a scope goes through the three
		 * methods below, so asking here is what makes it impossible to miss one.
		 */
		private closeSessionOwning?: (scopeId: string) => boolean,
	) {}

	/**
	 * Let sessions close themselves off the top of the stack until it is down to
	 * `targetLength`. A session pops its own entry as it closes, so the stack is
	 * re-read each turn; the walk stops at the first entry no session owns and
	 * leaves the rest to the caller.
	 */
	private releaseSessionsDownTo(targetLength: number): void {
		while (this.store.editingScopeStack.length > targetLength) {
			const top = this.store.editingScopeStack.at(-1);
			if (!top) return;
			if (!this.closeSessionOwning?.(top)) return;
		}
	}

	// --- Element Selection ---

	/**
	 * Select an element (replaces current selection)
	 */
	public selectElement(elementId: string, bounds?: BoundingBox): void {
		this.pruneDeletedElements();
		if (!this.store.document.objects[elementId]) return;
		this.store.selectedElementIds = [elementId];
		this.store.selectionBounds = bounds ?? null;
		this.store.keyObjectId = null;
	}

	/**
	 * Mark one member of the current multi-selection as the key object (the
	 * alignment reference). Ignored unless the id is part of the selection.
	 * Pass null to clear.
	 */
	public setKeyObject(elementId: string | null): void {
		if (elementId === null) {
			this.store.keyObjectId = null;
			return;
		}
		if (!this.store.selectedElementIds.includes(elementId)) return;
		this.store.keyObjectId = elementId;
	}

	/**
	 * Toggle element selection (for Shift+click multi-select)
	 */
	public toggleElement(elementId: string, _bounds: BoundingBox): void {
		this.pruneDeletedElements();
		const idx = this.store.selectedElementIds.indexOf(elementId);
		if (idx >= 0) {
			this.store.selectedElementIds.splice(idx, 1);
		} else {
			if (!this.store.document.objects[elementId]) return;
			this.store.selectedElementIds.push(elementId);
		}
		this.ensureKeyObjectValid();
		this.updateSelectionBounds();
	}

	/**
	 * Select multiple elements at once (used by marquee selection)
	 */
	public selectMultiple(elementIds: string[]): void {
		if (elementIds.length === 0) return;

		const layer = this.store.document.layers.find(
			(l) => l.id === this.store.currentLayerId,
		);
		if (!layer) return;

		const existing = elementIds.filter((id) => this.store.document.objects[id]);
		if (existing.length === 0) return;

		this.store.selectedElementIds = existing;
		this.store.keyObjectId = null;

		let combinedBounds: BoundingBox | null = null;
		for (const id of elementIds) {
			const elBounds = this.spatial.getWorldBounds(id);
			if (elBounds) {
				if (!combinedBounds) {
					combinedBounds = { ...elBounds };
				} else {
					combinedBounds.minX = Math.min(combinedBounds.minX, elBounds.minX);
					combinedBounds.minY = Math.min(combinedBounds.minY, elBounds.minY);
					combinedBounds.maxX = Math.max(combinedBounds.maxX, elBounds.maxX);
					combinedBounds.maxY = Math.max(combinedBounds.maxY, elBounds.maxY);
				}
			}
		}

		if (combinedBounds) {
			combinedBounds.width = combinedBounds.maxX - combinedBounds.minX;
			combinedBounds.height = combinedBounds.maxY - combinedBounds.minY;
			this.store.selectionBounds = combinedBounds;
		}
	}

	/**
	 * Select all elements in current context (shallow).
	 * In group edit mode: selects only direct children of the editing group.
	 * Otherwise: selects all top-level elements in all layers.
	 */
	public selectAll(): void {
		const editingScopeId = this.store.editingScopeStack.at(-1);

		let targetIds: string[];
		if (editingScopeId) {
			// Layer-id scope: pattern-edit pushes a transient layer id onto
			// the stack so its elementIds become the editable set without a
			// wrapping group container.
			const scopedLayer = this.store.document.layers.find(
				(l) => l.id === editingScopeId,
			);
			if (scopedLayer) {
				targetIds = scopedLayer.elementIds;
			} else {
				const scopeElement = this.store.document.objects[editingScopeId];
				if (!scopeElement) return;
				if (isContainer(scopeElement)) {
					const childIds = getContainerChildIds(scopeElement);
					if (!childIds) return;
					targetIds = childIds;
				} else {
					// Single-element scope: only the element itself is selectable.
					targetIds = [editingScopeId];
				}
			}
		} else {
			// Collect all elements from all layers
			targetIds = this.store.document.layers.flatMap((l) => l.elementIds);
		}

		// Filter out locked/invisible elements
		// visible defaults to true (undefined = visible), locked defaults to false (undefined = unlocked)
		const selectableIds = targetIds.filter((id) => {
			const obj = this.store.document.objects[id];
			return obj && obj.visible !== false && !this.spatial.isElementLocked(id);
		});

		if (selectableIds.length === 0) return;

		this.selectMultiple(selectableIds);
	}

	/**
	 * Clear selection
	 */
	public clear(): void {
		this.store.selectedElementIds = [];
		this.store.selectionBounds = null;
		this.store.keyObjectId = null;
		setSelectionOverlay(this.store.uiOverlayState, null);
	}

	// --- Editing Scope ---

	/**
	 * Enter an editing scope (push the element onto the stack).
	 * For containers only their children can be selected; for a single
	 * (non-container) element only the element itself stays editable.
	 */
	public enterEditingScope(elementId: string): void {
		const layerId = this.store.currentLayerId;
		if (!layerId) return;

		const layer = this.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		const element = this.store.document.objects[elementId];
		if (!element) return;
		if (this.store.editingScopeStack.at(-1) === elementId) return;

		this.store.editingScopeStack = [...this.store.editingScopeStack, elementId];
		this.clear();
	}

	/**
	 * Exit one level of the editing scope (pop from stack).
	 * Used by Escape key.
	 */
	public exitEditingScopeOneLevel(): void {
		const before = this.store.editingScopeStack.length;
		if (before === 0) return;
		this.releaseSessionsDownTo(before - 1);
		// A session that closed already popped its own entry and cleared up
		// after itself.
		if (this.store.editingScopeStack.length < before) return;
		this.store.editingScopeStack = this.store.editingScopeStack.slice(0, -1);
		this.clear();
	}

	/**
	 * Exit all levels of the editing scope (clear stack).
	 * Used by Shift+Escape or breadcrumb root click.
	 */
	public exitEditingScope(): void {
		if (this.store.editingScopeStack.length === 0) return;
		this.releaseSessionsDownTo(0);
		if (this.store.editingScopeStack.length === 0) return;
		this.store.editingScopeStack = [];
		this.clear();
	}

	/**
	 * Navigate to a specific scope level in the stack (truncate stack to that element).
	 * Used by breadcrumb item click.
	 */
	public navigateToScopeLevel(elementId: string): void {
		const idx = this.store.editingScopeStack.indexOf(elementId);
		if (idx < 0) return;
		this.releaseSessionsDownTo(idx + 1);
		if (this.store.editingScopeStack.length <= idx + 1) return;
		this.store.editingScopeStack = this.store.editingScopeStack.slice(
			0,
			idx + 1,
		);
		this.clear();
	}

	/**
	 * Check if an element is editable (considering the editing scope).
	 * An element is editable if it's a child of the current scope (last in stack).
	 */
	public isElementEditable(elementId: string): boolean {
		if (this.spatial.isElementLocked(elementId)) return false;

		const currentScopeId = this.store.editingScopeStack.at(-1);
		if (!currentScopeId) return true;

		// Layer-id scope: every element directly held by the scoped layer is
		// editable (pattern-edit transient layer case).
		const scopedLayer = this.store.document.layers.find(
			(l) => l.id === currentScopeId,
		);
		if (scopedLayer) {
			return scopedLayer.elementIds.includes(elementId);
		}

		const layerId = this.store.currentLayerId;
		if (!layerId) return false;

		const layer = this.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return false;

		const scopeElement = this.store.document.objects[currentScopeId];
		if (!scopeElement) return false;
		// Single-element scope: only the scope element itself is editable.
		if (!isContainer(scopeElement)) return elementId === currentScopeId;

		const childIds = getContainerChildIds(scopeElement);
		if (!childIds) return false;
		return childIds.includes(elementId);
	}

	// --- Artboard ---

	/**
	 * Select an artboard
	 */
	public selectArtboard(id: string | null): void {
		this.store.selectedArtboardId = id;

		if (!id) {
			setArtboardSelectionOverlay(this.store.uiOverlayState, null);
			return;
		}

		const artboard = this.store.document.artboards.find((a) => a.id === id);
		if (artboard) {
			const bounds = getArtboardBounds(artboard);
			setArtboardSelectionOverlay(this.store.uiOverlayState, {
				bounds,
				handles: createArtboardHandles(bounds),
			});
		}
	}

	/**
	 * Set artboard edit mode
	 */
	public setArtboardEditMode(enabled: boolean): void {
		this.store.uiOverlayState.isArtboardEditMode = enabled;
		if (!enabled) {
			this.store.selectedArtboardId = null;
			setArtboardSelectionOverlay(this.store.uiOverlayState, null);
		}
	}

	// --- Layer ---

	/**
	 * Set current layer
	 */
	public setCurrentLayer(layerId: string): void {
		const layer = this.store.document.layers.find((l) => l.id === layerId);
		if (layer) {
			this.store.currentLayerId = layerId;
		}
	}

	// --- Private Helpers ---

	private pruneDeletedElements(): void {
		const before = this.store.selectedElementIds.length;
		this.store.selectedElementIds = this.store.selectedElementIds.filter(
			(id) => this.store.document.objects[id],
		);
		this.ensureKeyObjectValid();
		if (this.store.selectedElementIds.length === 0 && before > 0) {
			this.store.selectionBounds = null;
			setSelectionOverlay(this.store.uiOverlayState, null);
		}
	}

	/** Drop the key object when it is no longer part of the selection. */
	private ensureKeyObjectValid(): void {
		if (
			this.store.keyObjectId &&
			!this.store.selectedElementIds.includes(this.store.keyObjectId)
		) {
			this.store.keyObjectId = null;
		}
	}

	public updateSelectionBounds(): void {
		this.pruneDeletedElements();

		if (this.store.selectedElementIds.length === 0) {
			this.store.selectionBounds = null;
			setSelectionOverlay(this.store.uiOverlayState, null);
			return;
		}

		let combinedBounds: BoundingBox | null = null;
		for (const id of this.store.selectedElementIds) {
			const elBounds = this.spatial.getWorldBounds(id);
			if (elBounds) {
				if (!combinedBounds) {
					combinedBounds = { ...elBounds };
				} else {
					combinedBounds.minX = Math.min(combinedBounds.minX, elBounds.minX);
					combinedBounds.minY = Math.min(combinedBounds.minY, elBounds.minY);
					combinedBounds.maxX = Math.max(combinedBounds.maxX, elBounds.maxX);
					combinedBounds.maxY = Math.max(combinedBounds.maxY, elBounds.maxY);
				}
			}
		}
		if (combinedBounds) {
			combinedBounds.width = combinedBounds.maxX - combinedBounds.minX;
			combinedBounds.height = combinedBounds.maxY - combinedBounds.minY;
		}
		this.store.selectionBounds = combinedBounds;
	}
}

// --- Helper ---

function createArtboardHandles(
	bounds: BoundingBox,
): ArtboardSelectionUIData["handles"] {
	const { minX, maxX, minY, maxY } = bounds;
	const midX = (minX + maxX) / 2;
	const midY = (minY + maxY) / 2;

	return [
		{ x: minX, y: maxY, position: "nw" },
		{ x: midX, y: maxY, position: "n" },
		{ x: maxX, y: maxY, position: "ne" },
		{ x: maxX, y: midY, position: "e" },
		{ x: maxX, y: minY, position: "se" },
		{ x: midX, y: minY, position: "s" },
		{ x: minX, y: minY, position: "sw" },
		{ x: minX, y: midY, position: "w" },
	];
}

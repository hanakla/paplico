/**
 * Artboard Tool
 * Allows creating, selecting, moving, and resizing artboards on the canvas
 */

import { buildSnapLineOverlay } from "../renderer/ui/builders/snapLine";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type { SnapLine } from "../renderer/ui/types";
import {
	type Artboard,
	type BoundingBox,
	getArtboardBounds,
	type Viewport,
} from "../schema";
import {
	calculateResizedBounds,
	createResizeHandles,
	getResizeCursor,
	type HandlePosition,
	hitTestResizeHandle,
	type ResizeHandle,
} from "./resizeHandleHelper";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

type DragState =
	| { mode: "idle" }
	| {
			mode: "create";
			startX: number;
			startY: number;
			constrainAspect: boolean;
	  }
	| {
			mode: "move";
			startX: number;
			startY: number;
			originalBounds: BoundingBox;
			affectedElements: Array<{ layerId: string; elementId: string }>;
	  }
	| {
			mode: "resize";
			startX: number;
			startY: number;
			handle: ResizeHandle;
			originalBounds: BoundingBox;
			constrainAspect: boolean;
	  };

type SnapAxisTarget = "none" | "min" | "max";

type SnapTargets = {
	x: SnapAxisTarget;
	y: SnapAxisTarget;
};

export class ArtboardTool implements Tool {
	public readonly name = "artboard";

	private context: ToolContext;
	private dragState: DragState = { mode: "idle" };

	// Handle cache to avoid creating 8 objects every pointer move
	private cachedHandles: HandlePosition[] | null = null;
	private cachedHandleBoundsKey = "";

	public constructor(context: ToolContext) {
		this.context = context;
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly()) return;

		const worldX = this.screenToWorldX(event.x, viewport, canvasWidth);
		const worldY = this.screenToWorldY(event.y, viewport, canvasHeight);

		// Check if clicking on a resize handle of selected artboard
		const selectedId = this.context.getSelectedArtboardId();
		if (selectedId) {
			const handle = this.hitTestHandle(worldX, worldY, viewport);
			if (handle) {
				const artboard = this.context
					.getArtboards()
					.find((a) => a.id === selectedId);
				if (artboard) {
					this.dragState = {
						mode: "resize",
						startX: worldX,
						startY: worldY,
						handle,
						originalBounds: getArtboardBounds(artboard),
						constrainAspect: event.shiftKey,
					};
				}
				return;
			}
		}

		// Check if clicking on an artboard
		const artboard = this.context.findArtboardAtPoint(worldX, worldY);
		if (artboard) {
			this.context.artboardSelect(artboard.id);
			const originalBounds = getArtboardBounds(artboard);
			this.dragState = {
				mode: "move",
				startX: worldX,
				startY: worldY,
				originalBounds,
				affectedElements: this.context.findElementsOnArtboard(originalBounds),
			};
			this.updateSelectionUI(artboard);
		} else {
			// Start creating new artboard
			const snappedStart = this.snapPointToElements(
				worldX,
				worldY,
				viewport.zoom,
			);
			this.context.artboardSelect(null);
			this.context.uiUpdateSelectionUI(null);
			this.dragState = {
				mode: "create",
				startX: snappedStart.x,
				startY: snappedStart.y,
				constrainAspect: event.shiftKey,
			};
		}
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const ds = this.dragState;
		if (ds.mode === "idle") {
			this.updateHoverSnap(event, viewport, canvasWidth, canvasHeight);
			return;
		}

		const worldX = this.screenToWorldX(event.x, viewport, canvasWidth);
		const worldY = this.screenToWorldY(event.y, viewport, canvasHeight);

		if (ds.mode === "create") {
			ds.constrainAspect = event.shiftKey;
			const rawBounds = this.calculateBoundsFromDrag(
				ds.startX,
				ds.startY,
				worldX,
				worldY,
				ds.constrainAspect,
			);
			const snapped = this.snapCreateBounds(
				rawBounds,
				ds.startX,
				ds.startY,
				worldX,
				worldY,
				viewport.zoom,
			);
			this.context.uiUpdateSelectionUI({
				bounds: snapped.bounds,
				handles: this.getResizeHandles(snapped.bounds),
			});
			this.updateSnapLineOverlay(snapped.snapLines);
		} else if (ds.mode === "move") {
			const selectedId = this.context.getSelectedArtboardId();
			const deltaX = worldX - ds.startX;
			const deltaY = worldY - ds.startY;

			const snapResult = selectedId
				? this.context.snapArtboard(
						selectedId,
						ds.originalBounds,
						deltaX,
						deltaY,
						viewport.zoom,
					)
				: { deltaX, deltaY, snapLines: [] };

			const newBounds: BoundingBox = {
				...ds.originalBounds,
				minX: ds.originalBounds.minX + snapResult.deltaX,
				maxX: ds.originalBounds.maxX + snapResult.deltaX,
				minY: ds.originalBounds.minY + snapResult.deltaY,
				maxY: ds.originalBounds.maxY + snapResult.deltaY,
			};
			this.context.uiUpdateSelectionUI({
				bounds: newBounds,
				handles: this.getResizeHandles(newBounds),
			});
			this.updateSnapLineOverlay(snapResult.snapLines);
		} else if (ds.mode === "resize") {
			ds.constrainAspect = event.shiftKey;
			const rawBounds = calculateResizedBounds(
				ds.originalBounds,
				ds.handle,
				worldX,
				worldY,
				ds.startX,
				ds.startY,
				ds.constrainAspect,
			);
			const snapped = this.snapResizeBounds(
				rawBounds,
				ds.handle,
				viewport.zoom,
			);
			this.context.uiUpdateSelectionUI({
				bounds: snapped.bounds,
				handles: this.getResizeHandles(snapped.bounds),
			});
			this.updateSnapLineOverlay(snapped.snapLines);
		}
	}

	public onPointerUp(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const ds = this.dragState;
		if (ds.mode === "idle") return;

		const worldX = this.screenToWorldX(event.x, viewport, canvasWidth);
		const worldY = this.screenToWorldY(event.y, viewport, canvasHeight);

		if (ds.mode === "create") {
			ds.constrainAspect = event.shiftKey;
			const rawBounds = this.calculateBoundsFromDrag(
				ds.startX,
				ds.startY,
				worldX,
				worldY,
				ds.constrainAspect,
			);
			const { bounds } = this.snapCreateBounds(
				rawBounds,
				ds.startX,
				ds.startY,
				worldX,
				worldY,
				viewport.zoom,
			);
			// Only create if artboard is large enough
			if (bounds.width > 10 && bounds.height > 10) {
				const artboard: Artboard = {
					id: `artboard-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
					name: `Artboard ${this.context.getArtboards().length + 1}`,
					x: (bounds.minX + bounds.maxX) / 2,
					y: (bounds.minY + bounds.maxY) / 2,
					width: bounds.width,
					height: bounds.height,
				};
				this.context.artboardCreate(artboard);
				this.context.artboardSelect(artboard.id);
				this.updateSelectionUI(artboard);
			} else {
				this.context.uiUpdateSelectionUI(null);
			}
		} else if (ds.mode === "move") {
			const selectedId = this.context.getSelectedArtboardId();
			if (selectedId) {
				// Re-snap at final position
				const deltaX = worldX - ds.startX;
				const deltaY = worldY - ds.startY;
				const snapResult = this.context.snapArtboard(
					selectedId,
					ds.originalBounds,
					deltaX,
					deltaY,
					viewport.zoom,
				);

				if (
					Math.abs(snapResult.deltaX) > 0.1 ||
					Math.abs(snapResult.deltaY) > 0.1
				) {
					// Commit artboard + elements in a single Yjs transaction
					this.context.artboardMoveCommit(
						selectedId,
						{
							x:
								(ds.originalBounds.minX + ds.originalBounds.maxX) / 2 +
								snapResult.deltaX,
							y:
								(ds.originalBounds.minY + ds.originalBounds.maxY) / 2 +
								snapResult.deltaY,
						},
						ds.affectedElements,
						snapResult.deltaX,
						snapResult.deltaY,
					);
				}
				const artboard = this.context
					.getArtboards()
					.find((a) => a.id === selectedId);
				if (artboard) {
					this.updateSelectionUI(artboard);
				}
			}
		} else if (ds.mode === "resize") {
			const selectedId = this.context.getSelectedArtboardId();
			if (selectedId) {
				ds.constrainAspect = event.shiftKey;
				const rawBounds = calculateResizedBounds(
					ds.originalBounds,
					ds.handle,
					worldX,
					worldY,
					ds.startX,
					ds.startY,
					ds.constrainAspect,
				);
				const { bounds: newBounds } = this.snapResizeBounds(
					rawBounds,
					ds.handle,
					viewport.zoom,
				);
				this.context.artboardUpdate(selectedId, {
					x: (newBounds.minX + newBounds.maxX) / 2,
					y: (newBounds.minY + newBounds.maxY) / 2,
					width: newBounds.width,
					height: newBounds.height,
				});
				// Update selection UI with final size
				const artboard = this.context
					.getArtboards()
					.find((a) => a.id === selectedId);
				if (artboard) {
					this.updateSelectionUI(artboard);
				}
			}
		}

		this.updateSnapLineOverlay([]);
		this.dragState = { mode: "idle" };
	}

	public onDoubleClick(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly()) return;

		const worldX = this.screenToWorldX(event.x, viewport, canvasWidth);
		const worldY = this.screenToWorldY(event.y, viewport, canvasHeight);

		const element = this.context.findElementAtPoint(worldX, worldY);
		if (!element) return;

		const elementBounds = this.context.getBounds(element.id);
		if (!elementBounds) return;

		const artboard = this.context.findArtboardAtPoint(worldX, worldY);

		if (artboard) {
			// Fit existing artboard to the element's bounds
			this.context.artboardUpdate(artboard.id, {
				x: (elementBounds.minX + elementBounds.maxX) / 2,
				y: (elementBounds.minY + elementBounds.maxY) / 2,
				width: elementBounds.width,
				height: elementBounds.height,
			});
			const updated = this.context
				.getArtboards()
				.find((a) => a.id === artboard.id);
			if (updated) {
				this.updateSelectionUI(updated);
			}
		} else {
			// Create new artboard fitted to the element's bounds
			const newArtboard: Artboard = {
				id: `artboard-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				name: `Artboard ${this.context.getArtboards().length + 1}`,
				x: (elementBounds.minX + elementBounds.maxX) / 2,
				y: (elementBounds.minY + elementBounds.maxY) / 2,
				width: elementBounds.width,
				height: elementBounds.height,
			};
			this.context.artboardCreate(newArtboard);
			this.context.artboardSelect(newArtboard.id);
			this.updateSelectionUI(newArtboard);
		}

		this.dragState = { mode: "idle" };
	}

	public onCancel(): void {
		this.dragState = { mode: "idle" };
		this.context.uiUpdateSelectionUI(null);
		this.updateSnapLineOverlay([]);
	}

	public getCursor(): string {
		if (this.dragState.mode === "create") return "crosshair";
		if (this.dragState.mode === "move") return "grabbing";
		if (this.dragState.mode === "resize") {
			return getResizeCursor(this.dragState.handle);
		}

		// Check if hovering over selected artboard handle
		const selectedId = this.context.getSelectedArtboardId();
		if (selectedId) {
			return "grab";
		}

		return "crosshair";
	}

	public dispose(): void {}

	private getResizeHandles(bounds: BoundingBox): HandlePosition[] {
		const key = `${bounds.minX},${bounds.minY},${bounds.maxX},${bounds.maxY}`;
		if (key === this.cachedHandleBoundsKey && this.cachedHandles) {
			return this.cachedHandles;
		}
		this.cachedHandles = createResizeHandles(bounds);
		this.cachedHandleBoundsKey = key;
		return this.cachedHandles;
	}

	/**
	 * Preview create-snap while hovering, before the creation drag begins.
	 * Only shown when the pointer would start a new artboard (not over an
	 * existing artboard or a resize handle).
	 */
	private updateHoverSnap(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly()) {
			this.updateSnapLineOverlay([]);
			return;
		}

		const worldX = this.screenToWorldX(event.x, viewport, canvasWidth);
		const worldY = this.screenToWorldY(event.y, viewport, canvasHeight);

		if (
			this.context.findArtboardAtPoint(worldX, worldY) ||
			this.hitTestHandle(worldX, worldY, viewport)
		) {
			this.updateSnapLineOverlay([]);
			return;
		}

		const { snapLines } = this.snapPointToElements(
			worldX,
			worldY,
			viewport.zoom,
		);
		this.updateSnapLineOverlay(snapLines);
	}

	private snapPointToElements(
		x: number,
		y: number,
		zoom: number,
	): { x: number; y: number; snapLines: SnapLine[] } {
		const snapResult = this.context.snapArtboardToElements(
			{
				minX: x,
				minY: y,
				maxX: x,
				maxY: y,
				width: 0,
				height: 0,
			},
			zoom,
		);

		return {
			x: x + snapResult.deltaX,
			y: y + snapResult.deltaY,
			snapLines: snapResult.snapLines,
		};
	}

	private snapCreateBounds(
		rawBounds: BoundingBox,
		startX: number,
		startY: number,
		endX: number,
		endY: number,
		zoom: number,
	): { bounds: BoundingBox; snapLines: SnapLine[] } {
		const targets: SnapTargets = {
			x: endX >= startX ? "max" : "min",
			y: endY >= startY ? "max" : "min",
		};
		return this.snapBoundsByTargets(rawBounds, targets, zoom);
	}

	private snapResizeBounds(
		rawBounds: BoundingBox,
		handle: ResizeHandle,
		zoom: number,
	): { bounds: BoundingBox; snapLines: SnapLine[] } {
		return this.snapBoundsByTargets(
			rawBounds,
			this.getResizeSnapTargets(handle),
			zoom,
		);
	}

	private getResizeSnapTargets(handle: ResizeHandle): SnapTargets {
		switch (handle) {
			case "nw":
				return { x: "min", y: "max" };
			case "n":
				return { x: "none", y: "max" };
			case "ne":
				return { x: "max", y: "max" };
			case "e":
				return { x: "max", y: "none" };
			case "se":
				return { x: "max", y: "min" };
			case "s":
				return { x: "none", y: "min" };
			case "sw":
				return { x: "min", y: "min" };
			case "w":
				return { x: "min", y: "none" };
		}
	}

	private snapBoundsByTargets(
		rawBounds: BoundingBox,
		targets: SnapTargets,
		zoom: number,
	): { bounds: BoundingBox; snapLines: SnapLine[] } {
		const snapLines: SnapLine[] = [];
		const snappedBounds: BoundingBox = { ...rawBounds };

		if (targets.x !== "none") {
			const xEdge =
				targets.x === "min" ? snappedBounds.minX : snappedBounds.maxX;
			const xSnap = this.context.snapArtboardToElements(
				{
					minX: xEdge,
					maxX: xEdge,
					minY: snappedBounds.minY,
					maxY: snappedBounds.maxY,
					width: 0,
					height: snappedBounds.height,
				},
				zoom,
			);
			if (targets.x === "min") {
				snappedBounds.minX += xSnap.deltaX;
			} else {
				snappedBounds.maxX += xSnap.deltaX;
			}
			snappedBounds.width = snappedBounds.maxX - snappedBounds.minX;
			const verticalLine = xSnap.snapLines.find(
				(line) => line.axis === "vertical",
			);
			if (verticalLine) {
				snapLines.push(verticalLine);
			}
		}

		if (targets.y !== "none") {
			const yEdge =
				targets.y === "min" ? snappedBounds.minY : snappedBounds.maxY;
			const ySnap = this.context.snapArtboardToElements(
				{
					minX: snappedBounds.minX,
					maxX: snappedBounds.maxX,
					minY: yEdge,
					maxY: yEdge,
					width: snappedBounds.width,
					height: 0,
				},
				zoom,
			);
			if (targets.y === "min") {
				snappedBounds.minY += ySnap.deltaY;
			} else {
				snappedBounds.maxY += ySnap.deltaY;
			}
			snappedBounds.height = snappedBounds.maxY - snappedBounds.minY;
			const horizontalLine = ySnap.snapLines.find(
				(line) => line.axis === "horizontal",
			);
			if (horizontalLine) {
				snapLines.push(horizontalLine);
			}
		}

		return {
			bounds: snappedBounds,
			snapLines,
		};
	}

	private updateSelectionUI(artboard: Artboard): void {
		const bounds = getArtboardBounds(artboard);
		this.context.uiUpdateSelectionUI({
			bounds,
			handles: this.getResizeHandles(bounds),
		});
	}

	private updateSnapLineOverlay(lines: SnapLine[]): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.artboardSnapLines,
			lines.length > 0
				? {
						zIndex: OVERLAY_Z.snapLine,
						primitives: buildSnapLineOverlay({ lines }, UI_THEME),
					}
				: null,
		);
	}

	private hitTestHandle(
		worldX: number,
		worldY: number,
		viewport: Viewport,
	): ResizeHandle | null {
		const selectedId = this.context.getSelectedArtboardId();
		if (!selectedId) return null;
		const artboard = this.context
			.getArtboards()
			.find((a) => a.id === selectedId);
		if (!artboard) return null;
		const bounds = getArtboardBounds(artboard);
		return hitTestResizeHandle(worldX, worldY, bounds, viewport);
	}

	/** @param constrainAspect Maintain 1:1 aspect ratio */
	private calculateBoundsFromDrag(
		startX: number,
		startY: number,
		endX: number,
		endY: number,
		constrainAspect = false,
	): BoundingBox {
		let deltaX = endX - startX;
		let deltaY = endY - startY;

		// Shift key: constrain to square (1:1 aspect ratio)
		if (constrainAspect) {
			const maxDelta = Math.max(Math.abs(deltaX), Math.abs(deltaY));
			deltaX = Math.sign(deltaX) * maxDelta;
			deltaY = Math.sign(deltaY) * maxDelta;
		}

		const actualEndX = startX + deltaX;
		const actualEndY = startY + deltaY;

		const minX = Math.min(startX, actualEndX);
		const maxX = Math.max(startX, actualEndX);
		const minY = Math.min(startY, actualEndY);
		const maxY = Math.max(startY, actualEndY);

		return {
			minX,
			minY,
			maxX,
			maxY,
			width: maxX - minX,
			height: maxY - minY,
		};
	}

	private screenToWorldX(
		screenX: number,
		viewport: Viewport,
		canvasWidth: number,
	): number {
		const relX = screenX - canvasWidth / 2;
		return viewport.x + relX / viewport.zoom;
	}

	private screenToWorldY(
		screenY: number,
		viewport: Viewport,
		canvasHeight: number,
	): number {
		const relY = screenY - canvasHeight / 2;
		return viewport.y - relY / viewport.zoom; // Y-axis is inverted
	}
}

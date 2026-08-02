/**
 * PathTool - Path creation tool
 * Click to place straight vertices, click+drag for curve vertices
 * Click the first vertex to close the path
 * Enter / tool switch to finalize as an open path
 */

import { createIdentityTransform } from "../document/factory";
import { buildHoverOverlay } from "../renderer/ui/builders/hover";
import { buildPathEditOverlay } from "../renderer/ui/builders/pathEdit";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type {
	ControlPointHandle,
	HoverUIData,
	PathEditUIData,
} from "../renderer/ui/types";
import {
	type CubicBezierSegment,
	cloneAppearance,
	type ElementTransform,
	type Filter,
	generateUid,
	getTransform,
	isBlend,
	isIdentityTransform,
	type Path,
	type Viewport,
} from "../schema";
import {
	calculatePathBounds,
	distanceToSegment,
} from "../utils/geometry/bounds";
import {
	composeTransforms,
	computeTransformOrigin,
	inverseTransform,
	screenToWorld,
	worldToScreen,
} from "../utils/geometry/geometry";
import {
	getWorldSegments,
	resolveSegment,
	splitSegmentAtIndex,
} from "../utils/geometry/segmentOps";
import {
	type AnchorNode,
	anchorsFromSegments,
	applyAnchorCPDrag,
	buildPathControlPoints,
	buildSegments,
	cloneAnchor,
	deleteAnchorFromPath,
	hitTestPathAnchor,
	isSamePoint,
	resetAnchorSegmentCPs,
} from "./pathNodeEditHelpers";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

// --- Main Class ---

export class PathTool implements Tool {
	public readonly name = "path";

	private context: ToolContext;
	private anchors: AnchorNode[] = [];
	private currentMouseWorld: { x: number; y: number } | null = null;
	private pathId = generateUid("obj");
	private hasDraftPath = false;
	private draftPathLayerId: string | null = null;

	private isDragging = false;
	private isClosingDrag = false;
	private isAppendDrag = false;
	private dragStartWorld: { x: number; y: number } | null = null;
	/** Pending handle position during drag */
	private pendingHandleOut: { x: number; y: number } | null = null;

	private isNearFirstVertex = false;
	private hoveredPathId: string | null = null;

	private vertexInsertDrag: {
		pathId: string;
		originalSegments: CubicBezierSegment[];
		segments: CubicBezierSegment[];
		insertedSegIdx: number;
		/** Inserted anchor in the path's local space */
		anchorX: number;
		anchorY: number;
		/** Convert a world-space pointer into the path's local space */
		toLocal: (wx: number, wy: number) => { x: number; y: number };
	} | null = null;

	// Cached viewport info for pathEditUI generation
	private lastViewport: Viewport | null = null;
	private lastCanvasWidth = 0;
	private lastCanvasHeight = 0;

	/** Alt+drag tangent-handle creation on an existing path's vertex */
	private curveEditDrag: {
		pathId: string;
		segmentIndex: number;
		pointType: "start" | "end";
		anchorWorldX: number;
		anchorWorldY: number;
		ancestorTransform: ElementTransform | null;
		/** Path segments captured at drag start, used to recompute on each move */
		originalSegments: CubicBezierSegment[];
		/** Latest previewed segments, committed on pointerUp */
		segments: CubicBezierSegment[];
	} | null = null;

	/** Plain click on an interior vertex -> delete on pointerUp (unless dragged) */
	private pendingDelete: {
		pathId: string;
		segmentIndex: number;
		pointType: "start" | "end";
	} | null = null;

	/** True when PathTool currently owns the displayed pathEditUI for an edit target */
	private displayingEditTarget = false;

	private static readonly CLOSE_THRESHOLD_PX = 12;
	private static readonly DRAG_THRESHOLD_PX = 3;

	public constructor(context: ToolContext) {
		this.context = context;
	}

	public getActivePathId(): string | null {
		if (this.anchors.length === 0 && !this.hasDraftPath) return null;
		return this.pathId;
	}

	public syncFromDocument(path: Path | null): void {
		if (!path) {
			this.hasDraftPath = false;
			this.anchors = [];
			this.isNearFirstVertex = false;
			this.emitPreview();
			return;
		}

		const previousAnchors = this.anchors;

		this.hasDraftPath = true;
		this.anchors = anchorsFromSegments(
			path.segments,
			previousAnchors[0] ? cloneAnchor(previousAnchors[0]) : null,
		);
		// The last anchor's handleOut has no segment to live in, so the
		// document never stores it; carry it over from the previous local
		// state. Matching by index+position keeps this correct across
		// undo/redo: the anchor that is now last only gets its own former
		// handleOut back, never another (e.g. undone) anchor's.
		const pendingLastHandleOut = getPendingLastHandleOut(
			previousAnchors,
			this.anchors,
			path,
		);
		if (pendingLastHandleOut) {
			this.anchors.at(-1)!.handleOut = pendingLastHandleOut;
		}
		this.isNearFirstVertex = false;
		this.emitPreview();
	}

	/**
	 * Display the currently-selected path's vertices (anchors + control-point
	 * handles) while idle. Does nothing while mid-draw — the draft preview owns
	 * the pathEditUI in that case.
	 */
	public refreshUI(): void {
		if (this.anchors.length > 0) return;

		const editTarget = this.getEditTargetPath();
		const vp = this.context.getViewport();
		if (!editTarget || !vp) {
			// Only clear if PathTool was the one displaying an edit target,
			// so a draft preview's pathEditUI is never clobbered here.
			if (this.displayingEditTarget) {
				this.updatePathEditOverlay(null);
				this.displayingEditTarget = false;
			}
			return;
		}

		this.emitPathEditUIForPath(editTarget.path, editTarget.ancestorTransform);
	}

	/**
	 * Emit the anchor/handle overlay (pathEditUI) for a given path. Used both for
	 * the idle selected-path display and for live overlay updates during an edit
	 * drag, where the in-progress preview segments are passed via `path`.
	 */
	private emitPathEditUIForPath(
		path: Path,
		ancestorTransform: ElementTransform | null,
	): void {
		const vp = this.context.getViewport();
		if (!vp) return;

		const controlPoints = buildPathControlPoints(
			path,
			ancestorTransform,
			vp.viewport,
			vp.canvasWidth,
			vp.canvasHeight,
		);
		const segments = getWorldSegments(path, ancestorTransform ?? undefined).map(
			(ws) => ({
				start: ws.start ? { x: ws.start.x, y: ws.start.y } : undefined,
				cp1: { x: ws.cp1.x, y: ws.cp1.y },
				cp2: { x: ws.cp2.x, y: ws.cp2.y },
				end: { x: ws.end.x, y: ws.end.y },
			}),
		);

		this.updatePathEditOverlay({
			paths: [{ pathId: path.id, controlPoints, segments }],
		});
		this.displayingEditTarget = true;
	}

	// --- Tool interface ---

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly() || this.context.isCurrentLayerLocked())
			return;
		if (event.button !== 0) return;

		if (this.hoveredPathId) {
			this.updateHoverOverlay(null);
			this.hoveredPathId = null;
		}

		this.cacheViewport(viewport, canvasWidth, canvasHeight);

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		// Continue existing path from start/end point.
		// Shift forces a brand-new path: skip the edit/continue/insert hit-tests.
		if (this.anchors.length === 0 && !event.shiftKey) {
			// Edit gestures on the currently-selected path's vertices.
			// Endpoint hits fall through to the continue-drawing flow below.
			const editTarget = this.getEditTargetPath();
			if (editTarget) {
				const hit = hitTestPathAnchor(
					editTarget.path,
					editTarget.ancestorTransform,
					worldPos.x,
					worldPos.y,
					PathTool.CLOSE_THRESHOLD_PX / viewport.zoom,
				);
				if (hit && !hit.isEndpoint) {
					if (event.altKey) {
						// Alt+drag: pull symmetric tangent handles out of the vertex.
						// Reset adjacent CPs first so the curve starts from linear.
						const resetSegments = resetAnchorSegmentCPs(
							editTarget.path.segments,
							hit.segmentIndex,
							hit.pointType,
						);
						this.context.previewSegments(editTarget.path.id, resetSegments);
						this.curveEditDrag = {
							pathId: editTarget.path.id,
							segmentIndex: hit.segmentIndex,
							pointType: hit.pointType,
							anchorWorldX: hit.worldX,
							anchorWorldY: hit.worldY,
							ancestorTransform: editTarget.ancestorTransform,
							originalSegments: editTarget.path.segments,
							segments: resetSegments,
						};
					} else {
						// Plain click: delete on pointerUp unless the pointer is dragged.
						this.pendingDelete = {
							pathId: editTarget.path.id,
							segmentIndex: hit.segmentIndex,
							pointType: hit.pointType,
						};
					}
					this.isDragging = true;
					this.dragStartWorld = worldPos;
					return;
				}
			}

			const target = this.findContinuableEndpoint(worldPos, viewport.zoom);
			if (target) {
				let anchors = anchorsFromSegments(target.path.segments, null);
				if (target.from === "start") {
					anchors = reverseAnchors(anchors);
				}
				this.anchors = anchors;
				this.pathId = target.path.id;
				this.hasDraftPath = true;
				this.draftPathLayerId = target.layerId;

				this.isDragging = true;
				this.isClosingDrag = false;
				this.isAppendDrag = true;
				this.dragStartWorld = worldPos;
				this.pendingHandleOut = null;
				return;
			}

			// Insert vertex on existing curve (start drag to adjust CPs)
			const curveHit = this.findCurveHitOnLayer(worldPos, viewport.zoom);
			if (curveHit) {
				const newSegments = splitSegmentAtIndex(
					curveHit.path.segments,
					curveHit.segmentIndex,
					curveHit.t,
				);

				// Inserted anchor is in the path's local space (split operates on
				// local segments). The drag delta must therefore be measured in
				// local space too, so capture the world→local conversion now.
				const leftSeg = newSegments[curveHit.segmentIndex];
				const anchorX = leftSeg.end.x;
				const anchorY = leftSeg.end.y;

				this.context.previewSegments(curveHit.path.id, newSegments);
				this.vertexInsertDrag = {
					pathId: curveHit.path.id,
					originalSegments: curveHit.path.segments,
					segments: newSegments,
					insertedSegIdx: curveHit.segmentIndex,
					anchorX,
					anchorY,
					toLocal: this.buildWorldToLocal(curveHit.path),
				};
				this.isDragging = true;
				this.dragStartWorld = worldPos;
				return;
			}
		}

		// Near first vertex -> start close gesture (click to close, drag to set closing cp2)
		if (this.anchors.length >= 2 && this.isNearFirstVertex) {
			this.isDragging = true;
			this.isClosingDrag = true;
			this.dragStartWorld = { ...this.anchors[0].position };
			this.pendingHandleOut = null;
			return;
		}

		this.isDragging = true;
		this.isClosingDrag = false;
		this.dragStartWorld = worldPos;
		this.pendingHandleOut = null;
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		this.cacheViewport(viewport, canvasWidth, canvasHeight);

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		this.currentMouseWorld = worldPos;

		// Curve-edit drag (alt+drag on an existing vertex): pull tangent handles
		if (this.curveEditDrag) {
			const edit = this.curveEditDrag;
			const dx = worldPos.x - edit.anchorWorldX;
			const dy = worldPos.y - edit.anchorWorldY;
			const segments = applyAnchorCPDrag(
				resetAnchorSegmentCPs(
					edit.originalSegments,
					edit.segmentIndex,
					edit.pointType,
				),
				edit.segmentIndex,
				edit.pointType,
				dx,
				dy,
			);
			edit.segments = segments;
			this.context.previewSegments(edit.pathId, segments);
			const path = this.context.getPathById(edit.pathId);
			if (path)
				this.emitPathEditUIForPath(
					{ ...path, segments },
					edit.ancestorTransform,
				);
			return;
		}

		// Pending-delete: a plain click still deletes, but a drag past the
		// threshold abandons the delete and starts a new path from this vertex.
		if (this.pendingDelete && this.dragStartWorld) {
			const screenDist = this.worldDistToScreenPx(
				worldPos,
				this.dragStartWorld,
				viewport.zoom,
			);
			if (screenDist < PathTool.DRAG_THRESHOLD_PX) return; // still a click candidate
			this.pendingDelete = null; // dragged: abandon delete, start a new path from here
			// fall through to the normal drawing-drag handling below
		}

		if (this.isDragging && this.dragStartWorld) {
			// Vertex insertion drag: adjust CPs symmetrically
			if (this.vertexInsertDrag) {
				const local = this.vertexInsertDrag.toLocal(worldPos.x, worldPos.y);
				const dx = local.x - this.vertexInsertDrag.anchorX;
				const dy = local.y - this.vertexInsertDrag.anchorY;
				this.updateVertexInsertionCPs(dx, dy);
				this.context.previewSegments(
					this.vertexInsertDrag.pathId,
					this.vertexInsertDrag.segments,
				);
				return;
			}

			// Dragging: preview handle
			const closeDragAnchor =
				this.isClosingDrag && this.anchors.length > 0
					? this.anchors[0].position
					: this.dragStartWorld;
			const screenDist = this.worldDistToScreenPx(
				worldPos,
				closeDragAnchor,
				viewport.zoom,
			);
			if (screenDist >= PathTool.DRAG_THRESHOLD_PX) {
				this.pendingHandleOut = worldPos;
			} else {
				this.pendingHandleOut = null;
			}

			// Closing drag: update first anchor's handles so draft path reflects symmetric cp1.
			// The dragged handle is handleOut (toward the cursor) just like a normal vertex, so
			// the first segment leaves the start point in the same direction the rest of the path
			// was drawn; handleIn (the closing segment's incoming tangent) is the symmetric mirror.
			if (this.isClosingDrag && this.hasDraftPath && this.anchors.length > 0) {
				if (this.pendingHandleOut) {
					this.anchors[0] = {
						...this.anchors[0],
						handleOut: this.pendingHandleOut,
						handleIn: mirrorHandle(
							this.anchors[0].position,
							this.pendingHandleOut,
						),
					};
				} else {
					this.anchors[0] = {
						...this.anchors[0],
						handleIn: null,
						handleOut: null,
					};
				}
				this.syncDraftPath();
			}
		} else {
			// Not dragging: check proximity to first vertex or continuable endpoint
			if (this.anchors.length >= 2) {
				const first = this.anchors[0].position;
				const screenDist = this.worldDistToScreenPx(
					worldPos,
					first,
					viewport.zoom,
				);
				this.isNearFirstVertex = screenDist < PathTool.CLOSE_THRESHOLD_PX;
			} else if (this.anchors.length === 0) {
				this.isNearFirstVertex =
					this.findContinuableEndpoint(worldPos, viewport.zoom) !== null;

				// Hover detection for existing paths
				const hitPath = this.context.findPathAtPoint(
					worldPos.x,
					worldPos.y,
					PathTool.CLOSE_THRESHOLD_PX / viewport.zoom,
				);
				if (hitPath) {
					if (this.hoveredPathId !== hitPath.id) {
						this.hoveredPathId = hitPath.id;
						const worldSegs = getWorldSegments(hitPath);
						this.updateHoverOverlay({ pathSegments: [worldSegs] });
					}
				} else if (this.hoveredPathId) {
					this.hoveredPathId = null;
					this.updateHoverOverlay(null);
				}
			} else {
				this.isNearFirstVertex = false;
			}
		}

		this.emitPreview();
	}

	public onPointerUp(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (event.button !== 0 || !this.isDragging || !this.dragStartWorld) return;

		// Curve-edit drag commit (alt+drag tangent handles)
		if (this.curveEditDrag) {
			const edit = this.curveEditDrag;
			this.context.pathUpdate(edit.pathId, edit.segments);
			this.curveEditDrag = null;
			this.isDragging = false;
			this.dragStartWorld = null;
			this.refreshUI();
			return;
		}

		// Pending-delete commit (plain click on an interior vertex)
		if (this.pendingDelete) {
			const del = this.pendingDelete;
			this.pendingDelete = null;
			this.isDragging = false;
			this.dragStartWorld = null;

			const path = this.context.getPathById(del.pathId);
			if (path) {
				const result = deleteAnchorFromPath(
					path,
					del.segmentIndex,
					del.pointType,
				);
				if (result === "erase") {
					this.context.eraseElement(del.pathId);
				} else if (result !== null) {
					this.context.pathUpdate(del.pathId, result);
				}
			}

			this.refreshUI();
			return;
		}

		// Vertex insertion commit
		if (this.vertexInsertDrag) {
			this.context.pathUpdate(
				this.vertexInsertDrag.pathId,
				this.vertexInsertDrag.segments,
			);
			this.vertexInsertDrag = null;
			this.isDragging = false;
			this.dragStartWorld = null;
			return;
		}

		this.cacheViewport(viewport, canvasWidth, canvasHeight);
		this.isDragging = false;
		const isClosingDrag = this.isClosingDrag;
		const anchor = this.dragStartWorld;

		if (isClosingDrag) {
			if (this.pendingHandleOut && this.anchors.length > 0) {
				// handleOut follows the drag (toward the cursor) like a normal vertex, so the
				// first segment leaves the start point in the drawing direction; handleIn is the
				// symmetric mirror used as the closing segment's incoming tangent.
				this.anchors[0] = {
					...this.anchors[0],
					handleOut: this.pendingHandleOut,
					handleIn: mirrorHandle(
						this.anchors[0].position,
						this.pendingHandleOut,
					),
				};
			}

			this.isClosingDrag = false;
			this.dragStartWorld = null;
			this.pendingHandleOut = null;
			this.completePath(true);
			return;
		}

		const isAppend = this.isAppendDrag;
		this.isAppendDrag = false;

		if (isAppend) {
			// Append to existing path: update last anchor's handleOut only (don't push duplicate)
			const handleOut = this.pendingHandleOut;
			const lastAnchor = handleOut ? this.anchors.at(-1) : null;
			if (lastAnchor && handleOut) {
				lastAnchor.handleOut = handleOut;
				lastAnchor.handleIn = mirrorHandle(lastAnchor.position, handleOut);
			}
		} else if (this.pendingHandleOut) {
			// Dragged -> curve vertex
			const handleOut = this.pendingHandleOut;
			const handleIn = mirrorHandle(anchor, handleOut);

			this.anchors.push({
				position: anchor,
				handleOut,
				handleIn,
			});
		} else {
			// Click only -> straight vertex
			this.anchors.push({
				position: anchor,
				handleOut: null,
				handleIn: null,
			});
		}

		this.dragStartWorld = null;
		this.pendingHandleOut = null;
		this.isClosingDrag = false;
		this.syncDraftPath();
		this.emitPreview();
	}

	public onDoubleClick(
		_event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		if (this.anchors.length >= 2) {
			this.completePath(false);
		}
	}

	public onCancel(): void {
		// Called on tool switch. Finalize as open path if 2+ vertices exist
		if (this.anchors.length >= 2) {
			this.completePath(false);
		} else {
			this.forceReset();
		}
	}

	public getCursor(): string {
		if (this.isNearFirstVertex || this.hoveredPathId) return "pointer";
		return "crosshair";
	}

	public onKeyDown(
		event: KeyboardEvent,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): boolean {
		if (event.key === "Escape") {
			this.forceReset();
			return true;
		}

		if (event.key === "Enter") {
			if (this.anchors.length >= 2) {
				this.completePath(false);
			}
			return true;
		}

		if (event.key === "Backspace") {
			if (this.anchors.length > 0) {
				this.anchors.pop();
				this.syncDraftPath();
				this.emitPreview();
			}
			return true;
		}

		return false;
	}

	// --- Private methods ---

	/**
	 * Resolve the path whose vertices can be edited: the first selected element
	 * that is a path. Returns null while mid-draw or readonly, so edit gestures
	 * never interfere with drawing a new path.
	 */
	private getEditTargetPath(): {
		path: Path;
		ancestorTransform: ElementTransform | null;
	} | null {
		if (this.anchors.length > 0 || this.context.isReadonly()) return null;

		for (const id of this.context.getSelectedElementIds()) {
			const path = this.context.getPathById(id);
			if (path) {
				return {
					path,
					ancestorTransform: this.context.getAncestorTransform(id),
				};
			}
		}
		return null;
	}

	private cacheViewport(
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		this.lastViewport = viewport;
		this.lastCanvasWidth = canvasWidth;
		this.lastCanvasHeight = canvasHeight;
	}

	private updateHoverOverlay(hover: HoverUIData | null): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.pathHover,
			hover
				? {
						zIndex: OVERLAY_Z.hover,
						primitives: buildHoverOverlay(hover, UI_THEME),
					}
				: null,
		);
	}

	private updatePathEditOverlay(data: PathEditUIData | null): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.pathHandles,
			data
				? {
						zIndex: OVERLAY_Z.pathEdit,
						primitives: buildPathEditOverlay(data, UI_THEME),
					}
				: null,
		);
	}

	private completePath(closed: boolean): void {
		if (this.anchors.length < 2) {
			this.forceReset();
			return;
		}

		if (!this.hasDraftPath) {
			const segments = buildSegments(this.anchors, closed);
			this.context.pathDraftCreate(this.createPath(segments, this.pathId));
			this.draftPathLayerId = this.context.getCurrentLayerId();
		} else if (closed) {
			const segments = buildSegments(this.anchors, true);
			if (this.draftPathLayerId) {
				this.context.pathDraftUpdate(
					this.draftPathLayerId,
					this.pathId,
					segments,
				);
			}
		}

		this.context.pathComplete(this.pathId);
		this.hasDraftPath = false;
		this.draftPathLayerId = null;
		this.forceReset({ discardDraftPath: false });
	}

	private forceReset({
		discardDraftPath = true,
	}: {
		discardDraftPath?: boolean;
	} = {}): void {
		if (discardDraftPath && this.hasDraftPath) {
			this.context.pathDraftDelete(this.draftPathLayerId, this.pathId);
			this.hasDraftPath = false;
			this.draftPathLayerId = null;
		}

		if (this.vertexInsertDrag) {
			this.context.previewSegments(
				this.vertexInsertDrag.pathId,
				this.vertexInsertDrag.originalSegments,
			);
			this.vertexInsertDrag = null;
		}

		if (this.curveEditDrag) {
			this.context.previewSegments(
				this.curveEditDrag.pathId,
				this.curveEditDrag.originalSegments,
			);
			this.curveEditDrag = null;
		}
		this.pendingDelete = null;

		if (this.hoveredPathId) {
			this.updateHoverOverlay(null);
			this.hoveredPathId = null;
		}

		this.anchors = [];
		this.currentMouseWorld = null;
		this.isNearFirstVertex = false;
		this.isDragging = false;
		this.isClosingDrag = false;
		this.isAppendDrag = false;
		this.dragStartWorld = null;
		this.pendingHandleOut = null;
		this.pathId = generateUid("obj");
		this.displayingEditTarget = false;
		this.context.previewUpdate(null);
		this.updatePathEditOverlay(null);
	}

	private updateVertexInsertionCPs(dx: number, dy: number): void {
		const { segments, insertedSegIdx } = this.vertexInsertDrag!;
		// cp1/cp2 are offsets relative to their anchor (the inserted anchor),
		// so the symmetric handles are simply ±delta — not absolute positions.
		// In-handle of the inserted anchor (cp2 of the left segment)
		segments[insertedSegIdx].cp2 = { x: -dx, y: -dy };
		// Out-handle of the inserted anchor (cp1 of the right segment)
		segments[insertedSegIdx + 1].cp1 = { x: dx, y: dy };
	}

	private emitPreview(): void {
		if (this.anchors.length === 0 && !this.isDragging) {
			this.context.previewUpdate(null);
			// Idle: show the selected path's vertices instead of clearing the UI.
			this.refreshUI();
			return;
		}

		const previewAnchors = this.buildPreviewAnchors();
		let previewSegments: CubicBezierSegment[] | undefined;

		if (this.hasDraftPath) {
			const tailPreviewAnchors = this.buildTailPreviewAnchors(previewAnchors);
			if (tailPreviewAnchors) {
				previewSegments = buildSegments(tailPreviewAnchors, false);
			}
		} else if (previewAnchors.length >= 2) {
			const closed = this.isNearFirstVertex && !this.isDragging;
			previewSegments = buildSegments(previewAnchors, closed);
		}

		if (previewSegments && previewSegments.length > 0) {
			const preview = this.createPath(previewSegments, "preview");
			this.context.previewUpdate(preview);
		} else {
			this.context.previewUpdate(null);
		}

		// Emit pathEditUI for anchor/handle visualization
		this.emitPathEditUI(previewAnchors, previewSegments);
	}

	private syncDraftPath(): void {
		if (this.anchors.length === 0) {
			if (this.hasDraftPath) {
				this.context.pathDraftDelete(this.draftPathLayerId, this.pathId);
				this.hasDraftPath = false;
				this.draftPathLayerId = null;
			}
			return;
		}

		const segments = buildDraftSegments(this.anchors);
		if (segments.length === 0) {
			return;
		}
		if (this.hasDraftPath) {
			if (this.draftPathLayerId) {
				this.context.pathDraftUpdate(
					this.draftPathLayerId,
					this.pathId,
					segments,
				);
			}
			return;
		}

		this.context.pathDraftCreate(this.createPath(segments, this.pathId));
		this.draftPathLayerId = this.context.getCurrentLayerId();
		this.hasDraftPath = true;
	}

	private buildPreviewAnchors(): AnchorNode[] {
		const previewAnchors: AnchorNode[] = [...this.anchors];

		if (this.isClosingDrag) {
			if (this.pendingHandleOut && previewAnchors.length > 0) {
				previewAnchors[0] = {
					...previewAnchors[0],
					handleOut: this.pendingHandleOut,
					handleIn: mirrorHandle(
						previewAnchors[0].position,
						this.pendingHandleOut,
					),
				};
			}
			return previewAnchors;
		}

		if (this.isDragging && this.dragStartWorld) {
			if (this.isAppendDrag) {
				// Append: update last anchor's handles instead of pushing new anchor
				if (this.pendingHandleOut && previewAnchors.length > 0) {
					const last = previewAnchors.at(-1)!;
					previewAnchors[previewAnchors.length - 1] = {
						...last,
						handleOut: this.pendingHandleOut,
						handleIn: mirrorHandle(last.position, this.pendingHandleOut),
					};
				}
			} else {
				const anchor: AnchorNode = {
					position: this.dragStartWorld,
					handleOut: this.pendingHandleOut,
					handleIn: this.pendingHandleOut
						? mirrorHandle(this.dragStartWorld, this.pendingHandleOut)
						: null,
				};
				previewAnchors.push(anchor);
			}
		} else if (this.currentMouseWorld && !this.isNearFirstVertex) {
			previewAnchors.push({
				position: this.currentMouseWorld,
				handleOut: null,
				handleIn: null,
			});
		}

		return previewAnchors;
	}

	private buildTailPreviewAnchors(
		previewAnchors: AnchorNode[],
	): AnchorNode[] | null {
		if (previewAnchors.length === 0) return null;

		if (
			(this.isNearFirstVertex &&
				this.anchors.length >= 2 &&
				!this.isDragging) ||
			this.isClosingDrag
		) {
			return [previewAnchors.at(-1)!, previewAnchors[0]];
		}

		const from = previewAnchors.at(-2) ?? previewAnchors.at(-1);
		const to = previewAnchors.at(-1);
		// Positional degeneracy check, not object identity: at pointerup
		// `currentMouseWorld` is pushed as a distinct anchor coincident with the
		// just-placed vertex, which would otherwise emit a zero-length preview
		// stroke onto the active layer.
		if (!from || !to || isSamePoint(from.position, to.position)) return null;

		return [from, to];
	}

	/**
	 * Build PathEditUIData from current anchors and segments
	 * for UILayer to render control points and handles
	 */
	private emitPathEditUI(
		anchors: AnchorNode[],
		segments?: CubicBezierSegment[],
	): void {
		if (anchors.length === 0) {
			this.updatePathEditOverlay(null);
			return;
		}

		const viewport = this.lastViewport;
		if (!viewport) {
			this.updatePathEditOverlay(null);
			return;
		}

		const controlPoints: ControlPointHandle[] =
			this.buildControlPointsFromAnchors(anchors, this.isClosingDrag);

		const uiSegments = segments?.map((seg, i) => {
			const resolved = resolveSegment(
				seg,
				i > 0 ? segments[i - 1].end : undefined,
			);
			return {
				start: resolved.start
					? { x: resolved.start.x, y: resolved.start.y }
					: undefined,
				cp1: { x: resolved.cp1.x, y: resolved.cp1.y },
				cp2: { x: resolved.cp2.x, y: resolved.cp2.y },
				end: { x: resolved.end.x, y: resolved.end.y },
			};
		});

		this.updatePathEditOverlay({
			paths: [
				{
					pathId: "preview",
					controlPoints,
					segments: uiSegments ?? [],
				},
			],
		});
	}

	/**
	 * Convert AnchorNode array into ControlPointHandle array
	 * for UILayer rendering (anchor points + control point handles)
	 */
	private buildControlPointsFromAnchors(
		anchors: AnchorNode[],
		closingDrag = false,
	): ControlPointHandle[] {
		const viewport = this.lastViewport!;
		const handles: ControlPointHandle[] = [];

		for (let i = 0; i < anchors.length; i++) {
			const anchor = anchors[i];
			const screen = worldToScreen(
				anchor.position.x,
				anchor.position.y,
				viewport,
				this.lastCanvasWidth,
				this.lastCanvasHeight,
			);

			// Anchor point as end of previous segment (if not first)
			if (i > 0) {
				handles.push({
					type: "anchor",
					pathId: "preview",
					segmentIndex: i - 1,
					pointType: "end",
					worldX: anchor.position.x,
					worldY: anchor.position.y,
					screenX: screen.x,
					screenY: screen.y,
					selected: false,
				});
			}

			// Anchor point as start of current segment.
			// When the last anchor has handleOut, keep start/cp1 visible as pending next segment.
			const hasPendingNextSegment =
				i === anchors.length - 1 && !!anchor.handleOut;
			if (i < anchors.length - 1 || hasPendingNextSegment) {
				handles.push({
					type: "anchor",
					pathId: "preview",
					segmentIndex: i,
					pointType: "start",
					worldX: anchor.position.x,
					worldY: anchor.position.y,
					screenX: screen.x,
					screenY: screen.y,
					selected: false,
				});
			}

			// First anchor is only start
			if (i === 0) {
				handles.push({
					type: "anchor",
					pathId: "preview",
					segmentIndex: 0,
					pointType: "start",
					worldX: anchor.position.x,
					worldY: anchor.position.y,
					screenX: screen.x,
					screenY: screen.y,
					selected: false,
				});
			}

			// Last anchor is only end
			if (i === anchors.length - 1) {
				handles.push({
					type: "anchor",
					pathId: "preview",
					segmentIndex: i - 1,
					pointType: "end",
					worldX: anchor.position.x,
					worldY: anchor.position.y,
					screenX: screen.x,
					screenY: screen.y,
					selected: false,
				});
			}

			// handleIn (control point from previous segment)
			// i>0: always show as cp2 of segment i-1
			// i=0 + closingDrag: show as cp2 of closing segment (index = last)
			if (anchor.handleIn && (i > 0 || closingDrag)) {
				const segIdx = i > 0 ? i - 1 : anchors.length - 1;
				const cpScreen = worldToScreen(
					anchor.handleIn.x,
					anchor.handleIn.y,
					viewport,
					this.lastCanvasWidth,
					this.lastCanvasHeight,
				);
				handles.push({
					type: "control",
					pathId: "preview",
					segmentIndex: segIdx,
					pointType: "cp2",
					worldX: anchor.handleIn.x,
					worldY: anchor.handleIn.y,
					screenX: cpScreen.x,
					screenY: cpScreen.y,
					selected: false,
				});

				// For closing segment: add "end" anchor so UILayer draws cp2→anchor line
				if (i === 0 && closingDrag) {
					handles.push({
						type: "anchor",
						pathId: "preview",
						segmentIndex: segIdx,
						pointType: "end",
						worldX: anchor.position.x,
						worldY: anchor.position.y,
						screenX: screen.x,
						screenY: screen.y,
						selected: false,
					});
				}
			}

			// handleOut (control point toward next segment)
			if (anchor.handleOut) {
				const cpScreen = worldToScreen(
					anchor.handleOut.x,
					anchor.handleOut.y,
					viewport,
					this.lastCanvasWidth,
					this.lastCanvasHeight,
				);
				handles.push({
					type: "control",
					pathId: "preview",
					segmentIndex: i,
					pointType: "cp1",
					worldX: anchor.handleOut.x,
					worldY: anchor.handleOut.y,
					screenX: cpScreen.x,
					screenY: cpScreen.y,
					selected: false,
				});
			}
		}

		return handles;
	}

	private createPath(segments: CubicBezierSegment[], id: string): Path {
		const activeStroke = this.context.getActiveStrokeAppearance();
		const activeFill = this.context.getActiveFillAppearance();

		const filters: Filter[] = [];

		if (activeStroke) {
			filters.push(cloneAppearance(activeStroke));
		}
		if (activeFill) {
			filters.push(cloneAppearance(activeFill));
		}

		return {
			type: "path",
			id,
			transform: createIdentityTransform(),
			opacity: 1.0,
			blendMode: "normal",
			segments,
			filters,
		};
	}

	private worldDistToScreenPx(
		a: { x: number; y: number },
		b: { x: number; y: number },
		zoom: number,
	): number {
		const dx = (a.x - b.x) * zoom;
		const dy = (a.y - b.y) * zoom;
		return Math.sqrt(dx * dx + dy * dy);
	}

	private findContinuableEndpoint(
		worldPos: { x: number; y: number },
		zoom: number,
	): { path: Path; layerId: string; from: "start" | "end" } | null {
		const layer = this.context.getCurrentLayer();
		const layerId = this.context.getCurrentLayerId();
		if (!layer || !layerId) return null;

		const objects = this.context.getObjects();

		for (const elementId of layer.elementIds) {
			const element = objects[elementId];
			if (!element || element.type !== "path") continue;
			const path = element;
			if (path.segments.length === 0) continue;
			if (path.segments.at(-1)?.isClosed === true) continue;

			const startPt = resolveSegment(path.segments[0], undefined).start;
			if (
				this.worldDistToScreenPx(worldPos, startPt, zoom) <
				PathTool.CLOSE_THRESHOLD_PX
			) {
				return { path, layerId, from: "start" };
			}

			const endPt = path.segments.at(-1)?.end;
			if (
				endPt &&
				this.worldDistToScreenPx(worldPos, endPt, zoom) <
					PathTool.CLOSE_THRESHOLD_PX
			) {
				return { path, layerId, from: "end" };
			}
		}

		return null;
	}

	/**
	 * Build a world→local converter for the path, accounting for the element's
	 * (and its ancestors') transform. Local geometry equals world coordinates only
	 * at identity transform; moved/scaled/rotated paths need this conversion for
	 * hit testing and edits against raw segments.
	 */
	private buildWorldToLocal(
		path: Path,
	): (wx: number, wy: number) => { x: number; y: number } {
		const ancestorT = this.context.getAncestorTransform(path.id);
		const elementT = getTransform(path);
		const t = ancestorT ? composeTransforms(ancestorT, elementT) : elementT;
		if (isIdentityTransform(t)) return (wx, wy) => ({ x: wx, y: wy });

		const origin = computeTransformOrigin(calculatePathBounds(path));
		return (wx, wy) => inverseTransform(wx, wy, t, origin.x, origin.y);
	}

	/** Find the nearest point on any path's curve within threshold */
	private findCurveHitOnLayer(
		worldPos: { x: number; y: number },
		zoom: number,
	): { path: Path; segmentIndex: number; t: number } | null {
		const layer = this.context.getCurrentLayer();
		if (!layer) return null;

		const objects = this.context.getObjects();
		const toleranceWorld = PathTool.CLOSE_THRESHOLD_PX / zoom;

		// Candidate paths: the layer's own paths, plus each blend's spine, which is
		// absorbed (kept in objects, not in layer.elementIds) but is still editable.
		const candidates: Path[] = [];
		for (const elementId of layer.elementIds) {
			const element = objects[elementId];
			if (!element) continue;
			if (element.type === "path") {
				candidates.push(element);
			} else if (isBlend(element) && element.spineSourceId) {
				const spine = objects[element.spineSourceId];
				if (spine?.type === "path") candidates.push(spine);
			}
		}

		for (const path of candidates) {
			if (path.segments.length === 0) continue;

			// path.segments are in local space; the element's transform offsets the
			// visible curve from those coordinates. Convert the world cursor into the
			// path's local space so hit testing works on transformed paths.
			const local = this.buildWorldToLocal(path)(worldPos.x, worldPos.y);

			let prevEnd: { x: number; y: number } | null = null;
			for (let i = 0; i < path.segments.length; i++) {
				const { distance, t } = distanceToSegment(
					local.x,
					local.y,
					path.segments[i],
					prevEnd,
				);
				// Skip near-endpoint hits (existing anchors)
				if (distance <= toleranceWorld && t > 0.01 && t < 0.99) {
					return { path, segmentIndex: i, t };
				}
				prevEnd = path.segments[i].end;
			}
		}

		return null;
	}
}

// --- Helper functions ---

function mirrorHandle(
	anchor: { x: number; y: number },
	handle: { x: number; y: number },
): { x: number; y: number } {
	return {
		x: 2 * anchor.x - handle.x,
		y: 2 * anchor.y - handle.y,
	};
}

function buildDraftSegments(anchors: AnchorNode[]): CubicBezierSegment[] {
	if (anchors.length <= 1) {
		return [];
	}
	return buildSegments(anchors, false);
}

function reverseAnchors(anchors: AnchorNode[]): AnchorNode[] {
	return anchors
		.map((a) => ({
			position: { ...a.position },
			handleOut: a.handleIn ? { ...a.handleIn } : null,
			handleIn: a.handleOut ? { ...a.handleOut } : null,
		}))
		.reverse();
}

function getPendingLastHandleOut(
	previousAnchors: AnchorNode[],
	anchors: AnchorNode[],
	path: Path,
): { x: number; y: number } | null {
	const isOpenPath = path.segments.at(-1)?.isClosed !== true;
	if (!isOpenPath) return null;

	const last = anchors.at(-1);
	const previous = previousAnchors[anchors.length - 1];
	if (!last || !previous?.handleOut) return null;
	if (
		previous.position.x !== last.position.x ||
		previous.position.y !== last.position.y
	) {
		return null;
	}

	return { x: previous.handleOut.x, y: previous.handleOut.y };
}

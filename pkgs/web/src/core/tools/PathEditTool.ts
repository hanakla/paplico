/**
 * Path Edit Tool
 * Allows editing Bezier control points of path elements
 */

import { buildMarqueeOverlay } from "../renderer/ui/builders/marquee";
import { buildPathEditOverlay } from "../renderer/ui/builders/pathEdit";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type {
	ControlPointHandle,
	MarqueeSelectionUIData,
	MeshCageHandle,
	PathEditUIData,
} from "../renderer/ui/types";
import {
	type BezierPoint,
	type CubicBezierSegment,
	type ElementTransform,
	getTransform,
	isBlend,
	isIdentityTransform,
	isMesh,
	isPath,
	type MeshArtObject,
	type Path,
	type PathSegment,
	type Viewport,
} from "../schema";
import { blendKeyOutlines } from "../utils/geometry/blendInterpolation";
import {
	brandLocalBBox,
	calculateMeshCoordinateBounds,
	calculatePathBounds,
	distanceToSegment,
	pointInPolygon,
} from "../utils/geometry/bounds";
import {
	applyTransformToPoint,
	composeTransforms,
	computeTransformOrigin,
	inverseTransform,
	screenToWorld,
	type WorldBezierSegment,
	worldToScreen,
} from "../utils/geometry/geometry";
import {
	applyMeshHandleFan,
	beginMeshHandleFan,
	collectMeshCPHandles,
	collectMeshEdgeCurves,
	findClosestMeshEdgePoint,
	type MeshHandleFanState,
	slideMeshVertex,
	writeMeshCPHandle,
} from "../utils/geometry/meshEditing";
import {
	bilinearUV,
	deleteMeshVertex,
	pointInBezierFace,
	rotateDerivedCrossHandles,
	syncDerivedVertices,
} from "../utils/geometry/meshGradient";
import {
	demoteWarpVertexToDerived,
	promoteWarpVertexToExplicit,
	subdivideWarpFace,
} from "../utils/geometry/meshWarp";
import {
	getStartAnchor,
	getWorldSegments,
	reconstructSegmentsFromWorld,
	resolveCP1,
	resolveCP2,
	toRelativeCP1,
	toRelativeCP2,
} from "../utils/geometry/segmentOps";
import { matchKey } from "../utils/keyboard";
import { deepClone } from "../utils/lang";
import {
	applyAnchorCPDrag,
	breakDeleteAnchorsFromPath,
	cutPathSegments,
	deleteAnchorFromPath,
	deleteAnchorsFromPath,
	hitTestPathAnchor,
	type PathCutPosition,
	resetAnchorSegmentCPs,
} from "./pathNodeEditHelpers";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

/** Shared fields for all handle-drag modes */
type DraggingStateBase = {
	handles: Map<string, ControlPointHandle>;
	startPositions: Map<string, { x: number; y: number }>;
	primaryHandleKey: string;
	/** Handle key clicked at pointerDown (selection is finalized at pointerUp) */
	clickedHandleKey: string;
	shiftKey: boolean;
	hasMoved: boolean;
	/** Drag start world coordinates (for touch device threshold) */
	startX: number;
	startY: number;
	/** Drag start screen coordinates */
	startScreenX: number;
	startScreenY: number;
	pointerType: "mouse" | "pen" | "touch";
};

type DragState =
	| {
			mode: "idle";
			/**
			 * CP handle just double-tapped. The press that follows drags it free
			 * of the mirror; any pointerDown replaces this state, so it never
			 * outlives that one press.
			 */
			mirrorBreakKey?: string;
	  }
	| (DraggingStateBase & {
			mode: "controlPointDrag";
			/** Whether to mirror cp1/cp2 (determined at pointerDown) */
			mirrorFlags: Map<string, boolean>;
			/** Original world positions of mirror-target CPs at drag start */
			mirrorSources: Map<string, { x: number; y: number }>;
			/** Alt+anchor drag: pull out tangent CP after resetting CPs */
			anchorCPCreation?: {
				pathId: string;
				segmentIndex: number;
				pointType: "start" | "end";
				anchorX: number;
				anchorY: number;
			};
	  })
	| (DraggingStateBase & {
			mode: "cornerRadiusDrag";
			/** Initial radius values at drag start */
			startRadii: Map<string, number>;
	  })
	| (DraggingStateBase & {
			mode: "superellipseKDrag";
			/** Initial K values at drag start */
			startSuperellipseKs: Map<string, number>;
	  })
	| {
			mode: "faceDragPending";
			startX: number;
			startY: number;
			pointerType: "mouse" | "pen" | "touch";
			/** Alt held at pointerDown: duplicate the whole path on first move */
			altKey: boolean;
	  }
	| {
			mode: "faceDrag";
			/** Drag path face to move entire path */
			startX: number;
			startY: number;
			hasMoved: boolean;
			/** Alt held at pointerDown: duplicate the whole path on first move */
			altKey: boolean;
			/** Whether the alt-drag duplication has already run */
			hasDuplicated: boolean;
	  }
	| {
			mode: "marquee";
			startX: number;
			startY: number;
			shiftKey: boolean;
	  }
	| {
			mode: "pending-lasso";
			startX: number;
			startY: number;
			shiftKey: boolean;
	  }
	| {
			mode: "lasso";
			path: Array<{ x: number; y: number }>;
			shiftKey: boolean;
	  }
	| {
			/**
			 * Whole-element drag for objects without editable vertices (images,
			 * mesh containers, …): the element translates as a unit.
			 */
			mode: "elementDrag";
			elementId: string;
			layerId: string;
			startX: number;
			startY: number;
			originTransform: ElementTransform;
			hasMoved: boolean;
	  }
	| {
			mode: "meshVertexDrag";
			meshId: string;
			/** Vertex under the pointer. */
			vertexIndex: number;
			/** Pointer position at drag start, in mesh-local space. */
			startX: number;
			startY: number;
			/**
			 * Pre-drag positions of every vertex moving with this drag (the whole
			 * selection within the mesh), used to apply one shared delta.
			 */
			origins: Array<{ index: number; x: number; y: number }>;
			/** Working copy committed on pointer-up (src is never modified). */
			draft: MeshArtObject;
			hasMoved: boolean;
	  }
	| {
			mode: "meshCpDrag";
			meshId: string;
			vertexIndex: number;
			neighborIndex: number;
			draft: MeshArtObject;
			hasMoved: boolean;
	  }
	| {
			/** Alt-drag on a cage vertex; see {@link MeshHandleFanState}. */
			mode: "meshFanDrag";
			meshId: string;
			vertexIndex: number;
			draft: MeshArtObject;
			hasMoved: boolean;
			fan: MeshHandleFanState;
	  };

export class PathEditTool implements Tool {
	private static HIT_TOLERANCE_SCREEN_PX = 4;
	/** Minimum world-unit distance from vertex to corner-radius handle */
	private static CORNER_HANDLE_MIN_DISTANCE = 20;
	/** Screen-px distance from a cage edge within which a double-click splits it */
	private static MESH_EDGE_SPLIT_TOLERANCE_PX = 8;
	/** Screen-px within which a cut snaps to an existing anchor instead of a segment */
	private static CUT_ANCHOR_TOLERANCE_SCREEN_PX = 8;
	/** Screen-px the pointer must travel before a cage drag starts moving */
	private static DRAG_THRESHOLD_SCREEN_PX = 3;

	public readonly name = "path-edit";

	private context: ToolContext;
	private selectedPaths = new Map<string, Path>();
	private selectedHandles = new Set<string>();
	private pathAncestorTransforms = new Map<string, ElementTransform | null>();
	private selectedMeshes = new Map<string, MeshArtObject>();
	private meshAncestorTransforms = new Map<string, ElementTransform | null>();
	/** Selected cage vertices, keyed `${meshId}:${vertexIndex}`. */
	private selectedMeshVertices = new Set<string>();
	private dragState: DragState = { mode: "idle" };

	// Coordinate cache for performance
	private cachedControlPoints = new Map<string, ControlPointHandle[]>();
	private lastViewport: Viewport | null = null;
	private pointerDownTime = 0;
	private static readonly LONG_PRESS_MS = 400;
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	private longPressRing: { worldX: number; worldY: number } | null = null;

	public constructor(context: ToolContext) {
		this.context = context;
	}

	/** Carries over selection from SelectTool on tool switch */
	public initWithSelectedPaths(
		paths: Path[],
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
		meshes: MeshArtObject[] = [],
	): void {
		this.selectedPaths.clear();
		this.selectedHandles.clear();
		this.cachedControlPoints.clear();
		this.pathAncestorTransforms.clear();
		this.selectedMeshes.clear();
		this.meshAncestorTransforms.clear();
		this.selectedMeshVertices.clear();

		for (const path of paths) {
			this.selectedPaths.set(path.id, path);
			this.pathAncestorTransforms.set(
				path.id,
				this.context.getAncestorTransform(path.id),
			);
		}
		for (const mesh of meshes) {
			this.selectedMeshes.set(mesh.id, mesh);
			this.meshAncestorTransforms.set(
				mesh.id,
				this.context.getAncestorTransform(mesh.id),
			);
		}

		if (paths.length > 0) {
			this.context.pathSelect(paths[0].id);
		}
		if (paths.length > 0 || meshes.length > 0) {
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		}
	}

	private getHandleKey(handle: ControlPointHandle): string {
		return `${handle.pathId}:${handle.segmentIndex}:${handle.pointType}`;
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly()) return;

		this.pointerDownTime = Date.now();

		// A CP double-tap only frees the press that immediately follows it
		const mirrorBreakKey =
			this.dragState.mode === "idle"
				? this.dragState.mirrorBreakKey
				: undefined;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		// One overlay refresh serves every hit test this event runs — the
		// finders below read it as-is.
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);

		// Mesh cage handles take priority: they overlay the same channel but
		// their hit ids don't parse as path handles.
		const meshHit = this.findMeshHandleAtPoint(event.x, event.y);
		if (meshHit) {
			if (this.context.isElementLocked(meshHit.meshId)) return;
			const mesh = this.selectedMeshes.get(meshHit.meshId);
			if (!mesh) return;
			const draft = deepClone(mesh);
			if (meshHit.kind === "vertex") {
				const hitKey = meshVertexKey(mesh.id, meshHit.vertexIndex);
				if (event.shiftKey) {
					// Shift+click toggles membership without starting a drag.
					if (!this.selectedMeshVertices.delete(hitKey)) {
						this.selectedMeshVertices.add(hitKey);
					}
					this.dragState = { mode: "idle" };
					this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
					return;
				}
				// Clicking an unselected vertex replaces the selection; clicking one
				// that is already selected keeps the group so it can be dragged.
				if (!this.selectedMeshVertices.has(hitKey)) {
					this.selectedMeshVertices.clear();
					this.selectedMeshVertices.add(hitKey);
				}
				if (event.altKey) {
					this.dragState = {
						mode: "meshFanDrag",
						meshId: mesh.id,
						vertexIndex: meshHit.vertexIndex,
						draft,
						hasMoved: false,
						fan: beginMeshHandleFan(
							mesh.vertices,
							mesh.faces,
							meshHit.vertexIndex,
						),
					};
				} else {
					const grabLocal = this.meshWorldToLocal(mesh, world);
					this.dragState = {
						mode: "meshVertexDrag",
						meshId: mesh.id,
						vertexIndex: meshHit.vertexIndex,
						startX: grabLocal.x,
						startY: grabLocal.y,
						origins: this.selectedVertexIndicesOf(mesh.id).map((index) => ({
							index,
							x: mesh.vertices[index].x,
							y: mesh.vertices[index].y,
						})),
						draft,
						hasMoved: false,
					};
				}
			} else {
				this.dragState = {
					mode: "meshCpDrag",
					meshId: mesh.id,
					vertexIndex: meshHit.vertexIndex,
					neighborIndex: meshHit.neighborIndex,
					draft,
					hasMoved: false,
				};
			}
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		// Cutting takes the click before any selection or drag interpretation:
		// alt+shift is the shortcut, and the panel's cut mode arms a plain click.
		if (
			(this.context.pathEditGetCutMode() || (event.altKey && event.shiftKey)) &&
			this.tryCutAtPoint(world, viewport, canvasWidth, canvasHeight)
		) {
			return;
		}

		// Try to find a handle at the clicked point
		const handle = this.findHandleAtPoint(
			event.x,
			event.y,
			world.x,
			world.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		if (handle) {
			if (this.context.isElementLocked(handle.pathId)) return;

			// If this path isn't selected yet, add it to selection
			if (!this.selectedPaths.has(handle.pathId)) {
				const newPath = this.context.getPathById(handle.pathId);
				if (newPath) {
					if (!event.shiftKey) {
						this.selectedPaths.clear();
						this.selectedHandles.clear();
						this.pathAncestorTransforms.clear();
					}
					this.selectedPaths.set(handle.pathId, newPath);
					this.pathAncestorTransforms.set(
						handle.pathId,
						this.context.getAncestorTransform(handle.pathId),
					);
				}
			}

			const handleKey = this.getHandleKey(handle);

			// Alt+click on anchor: reset CPs and enter CP creation drag mode.
			// Alt+drag on a vertex stays anchor CP editing; whole-path duplication
			// only happens on alt+drag over an edge or the face (handled below).
			if (
				event.altKey &&
				handle.type === "anchor" &&
				(handle.pointType === "start" || handle.pointType === "end")
			) {
				const path = this.selectedPaths.get(handle.pathId);
				if (path) {
					const resetPath = this.resetAnchorCPs(
						path,
						handle.segmentIndex,
						handle.pointType,
					);
					this.selectedPaths.set(handle.pathId, resetPath);
					this.cachedControlPoints.delete(handle.pathId);

					this.selectedHandles.clear();
					this.selectedHandles.add(handleKey);

					this.dragState = {
						mode: "controlPointDrag",
						handles: new Map([[handleKey, handle]]),
						startPositions: new Map([
							[handleKey, { x: handle.worldX, y: handle.worldY }],
						]),
						primaryHandleKey: handleKey,
						mirrorFlags: new Map(),
						mirrorSources: new Map(),
						clickedHandleKey: handleKey,
						shiftKey: event.shiftKey,
						hasMoved: false,
						startX: world.x,
						startY: world.y,
						startScreenX: event.x,
						startScreenY: event.y,
						pointerType: event.pointerType,
						anchorCPCreation: {
							pathId: handle.pathId,
							segmentIndex: handle.segmentIndex,
							pointType: handle.pointType,
							anchorX: handle.worldX,
							anchorY: handle.worldY,
						},
					};

					this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
					return;
				}
			}

			const canonicalKey = this.canonicalHandleKey(handleKey);
			const alreadySelected = this.selectedHandles.has(canonicalKey);

			if (event.shiftKey) {
				// Shift+click: toggle selection immediately
				if (this.selectedHandles.has(canonicalKey)) {
					this.deselectHandleWithCompanion(handleKey);
				} else {
					this.selectHandleWithCompanion(handleKey);
				}
			} else if (!alreadySelected) {
				// Unselected handle: select only this handle immediately so drag works
				this.selectedHandles.clear();
				this.selectHandleWithCompanion(handleKey);
			}
			// Selected handle without shift: keep current selection for multi-handle drag;
			// single-handle selection is confirmed in onPointerUp if no drag occurs.

			// Prepare for dragging selected handles.
			// Each corner handle type gets its own drag mode to avoid mixing.
			const clickedType = handle.type;
			const isCornerDrag =
				clickedType === "corner-radius" ||
				clickedType === "corner-superellipse-k";

			const dragHandles = new Map<string, ControlPointHandle>();
			const startPositions = new Map<string, { x: number; y: number }>();
			const startRadii = new Map<string, number>();
			const startSuperellipseKs = new Map<string, number>();
			const mirrorFlags = new Map<string, boolean>();

			for (const pathEntry of this.selectedPaths.values()) {
				const cpHandles = this.extractControlPoints(
					pathEntry,
					viewport,
					canvasWidth,
					canvasHeight,
				);

				for (const h of cpHandles) {
					const key = this.getHandleKey(h);
					if (!this.selectedHandles.has(this.canonicalHandleKey(key))) continue;
					// Corner drag: only collect handles matching the clicked type
					if (isCornerDrag && h.type !== clickedType) continue;
					// Regular drag: skip corner handles
					if (
						!isCornerDrag &&
						(h.type === "corner-radius" || h.type === "corner-superellipse-k")
					)
						continue;

					dragHandles.set(key, h);
					startPositions.set(key, { x: h.worldX, y: h.worldY });
					if (h.pointType === "corner-radius") {
						const seg = pathEntry.segments[h.segmentIndex] as PathSegment;
						startRadii.set(key, seg.cornerRadius ?? 0);
					}
					if (h.pointType === "corner-superellipse-k") {
						const seg = pathEntry.segments[h.segmentIndex] as PathSegment;
						startSuperellipseKs.set(key, seg.cornerSuperellipseN ?? 2);
					}

					// Pre-compute mirror flag for CP handles at pointerDown time.
					// A double-tapped CP drags alone, leaving its partner in place.
					if (h.pointType === "cp1" || h.pointType === "cp2") {
						mirrorFlags.set(
							key,
							key === mirrorBreakKey
								? false
								: this.shouldMirrorHandle(pathEntry, h),
						);
					}
				}
			}

			const baseDragState = {
				handles: dragHandles,
				startPositions,
				primaryHandleKey: handleKey,
				clickedHandleKey: handleKey,
				shiftKey: event.shiftKey,
				hasMoved: false,
				startX: world.x,
				startY: world.y,
				startScreenX: event.x,
				startScreenY: event.y,
				pointerType: event.pointerType,
			} satisfies DraggingStateBase;

			if (clickedType === "corner-radius") {
				this.dragState = {
					...baseDragState,
					mode: "cornerRadiusDrag",
					startRadii,
				};
			} else if (clickedType === "corner-superellipse-k") {
				this.dragState = {
					...baseDragState,
					mode: "superellipseKDrag",
					startSuperellipseKs,
				};
			} else {
				// Snapshot original world positions of mirror-target CPs
				const mirrorSources = new Map<string, { x: number; y: number }>();
				for (const [key, flag] of mirrorFlags) {
					if (!flag) continue;
					const h = dragHandles.get(key);
					if (!h) continue;
					const pathEntry = this.selectedPaths.get(h.pathId);
					if (!pathEntry) continue;
					const ws = getWorldSegments(
						pathEntry,
						this.pathAncestorTransforms.get(h.pathId) ?? undefined,
					);
					if (h.pointType === "cp1") {
						const prevIdx =
							h.segmentIndex > 0 ? h.segmentIndex - 1 : ws.length - 1;
						const cp2 = ws[prevIdx].cp2;
						mirrorSources.set(key, { x: cp2.x, y: cp2.y });
					} else if (h.pointType === "cp2") {
						const nextIdx =
							h.segmentIndex < ws.length - 1 ? h.segmentIndex + 1 : 0;
						const cp1 = ws[nextIdx].cp1;
						mirrorSources.set(key, { x: cp1.x, y: cp1.y });
					}
				}

				this.dragState = {
					...baseDragState,
					mode: "controlPointDrag",
					mirrorFlags,
					mirrorSources,
				};

				// Start long-press timer for anchor handles
				if (
					handle.type === "anchor" &&
					(handle.pointType === "start" || handle.pointType === "end")
				) {
					this.startLongPressTimer(
						handle.worldX,
						handle.worldY,
						viewport,
						canvasWidth,
						canvasHeight,
					);
				}
			}

			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		// No handle clicked - check if clicking on a selected path's face (for face drag)
		if (this.selectedPaths.size > 0) {
			const hitPath = this.context.findPathAtPoint(
				world.x,
				world.y,
				PathEditTool.HIT_TOLERANCE_SCREEN_PX / viewport.zoom,
				true,
			);
			if (hitPath && this.selectedPaths.has(hitPath.id)) {
				// Clicked on the face of an already-selected path → pending before drag
				this.dragState = {
					mode: "faceDragPending",
					startX: world.x,
					startY: world.y,
					pointerType: event.pointerType,
					altKey: event.altKey,
				};
				this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
				return;
			}
		}

		// No handle and no face drag - try to select a path
		const hitPath = this.context.findPathAtPoint(
			world.x,
			world.y,
			PathEditTool.HIT_TOLERANCE_SCREEN_PX / viewport.zoom,
			true,
		);

		if (hitPath) {
			if (event.shiftKey) {
				// Shift+click: add/remove path from selection
				if (this.selectedPaths.has(hitPath.id)) {
					this.selectedPaths.delete(hitPath.id);
					this.pathAncestorTransforms.delete(hitPath.id);
				} else {
					this.selectedPaths.set(hitPath.id, hitPath);
					this.pathAncestorTransforms.set(
						hitPath.id,
						this.context.getAncestorTransform(hitPath.id),
					);
				}
			} else {
				// Normal click: select single path
				this.selectedPaths.clear();
				this.pathAncestorTransforms.clear();
				this.selectedPaths.set(hitPath.id, hitPath);
				this.pathAncestorTransforms.set(
					hitPath.id,
					this.context.getAncestorTransform(hitPath.id),
				);
			}

			// Select all anchor vertices of the newly selected path(s)
			if (!event.shiftKey) {
				this.selectedHandles.clear();
			}
			for (const path of this.selectedPaths.values()) {
				const cpHandles = this.extractControlPoints(
					path,
					viewport,
					canvasWidth,
					canvasHeight,
				);
				for (const h of cpHandles) {
					if (
						(h.type === "anchor" && h.pointType === "end") ||
						h.type === "corner-radius"
					) {
						this.selectedHandles.add(this.getHandleKey(h));
					}
				}
			}

			// Notify path selection
			if (this.selectedPaths.size > 0) {
				this.context.pathSelect(hitPath.id);
			}

			// Enter face drag mode so the user can immediately drag the object
			this.dragState = {
				mode: "faceDrag",
				startX: world.x,
				startY: world.y,
				hasMoved: false,
				altKey: event.altKey,
				hasDuplicated: false,
			};

			// Update UI to show control points
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		} else if (
			this.selectWholeElementAt(world, viewport, canvasWidth, canvasHeight)
		) {
			// A non-path element (image, mesh container, …) was picked up.
			return;
		} else {
			// Empty space: start marquee/lasso selection
			if (!event.shiftKey) {
				this.selectedHandles.clear();
				this.selectedPaths.clear();
				this.pathAncestorTransforms.clear();
			}
			const selMode = this.context.pathEditGetSelectionMode();
			if (selMode === "lasso") {
				this.dragState = {
					mode: "pending-lasso",
					startX: world.x,
					startY: world.y,
					shiftKey: event.shiftKey,
				};
			} else {
				this.dragState = {
					mode: "marquee",
					startX: world.x,
					startY: world.y,
					shiftKey: event.shiftKey,
				};
			}
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		}
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const ds = this.dragState;
		if (ds.mode === "idle") return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		if (ds.mode === "meshVertexDrag" || ds.mode === "meshCpDrag") {
			this.handleMeshDragMove(ds, world, viewport, canvasWidth, canvasHeight);
			return;
		}

		if (ds.mode === "meshFanDrag") {
			this.handleMeshFanMove(ds, world, viewport, canvasWidth, canvasHeight);
			return;
		}

		if (ds.mode === "elementDrag") {
			const dx = world.x - ds.startX;
			const dy = world.y - ds.startY;
			if (!ds.hasMoved && Math.hypot(dx, dy) * viewport.zoom < 3) return;
			ds.hasMoved = true;
			// Yjs-free preview; the single commit happens on release.
			this.context.previewDeformation([
				{
					elementId: ds.elementId,
					layerId: ds.layerId,
					updates: {
						transform: {
							...ds.originTransform,
							x: ds.originTransform.x + dx,
							y: ds.originTransform.y + dy,
						},
					},
				},
			]);
			return;
		}

		if (ds.mode === "marquee") {
			this.updateMarqueeOverlay({
				startX: ds.startX,
				startY: ds.startY,
				endX: world.x,
				endY: world.y,
			});
			return;
		}

		if (ds.mode === "pending-lasso") {
			const worldDist = Math.hypot(world.x - ds.startX, world.y - ds.startY);
			if (worldDist * viewport.zoom > 3) {
				this.dragState = {
					mode: "lasso",
					shiftKey: ds.shiftKey,
					path: [
						{ x: ds.startX, y: ds.startY },
						{ x: world.x, y: world.y },
					],
				};
				this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			}
			return;
		}

		if (ds.mode === "lasso") {
			ds.path.push({ x: world.x, y: world.y });
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		// Promote faceDragPending → faceDrag on threshold
		if (ds.mode === "faceDragPending") {
			const screenPx = ds.pointerType === "mouse" ? 0 : 8;
			const thresholdWorld = screenPx / viewport.zoom;
			const dx = world.x - ds.startX;
			const dy = world.y - ds.startY;
			if (Math.abs(dx) <= thresholdWorld && Math.abs(dy) <= thresholdWorld)
				return;
			this.dragState = {
				mode: "faceDrag",
				startX: ds.startX,
				startY: ds.startY,
				hasMoved: false,
				altKey: ds.altKey,
				hasDuplicated: false,
			};
		}

		// Face drag mode: move all segments of selected paths by delta
		if (this.dragState.mode === "faceDrag") {
			const ds = this.dragState;

			// Alt+drag: duplicate the whole path on the first move, then drag the
			// copies (originals stay put). Mirrors SelectTool's alt-drag duplicate.
			if (ds.altKey && !ds.hasDuplicated) {
				ds.hasDuplicated = true;
				if (!this.context.isReadonly() && this.selectedPaths.size > 0) {
					this.duplicateSelectedPathsForAltDrag(
						viewport,
						canvasWidth,
						canvasHeight,
					);
					// Reset the drag origin to the current pointer so subsequent
					// deltas move the fresh copies (already offset by duplicate()).
					ds.startX = world.x;
					ds.startY = world.y;
				}
			}

			ds.hasMoved = true;

			for (const [pathId, path] of this.selectedPaths) {
				// The rotation/scale pivot is the bbox center of the path's own
				// local bounds (see applyElementTransform / ViewportManager), so
				// it translates together with the geometry. Under
				// `world = R·S·(local − origin) + origin + t`, shifting every
				// local point by d also shifts origin by d, and the world image
				// moves by exactly d regardless of rotation/scale. The local
				// delta therefore IS the world delta — inverse-rotating it here
				// would make the shape travel in a direction rotated by −θ.
				const localDeltaX = world.x - ds.startX;
				const localDeltaY = world.y - ds.startY;

				const newSegments = path.segments.map((seg) => ({
					...seg,
					start: seg.start
						? {
								...seg.start,
								x: seg.start.x + localDeltaX,
								y: seg.start.y + localDeltaY,
							}
						: undefined,
					cp1: seg.cp1,
					cp2: seg.cp2,
					end: {
						...seg.end,
						x: seg.end.x + localDeltaX,
						y: seg.end.y + localDeltaY,
					},
				}));

				this.selectedPaths.set(pathId, { ...path, segments: newSegments });
				this.cachedControlPoints.delete(pathId);
			}

			ds.startX = world.x;
			ds.startY = world.y;
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		// Handle drag modes (controlPointDrag, cornerRadiusDrag, superellipseKDrag)
		if (
			ds.mode !== "controlPointDrag" &&
			ds.mode !== "cornerRadiusDrag" &&
			ds.mode !== "superellipseKDrag"
		)
			return;

		if (!ds.hasMoved) {
			const thresholdPx = ds.pointerType === "mouse" ? 0 : 8;
			const screenDx = event.x - ds.startScreenX;
			const screenDy = event.y - ds.startScreenY;
			if (
				Math.abs(screenDx) <= thresholdPx &&
				Math.abs(screenDy) <= thresholdPx
			)
				return;
			ds.hasMoved = true;
			this.cancelLongPressTimer();

			// Long-press + drag → Alt+drag equivalent (reset CPs and enter CP creation)
			if (ds.mode === "controlPointDrag") {
				const elapsed = Date.now() - this.pointerDownTime;
				const handle = ds.handles.get(ds.clickedHandleKey);
				if (
					elapsed >= PathEditTool.LONG_PRESS_MS &&
					!ds.anchorCPCreation &&
					handle?.type === "anchor" &&
					(handle.pointType === "start" || handle.pointType === "end")
				) {
					const path = this.selectedPaths.get(handle.pathId);
					if (path) {
						const resetPath = this.resetAnchorCPs(
							path,
							handle.segmentIndex,
							handle.pointType,
						);
						this.selectedPaths.set(handle.pathId, resetPath);
						this.cachedControlPoints.delete(handle.pathId);
						ds.anchorCPCreation = {
							pathId: handle.pathId,
							segmentIndex: handle.segmentIndex,
							pointType: handle.pointType,
							anchorX: handle.worldX,
							anchorY: handle.worldY,
						};
					}
				}
			}
		}

		// Alt+anchor drag: create tangent CPs by dragging from anchor
		if (ds.mode === "controlPointDrag" && ds.anchorCPCreation) {
			const { pathId, segmentIndex, pointType, anchorX, anchorY } =
				ds.anchorCPCreation;
			const path = this.selectedPaths.get(pathId);
			if (!path) return;

			const dx = world.x - anchorX;
			const dy = world.y - anchorY;

			const newSegments = applyAnchorCPDrag(
				path.segments,
				segmentIndex,
				pointType,
				dx,
				dy,
			);

			this.selectedPaths.set(pathId, { ...path, segments: newSegments });
			this.cachedControlPoints.delete(pathId);
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		// Delta from the pointer's down position (not handle center)
		// to avoid snapping the handle to the pointer on first move
		const deltaX = world.x - ds.startX;
		const deltaY = world.y - ds.startY;

		// Update all selected paths
		for (const [pathId, path] of this.selectedPaths) {
			const handlesForThisPath = Array.from(ds.handles.values()).filter(
				(h) => h.pathId === pathId,
			);

			if (handlesForThisPath.length === 0) continue;

			let newSegments = [...path.segments];

			if (ds.mode === "cornerRadiusDrag") {
				newSegments = this.handleCornerRadiusDrag(
					ds,
					{ ...path, segments: newSegments as PathSegment[] },
					handlesForThisPath,
					event.x,
					event.y,
					viewport.zoom,
					viewport,
					canvasWidth,
					canvasHeight,
				) as CubicBezierSegment[];
			} else if (ds.mode === "superellipseKDrag") {
				newSegments = this.handleSuperellipseKDrag(
					ds,
					{ ...path, segments: newSegments as PathSegment[] },
					handlesForThisPath,
					world.x,
					world.y,
					viewport.zoom,
				) as CubicBezierSegment[];
			} else {
				for (const handle of handlesForThisPath) {
					const startPos = ds.startPositions.get(this.getHandleKey(handle));
					if (!startPos) continue;

					const newX = startPos.x + deltaX;
					const newY = startPos.y + deltaY;

					newSegments = this.updateControlPoint(
						ds,
						newSegments,
						handle,
						newX,
						newY,
						event.altKey,
					);
				}
			}

			// Update temporary path for preview
			this.selectedPaths.set(pathId, {
				...path,
				segments: newSegments,
			});

			// Real-time preview for all drag modes
			if (this.context.previewSegments) {
				this.context.previewSegments(pathId, newSegments);
			}

			// Invalidate cache for this path since segments changed
			this.cachedControlPoints.delete(pathId);
		}

		// Update UI
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
	}

	public onPointerUp(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		this.clearLongPressRing();
		const ds = this.dragState;

		if (ds.mode === "elementDrag") {
			if (ds.hasMoved) {
				const world = screenToWorld(
					event.x,
					event.y,
					viewport,
					canvasWidth,
					canvasHeight,
				);
				this.context.clearDeformationPreview([ds.elementId]);
				// elementsMove knows the per-type move semantics (path segments,
				// blends, path-bound text, …) and commits once.
				this.context.elementsMove(
					[ds.elementId],
					world.x - ds.startX,
					world.y - ds.startY,
				);
			}
			this.dragState = { mode: "idle" };
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		if (
			ds.mode === "meshVertexDrag" ||
			ds.mode === "meshCpDrag" ||
			ds.mode === "meshFanDrag"
		) {
			if (ds.hasMoved) {
				const layerId = this.context.getCurrentLayerId();
				if (layerId) {
					// Single commit per drag — the preview override was Yjs-free, so
					// this is the whole undo unit.
					this.context.applyDeformation([
						{
							elementId: ds.meshId,
							layerId,
							updates: { vertices: ds.draft.vertices, faces: ds.draft.faces },
						},
					]);
					this.selectedMeshes.set(ds.meshId, ds.draft);
				}
			} else {
				this.context.clearDeformationPreview([ds.meshId]);
			}
			this.dragState = { mode: "idle" };
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		if (ds.mode === "marquee") {
			this.updateMarqueeOverlay(null);

			const world = screenToWorld(
				event.x,
				event.y,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			const minX = Math.min(ds.startX, world.x);
			const maxX = Math.max(ds.startX, world.x);
			const minY = Math.min(ds.startY, world.y);
			const maxY = Math.max(ds.startY, world.y);

			if (!ds.shiftKey) {
				this.selectedHandles.clear();
				this.selectedMeshVertices.clear();
			}

			// Search all editable paths (all layers including groups)
			for (const {
				path,
				ancestorTransform,
			} of this.context.getAllEditablePaths()) {
				const worldSegs = getWorldSegments(
					path,
					ancestorTransform ?? undefined,
				);
				const isClosedPath = path.segments.at(-1)?.isClosed === true;
				for (let i = 0; i < path.segments.length; i++) {
					const seg = path.segments[i];
					const ws = worldSegs[i];
					// Start anchor
					if (i === 0 && seg.start && !isClosedPath && ws.start) {
						const { x, y } = ws.start;
						if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
							if (!this.selectedPaths.has(path.id)) {
								this.selectedPaths.set(path.id, path);
								this.pathAncestorTransforms.set(path.id, ancestorTransform);
							}
							this.selectedHandles.add(`${path.id}:${i}:start`);
						}
					}
					// End anchor + corner-radius
					{
						const { x, y } = ws.end;
						if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
							if (!this.selectedPaths.has(path.id)) {
								this.selectedPaths.set(path.id, path);
								this.pathAncestorTransforms.set(path.id, ancestorTransform);
							}
							this.selectedHandles.add(`${path.id}:${i}:end`);
							this.selectedHandles.add(`${path.id}:${i}:corner-radius`);
						}
					}
				}
			}

			this.selectMeshVerticesWhere(
				({ x, y }) => x >= minX && x <= maxX && y >= minY && y <= maxY,
			);

			if (this.selectedPaths.size === 0 && this.selectedMeshes.size === 0) {
				this.context.selectionClear();
				// Drop the whole-element selection frame this tool may have drawn.
				this.context.uiRefreshSelectionUI(false);
			}

			this.dragState = { mode: "idle" };
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		if (ds.mode === "pending-lasso") {
			this.dragState = { mode: "idle" };
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		if (ds.mode === "lasso") {
			const polygon = ds.path;

			if (!ds.shiftKey) {
				this.selectedHandles.clear();
				this.selectedMeshVertices.clear();
			}

			// Search all editable paths (all layers including groups)
			for (const {
				path,
				ancestorTransform,
			} of this.context.getAllEditablePaths()) {
				const worldSegs = getWorldSegments(
					path,
					ancestorTransform ?? undefined,
				);
				const isClosedPath = path.segments.at(-1)?.isClosed === true;
				for (let i = 0; i < path.segments.length; i++) {
					const seg = path.segments[i];
					const ws = worldSegs[i];
					// Start anchor
					if (i === 0 && seg.start && !isClosedPath && ws.start) {
						const { x, y } = ws.start;
						if (pointInPolygon(x, y, polygon)) {
							if (!this.selectedPaths.has(path.id)) {
								this.selectedPaths.set(path.id, path);
								this.pathAncestorTransforms.set(path.id, ancestorTransform);
							}
							this.selectedHandles.add(`${path.id}:${i}:start`);
						}
					}
					// End anchor + corner-radius
					{
						const { x, y } = ws.end;
						if (pointInPolygon(x, y, polygon)) {
							if (!this.selectedPaths.has(path.id)) {
								this.selectedPaths.set(path.id, path);
								this.pathAncestorTransforms.set(path.id, ancestorTransform);
							}
							this.selectedHandles.add(`${path.id}:${i}:end`);
							this.selectedHandles.add(`${path.id}:${i}:corner-radius`);
						}
					}
				}
			}

			this.selectMeshVerticesWhere(({ x, y }) => pointInPolygon(x, y, polygon));

			if (this.selectedPaths.size === 0 && this.selectedMeshes.size === 0) {
				this.context.selectionClear();
				// Drop the whole-element selection frame this tool may have drawn.
				this.context.uiRefreshSelectionUI(false);
			}

			this.dragState = { mode: "idle" };
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		if (ds.mode === "faceDragPending") {
			// Released before threshold: treat as click on fill
			this.selectedHandles.clear();
			for (const [, path] of this.selectedPaths) {
				const cpHandles = this.extractControlPoints(
					path,
					viewport,
					canvasWidth,
					canvasHeight,
				);
				for (const h of cpHandles) {
					if (
						h.type === "corner-radius" ||
						(h.type === "anchor" &&
							(h.pointType === "start" || h.pointType === "end"))
					) {
						this.selectedHandles.add(this.getHandleKey(h));
					}
				}
			}
			this.dragState = { mode: "idle" };
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return;
		}

		if (ds.mode === "faceDrag") {
			if (!ds.hasMoved) {
				// Click without drag on fill: select all anchor vertices and corner-radius handles
				this.selectedHandles.clear();
				for (const [, path] of this.selectedPaths) {
					const cpHandles = this.extractControlPoints(
						path,
						viewport,
						canvasWidth,
						canvasHeight,
					);
					for (const h of cpHandles) {
						if (
							h.type === "corner-radius" ||
							(h.type === "anchor" &&
								(h.pointType === "start" || h.pointType === "end"))
						) {
							this.selectedHandles.add(this.getHandleKey(h));
						}
					}
				}
				this.dragState = { mode: "idle" };
				this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
				return;
			}

			// Finalize face drag: commit segment updates atomically
			{
				const pathsToCommit: Array<[string, CubicBezierSegment[]]> = [];
				for (const [pathId, path] of this.selectedPaths) {
					pathsToCommit.push([pathId, path.segments]);
				}
				this.context.batchPathUpdate(pathsToCommit);
				for (const [pathId] of pathsToCommit) {
					const updatedPath = this.context.getPathById(pathId);
					if (updatedPath) {
						this.selectedPaths.set(pathId, updatedPath);
					}
				}
			}

			this.dragState = { mode: "idle" };

			if (this.selectedPaths.size > 0) {
				this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			}
			return;
		}

		if (
			ds.mode === "controlPointDrag" ||
			ds.mode === "cornerRadiusDrag" ||
			ds.mode === "superellipseKDrag"
		) {
			if (!ds.hasMoved) {
				// Long-press without drag: delete the anchor (only for anchor handles, not CPs)
				if (ds.mode === "controlPointDrag") {
					const pointType = ds.clickedHandleKey.split(":")[2];
					if (pointType === "start" || pointType === "end") {
						const elapsed = Date.now() - this.pointerDownTime;
						if (elapsed >= PathEditTool.LONG_PRESS_MS) {
							this.deleteSingleAnchor(ds.clickedHandleKey);
							this.dragState = { mode: "idle" };
							this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
							return;
						}
					}
				}

				// Click without drag: confirm single-handle selection
				if (!ds.shiftKey) {
					this.selectedHandles.clear();
					this.selectHandleWithCompanion(ds.clickedHandleKey);
				}
				// Shift+click: toggle was already applied in onPointerDown
			} else {
				// Finalize changes for all dragged paths atomically
				{
					const pathsToCommit: Array<[string, CubicBezierSegment[]]> = [];
					for (const [pathId, path] of this.selectedPaths) {
						const hadDraggedHandles = Array.from(ds.handles.values()).some(
							(h) => h.pathId === pathId,
						);

						if (hadDraggedHandles) {
							pathsToCommit.push([pathId, path.segments]);
						}
					}
					this.context.batchPathUpdate(pathsToCommit);
					for (const [pathId] of pathsToCommit) {
						const updatedPath = this.context.getPathById(pathId);
						if (updatedPath) {
							this.selectedPaths.set(pathId, updatedPath);
						}
					}
				}
			}
		}

		this.dragState = { mode: "idle" };

		// Update UI
		if (this.selectedPaths.size > 0) {
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		}
	}

	public onDoubleClick(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		// One overlay refresh serves every hit test this event runs — the
		// finders below read it as-is.
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);

		// Double-click on a cage vertex: promote a derived vertex to explicit.
		// A vertex hit always wins over the face beneath it, so a double-click
		// on any cage vertex never subdivides the face.
		const meshHit = this.findMeshHandleAtPoint(event.x, event.y);
		if (meshHit?.kind === "vertex") {
			this.promoteMeshVertexToExplicit(
				meshHit.meshId,
				meshHit.vertexIndex,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			return;
		}

		// Double-click near a cage edge: insert a vertex on that edge.
		if (this.splitMeshEdgeAt(world, viewport, canvasWidth, canvasHeight)) {
			return;
		}

		// Double-click inside a selected mesh cage face: subdivide it there.
		if (this.subdivideMeshFaceAt(world, viewport, canvasWidth, canvasHeight)) {
			return;
		}

		const handle = this.findHandleAtPoint(
			event.x,
			event.y,
			world.x,
			world.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		if (!handle) return;

		// Double-tapping one CP of a symmetric pair frees it from the mirror for
		// the drag that follows, so that handle can be shaped on its own. The
		// press right after this double-click consumes the flag.
		if (handle.pointType === "cp1" || handle.pointType === "cp2") {
			this.dragState = {
				mode: "idle",
				mirrorBreakKey: this.getHandleKey(handle),
			};
			return;
		}

		// Only reset CPs for anchor handles (start/end)
		if (handle.type !== "anchor") return;

		const path = this.selectedPaths.get(handle.pathId);
		if (!path) return;

		const newSegments = path.segments.map((seg) => ({
			...seg,
			start: seg.start ? { ...seg.start } : undefined,
			cp1: { ...seg.cp1 },
			cp2: { ...seg.cp2 },
			end: { ...seg.end },
		}));
		const lastSeg = newSegments[newSegments.length - 1];
		const isClosedPath = lastSeg?.isClosed === true;

		if (handle.pointType === "end") {
			const seg = newSegments[handle.segmentIndex];
			// Reset cp2 to zero offset (relative to end anchor)
			seg.cp2 = { x: 0, y: 0 };
			// Reset cp1 of next segment to zero offset (relative to start anchor)
			const nextSeg =
				handle.segmentIndex < newSegments.length - 1
					? newSegments[handle.segmentIndex + 1]
					: isClosedPath
						? newSegments[0]
						: null;
			if (nextSeg) {
				nextSeg.cp1 = { x: 0, y: 0 };
			}
		} else if (handle.pointType === "start") {
			const seg = newSegments[handle.segmentIndex];
			if (seg.start) {
				// Reset cp1 to zero offset (relative to start anchor)
				seg.cp1 = { x: 0, y: 0 };
				// Reset cp2 of previous segment to zero offset (relative to end anchor)
				const prevSeg = isClosedPath
					? newSegments[newSegments.length - 1]
					: null;
				if (prevSeg) {
					prevSeg.cp2 = { x: 0, y: 0 };
				}
			}
		}

		this.context.pathUpdate(handle.pathId, newSegments);
		this.selectedPaths.set(handle.pathId, {
			...path,
			segments: newSegments,
		});
		this.cachedControlPoints.delete(handle.pathId);
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
	}

	public onCancel(): void {
		this.clearLongPressRing();
		if (this.selectedMeshes.size > 0) {
			this.context.clearDeformationPreview([...this.selectedMeshes.keys()]);
		}
		this.selectedMeshes.clear();
		this.meshAncestorTransforms.clear();
		this.selectedMeshVertices.clear();
		this.dragState = { mode: "idle" };
		this.clearSelection();
		this.context.pathEditUpdateSelectedAnchors([]);
		this.context.pathEditSetCutMode(false);
	}

	public saveInterruptibleState(): unknown {
		return {
			selectedPaths: new Map(this.selectedPaths),
			selectedHandles: new Set(this.selectedHandles),
			pathAncestorTransforms: new Map(this.pathAncestorTransforms),
		};
	}

	public restoreFromInterrupt(state: unknown): void {
		const s = state as {
			selectedPaths: typeof this.selectedPaths;
			selectedHandles: typeof this.selectedHandles;
			pathAncestorTransforms: typeof this.pathAncestorTransforms;
		};
		this.selectedPaths = s.selectedPaths;
		this.selectedHandles = s.selectedHandles;
		this.pathAncestorTransforms = s.pathAncestorTransforms;
	}

	public getCursor(): string {
		if (
			this.dragState.mode === "lasso" ||
			this.dragState.mode === "pending-lasso"
		) {
			return "crosshair";
		}
		if (this.dragState.mode !== "idle") {
			return "grabbing";
		}
		// Armed to cut: never offer the grab cursor, the click won't move anything.
		if (this.context.pathEditGetCutMode()) {
			return "crosshair";
		}
		if (this.selectedPaths.size > 0) {
			return "grab";
		}
		return "crosshair";
	}

	/** @returns true if the tool handled the event */
	public onKeyDown(
		event: KeyboardEvent,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		// Delete: plain vertex deletion (no rejoin — the path breaks apart).
		// Shift+Delete: rejoin the neighbors, same as long-press deletion.
		if (event.code === "Delete" || event.code === "Backspace") {
			if (this.selectedMeshVertices.size > 0) {
				return this.deleteSelectedMeshVertices(
					viewport,
					canvasWidth,
					canvasHeight,
				);
			}
			return this.handleDeleteSelectedAnchors(
				event.shiftKey ? "rejoin" : "break",
				viewport,
				canvasWidth,
				canvasHeight,
			);
		}

		// Ctrl+A / Meta+A: select all handles of selected paths
		if (matchKey(event, "KeyA", { ctrlOrMeta: true })) {
			return this.selectAllHandles(viewport, canvasWidth, canvasHeight);
		}

		return false;
	}

	private selectAllHandles(
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		// If no paths are selected, select all editable paths first
		if (this.selectedPaths.size === 0) {
			for (const {
				path,
				ancestorTransform,
			} of this.context.getAllEditablePaths()) {
				this.selectedPaths.set(path.id, path);
				this.pathAncestorTransforms.set(path.id, ancestorTransform);
			}
		}

		if (this.selectedPaths.size === 0) return true;

		for (const path of this.selectedPaths.values()) {
			for (const handle of this.extractControlPoints(
				path,
				viewport,
				canvasWidth,
				canvasHeight,
			)) {
				this.selectedHandles.add(this.getHandleKey(handle));
			}
		}

		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		return true;
	}

	/** @returns true if any anchors were deleted */
	/**
	 * Delete every selected anchor. "break" removes the segments touching each
	 * anchor and leaves the surviving runs as separate paths (no rejoin);
	 * "rejoin" reconnects the neighbors, matching long-press deletion.
	 */
	private handleDeleteSelectedAnchors(
		mode: "break" | "rejoin",
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		if (this.selectedHandles.size === 0) return false;

		// Collect selected anchor points (not control points) per path
		const anchorsByPath = new Map<
			string,
			Array<{ segmentIndex: number; pointType: "start" | "end" }>
		>();
		for (const handleKey of this.selectedHandles) {
			const [pathId, segmentIndexStr, pointType] = handleKey.split(":");
			if (pointType !== "start" && pointType !== "end") continue;
			const list = anchorsByPath.get(pathId) ?? [];
			list.push({
				segmentIndex: Number.parseInt(segmentIndexStr, 10),
				pointType,
			});
			anchorsByPath.set(pathId, list);
		}
		if (anchorsByPath.size === 0) return false;

		// Plan every path's result first so the undo-selection stash happens
		// only when a mutation is actually committed.
		const plans: Array<{
			pathId: string;
			action:
				| { kind: "erase" }
				| { kind: "update"; segments: CubicBezierSegment[] }
				| { kind: "replace"; segmentLists: CubicBezierSegment[][] };
		}> = [];
		for (const [pathId, handles] of anchorsByPath) {
			const path = this.selectedPaths.get(pathId);
			if (!path) continue;

			if (mode === "rejoin") {
				const result = deleteAnchorsFromPath(path, handles);
				if (result === null) continue;
				plans.push({
					pathId,
					action:
						result === "erase"
							? { kind: "erase" }
							: { kind: "update", segments: result },
				});
				continue;
			}

			const runs = breakDeleteAnchorsFromPath(path, handles);
			if (runs === null) continue;
			plans.push({
				pathId,
				action:
					runs === "erase"
						? { kind: "erase" }
						: runs.length === 1
							? { kind: "update", segments: runs[0] }
							: { kind: "replace", segmentLists: runs },
			});
		}
		if (plans.length === 0) return false;

		// Undoing this deletion restores the anchors; stash the selection so
		// they come back selected.
		this.context.stashPathEditUndoSelection([...this.selectedHandles]);

		for (const { pathId, action } of plans) {
			this.cachedControlPoints.delete(pathId);
			if (action.kind === "erase") {
				this.context.eraseElement(pathId);
				this.selectedPaths.delete(pathId);
			} else if (action.kind === "update") {
				this.context.pathUpdate(pathId, action.segments);
				const updatedPath = this.context.getPathById(pathId);
				if (updatedPath) {
					this.selectedPaths.set(pathId, updatedPath);
				} else {
					this.selectedPaths.delete(pathId);
				}
			} else {
				// The path is cut into several new elements; stop editing the
				// original (its id no longer exists).
				this.context.replacePathWithPaths(pathId, action.segmentLists);
				this.selectedPaths.delete(pathId);
			}
		}

		// The deleted anchors' handle keys (and any sibling CP keys pointing at
		// rebuilt segments) are stale — drop the handle selection entirely.
		this.selectedHandles.clear();

		if (this.selectedPaths.size > 0) {
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		} else {
			this.updatePathEditOverlay(null);
		}
		return true;
	}

	/**
	 * Cut the path under the cursor open at that point — on an anchor when one
	 * is within reach, otherwise at the nearest point along a segment. An open
	 * path becomes two elements; a closed one becomes a single open path.
	 * Returns whether a cut happened.
	 */
	private tryCutAtPoint(
		world: { x: number; y: number },
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		const target = this.findCutTarget(world, viewport);
		if (!target) return false;

		const runs = cutPathSegments(
			target.path.segments,
			target.segmentIndex,
			target.position,
		);
		if (!runs) return false;

		const pathId = target.path.id;
		this.context.stashPathEditUndoSelection([...this.selectedHandles]);
		this.cachedControlPoints.delete(pathId);

		if (runs.length === 1) {
			this.context.pathUpdate(pathId, runs[0]);
			const updatedPath = this.context.getPathById(pathId);
			if (updatedPath) {
				this.selectedPaths.set(pathId, updatedPath);
			} else {
				this.selectedPaths.delete(pathId);
			}
		} else {
			// The path becomes several new elements; stop editing the original
			// (its id no longer exists).
			this.context.replacePathWithPaths(pathId, runs);
			this.selectedPaths.delete(pathId);
		}

		// Handle keys point at segments the cut rebuilt.
		this.selectedHandles.clear();
		this.context.pathEditSetCutMode(false);

		if (this.selectedPaths.size > 0) {
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		} else {
			this.updatePathEditOverlay(null);
		}
		return true;
	}

	/** Nearest cut site under the cursor: an anchor when close, else a segment point. */
	private findCutTarget(
		world: { x: number; y: number },
		viewport: Viewport,
	): {
		path: Path;
		segmentIndex: number;
		position: PathCutPosition;
	} | null {
		const editable = this.context
			.getAllEditablePaths()
			.filter(({ path }) => !this.context.isElementLocked(path.id));

		let best: {
			path: Path;
			segmentIndex: number;
			position: PathCutPosition;
		} | null = null;

		let bestDistance =
			PathEditTool.CUT_ANCHOR_TOLERANCE_SCREEN_PX / viewport.zoom;
		for (const { path, ancestorTransform } of editable) {
			const anchor = hitTestPathAnchor(
				path,
				ancestorTransform,
				world.x,
				world.y,
				bestDistance,
			);
			if (!anchor) continue;
			bestDistance = Math.hypot(
				anchor.worldX - world.x,
				anchor.worldY - world.y,
			);
			best = {
				path,
				segmentIndex: anchor.segmentIndex,
				position: { kind: "anchor", pointType: anchor.pointType },
			};
		}
		if (best) return best;

		// No anchor nearby, so cut where the cursor meets the curve. The bezier
		// parameter is affine-invariant, which lets a t measured on the world
		// curve index the same point on the stored local segment.
		bestDistance = PathEditTool.HIT_TOLERANCE_SCREEN_PX / viewport.zoom;
		for (const { path, ancestorTransform } of editable) {
			const worldSegments = reconstructSegmentsFromWorld(
				getWorldSegments(path, ancestorTransform ?? undefined),
				path.segments,
			);
			let prevEnd: BezierPoint | null = null;
			for (let i = 0; i < worldSegments.length; i++) {
				const { distance, t } = distanceToSegment(
					world.x,
					world.y,
					worldSegments[i],
					prevEnd,
				);
				prevEnd = worldSegments[i].end;
				// Hits next to an anchor belong to the pass above.
				if (t <= 0.01 || t >= 0.99 || distance > bestDistance) continue;
				bestDistance = distance;
				best = { path, segmentIndex: i, position: { kind: "edge", t } };
			}
		}
		return best;
	}

	/**
	 * Re-select the given handles after an undo restored their anchors.
	 * Handles whose path or segment no longer exists are dropped.
	 */
	public restoreAnchorSelectionAfterUndo(
		handleKeys: string[],
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		let restored = false;
		for (const handleKey of handleKeys) {
			const [pathId, segmentIndexStr] = handleKey.split(":");
			const segmentIndex = Number.parseInt(segmentIndexStr, 10);
			const path = this.context.getPathById(pathId);
			if (!path || segmentIndex >= path.segments.length) continue;
			this.selectedPaths.set(pathId, path);
			this.cachedControlPoints.delete(pathId);
			this.selectedHandles.add(handleKey);
			restored = true;
		}
		if (!restored) return;
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
	}

	/**
	 * Select a handle. Superellipse-k handles have no independent selection
	 * state — clicking one selects the corresponding corner-radius instead.
	 */
	private selectHandleWithCompanion(handleKey: string): void {
		this.selectedHandles.add(this.canonicalHandleKey(handleKey));
	}

	/** Deselect a handle (canonicalized like selectHandleWithCompanion). */
	private deselectHandleWithCompanion(handleKey: string): void {
		this.selectedHandles.delete(this.canonicalHandleKey(handleKey));
	}

	/** Map superellipse-k keys to their corner-radius counterpart. */
	private canonicalHandleKey(handleKey: string): string {
		const parts = handleKey.split(":");
		if (parts.length === 3 && parts[2] === "corner-superellipse-k") {
			return `${parts[0]}:${parts[1]}:corner-radius`;
		}
		return handleKey;
	}

	private clearSelection(): void {
		this.selectedPaths.clear();
		this.selectedHandles.clear();
		this.pathAncestorTransforms.clear();
		this.updatePathEditOverlay(null);
	}

	private findHandleAtPoint(
		screenX: number,
		screenY: number,
		worldX: number,
		worldY: number,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): ControlPointHandle | null {
		// Selected paths' handles are hit-tested via the overlay channel,
		// read as-is: the caller refreshes it once per event.
		const hit = this.context.uiHitTest({ x: screenX, y: screenY });
		if (hit?.overlayKey === OVERLAY_KEYS.pathEditHandles) {
			const handle = this.resolveHandleHit(
				hit.hitId,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			if (handle) return handle;
		}

		// Unselected paths' anchors are not drawn in the overlay — keep the
		// geometric fallback (anchors only, nearest within 8px).
		return this.findUnselectedPathAnchor(worldX, worldY, viewport);
	}

	/** Map an overlay hit ("<pathId>:<segmentIndex>:<pointType>") back to the
	 *  ControlPointHandle of the corresponding selected path. */
	private resolveHandleHit(
		hitId: string,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): ControlPointHandle | null {
		const [pathId, segmentIndexStr, pointType] = hitId.split(":");
		const path = this.selectedPaths.get(pathId);
		if (!path) return null;
		const segmentIndex = Number(segmentIndexStr);
		return (
			this.extractControlPoints(path, viewport, canvasWidth, canvasHeight).find(
				(h) => h.segmentIndex === segmentIndex && h.pointType === pointType,
			) ?? null
		);
	}

	/** Anchors of unselected paths (to allow selecting vertices of any path). */
	private findUnselectedPathAnchor(
		worldX: number,
		worldY: number,
		viewport: Viewport,
	): ControlPointHandle | null {
		const toleranceWorld = 8 / viewport.zoom;
		const tolSq = toleranceWorld * toleranceWorld;

		let bestHandle: ControlPointHandle | null = null;
		let bestDistSq = Infinity;

		for (const {
			path,
			ancestorTransform,
		} of this.context.getAllEditablePaths()) {
			if (this.selectedPaths.has(path.id)) continue;
			const worldSegs = getWorldSegments(path, ancestorTransform ?? undefined);
			const isClosedPath = path.segments.at(-1)?.isClosed === true;
			for (let i = 0; i < path.segments.length; i++) {
				const seg = path.segments[i];
				const ws = worldSegs[i];
				// Start anchor (first segment of open path only)
				if (i === 0 && seg.start && !isClosedPath && ws.start) {
					const dx = worldX - ws.start.x;
					const dy = worldY - ws.start.y;
					const distSq = dx * dx + dy * dy;
					if (distSq <= tolSq && distSq < bestDistSq) {
						bestHandle = {
							type: "anchor",
							pathId: path.id,
							segmentIndex: i,
							pointType: "start",
							worldX: ws.start.x,
							worldY: ws.start.y,
							screenX: 0,
							screenY: 0,
							selected: false,
						};
						bestDistSq = distSq;
					}
				}
				// End anchor
				{
					const dx = worldX - ws.end.x;
					const dy = worldY - ws.end.y;
					const distSq = dx * dx + dy * dy;
					if (distSq <= tolSq && distSq < bestDistSq) {
						bestHandle = {
							type: "anchor",
							pathId: path.id,
							segmentIndex: i,
							pointType: "end",
							worldX: ws.end.x,
							worldY: ws.end.y,
							screenX: 0,
							screenY: 0,
							selected: false,
						};
						bestDistSq = distSq;
					}
				}
			}
		}

		return bestHandle;
	}

	/**
	 * Extract all control points from path segments
	 * Caches results to avoid repeated worldToScreen conversions
	 */
	private extractControlPoints(
		path: Path,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): ControlPointHandle[] {
		// Check if viewport changed (clear cache if so)
		if (this.viewportChanged(viewport)) {
			this.cachedControlPoints.clear();
			this.lastViewport = viewport;
		}

		// Return cached if available
		const cacheKey = path.id;
		const cached = this.cachedControlPoints.get(cacheKey);
		if (cached) {
			// Update selection state without recalculating coordinates
			return cached.map((handle) => ({
				...handle,
				selected: this.selectedHandles.has(this.getHandleKey(handle)),
			}));
		}

		// Calculate and cache
		const handles: ControlPointHandle[] = [];

		// Get world-space segments (with transform applied)
		const worldSegs = getWorldSegments(
			path,
			this.pathAncestorTransforms.get(path.id) ?? undefined,
		);
		const isClosedPath =
			path.segments[path.segments.length - 1]?.isClosed === true;

		for (let i = 0; i < path.segments.length; i++) {
			const segment = path.segments[i];
			const worldSeg = worldSegs[i];

			// Start point (only for first segment of open paths;
			// closed paths represent the same vertex as last segment's end)
			if (i === 0 && segment.start && !isClosedPath && worldSeg.start) {
				const ws = worldSeg.start;
				const screen = worldToScreen(
					ws.x,
					ws.y,
					viewport,
					canvasWidth,
					canvasHeight,
				);
				handles.push({
					type: "anchor",
					pathId: path.id,
					segmentIndex: i,
					pointType: "start",
					worldX: ws.x,
					worldY: ws.y,
					screenX: screen.x,
					screenY: screen.y,
					selected: this.selectedHandles.has(`${path.id}:${i}:start`),
				});
			}

			// Control point 1
			const cp1Screen = worldToScreen(
				worldSeg.cp1.x,
				worldSeg.cp1.y,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			handles.push({
				type: "control",
				pathId: path.id,
				segmentIndex: i,
				pointType: "cp1",
				worldX: worldSeg.cp1.x,
				worldY: worldSeg.cp1.y,
				screenX: cp1Screen.x,
				screenY: cp1Screen.y,
				selected: this.selectedHandles.has(`${path.id}:${i}:cp1`),
			});

			// Control point 2
			const cp2Screen = worldToScreen(
				worldSeg.cp2.x,
				worldSeg.cp2.y,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			handles.push({
				type: "control",
				pathId: path.id,
				segmentIndex: i,
				pointType: "cp2",
				worldX: worldSeg.cp2.x,
				worldY: worldSeg.cp2.y,
				screenX: cp2Screen.x,
				screenY: cp2Screen.y,
				selected: this.selectedHandles.has(`${path.id}:${i}:cp2`),
			});

			// End point
			const endScreen = worldToScreen(
				worldSeg.end.x,
				worldSeg.end.y,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			handles.push({
				type: "anchor",
				pathId: path.id,
				segmentIndex: i,
				pointType: "end",
				worldX: worldSeg.end.x,
				worldY: worldSeg.end.y,
				screenX: endScreen.x,
				screenY: endScreen.y,
				selected: this.selectedHandles.has(`${path.id}:${i}:end`),
			});
		}

		// Corner radius handles for eligible vertices
		for (let i = 0; i < path.segments.length; i++) {
			const seg = path.segments[i];
			const worldSeg = worldSegs[i];
			// Determine next segment (wrap around for closed paths)
			const isClosedPath =
				path.segments[path.segments.length - 1]?.isClosed === true;
			const isWrapped = i + 1 >= path.segments.length;
			const nextSeg =
				path.segments[i + 1] ?? (isClosedPath ? path.segments[0] : null);
			if (!nextSeg) continue;
			// Skip subpath boundaries, but allow closed path wrap-around
			if (nextSeg.isMoved && !isWrapped) continue;

			const nextWorldSeg =
				worldSegs[i + 1] ?? (isClosedPath ? worldSegs[0] : null);
			if (!nextWorldSeg) continue;

			// Calculate angle at vertex using world-space coordinates
			const vertex = worldSeg.end;

			// Incoming direction: cp2 is absolute in worldSeg, vertex = worldSeg.end
			let inDx = vertex.x - worldSeg.cp2.x;
			let inDy = vertex.y - worldSeg.cp2.y;
			if (inDx * inDx + inDy * inDy < 1e-12) {
				const segStart =
					worldSeg.start ?? (i > 0 ? worldSegs[i - 1].end : vertex);
				inDx = vertex.x - segStart.x;
				inDy = vertex.y - segStart.y;
			}
			const inLen = Math.sqrt(inDx * inDx + inDy * inDy);
			if (inLen < 1e-12) continue;
			inDx /= inLen;
			inDy /= inLen;

			// Outgoing direction: from vertex to nextSeg cp1 (absolute in world)
			let outDx = nextWorldSeg.cp1.x - vertex.x;
			let outDy = nextWorldSeg.cp1.y - vertex.y;
			if (outDx * outDx + outDy * outDy < 1e-12) {
				outDx = nextWorldSeg.end.x - vertex.x;
				outDy = nextWorldSeg.end.y - vertex.y;
			}
			const outLen = Math.sqrt(outDx * outDx + outDy * outDy);
			if (outLen < 1e-12) continue;
			outDx /= outLen;
			outDy /= outLen;

			// Angle between directions
			const dotProduct = inDx * outDx + inDy * outDy;
			const angle = Math.acos(Math.max(-1, Math.min(1, dotProduct)));
			if (angle >= (170 * Math.PI) / 180) continue; // Near-straight

			const radius = (seg as PathSegment).cornerRadius ?? 0;

			// Inner angle bisector: inDir points away from vertex, outDir points away from vertex.
			// Negate inDir so it points toward vertex, then add outDir.
			// (-inDir + outDir) bisects the inner angle.
			let bisX = outDx - inDx;
			let bisY = outDy - inDy;
			const bisLen = Math.sqrt(bisX * bisX + bisY * bisY);
			if (bisLen < 1e-12) continue;
			bisX /= bisLen;
			bisY /= bisLen;

			// Handle position: offset from vertex along inner bisector
			const minDisplayDistance = PathEditTool.CORNER_HANDLE_MIN_DISTANCE;
			const displayRadius = Math.max(radius, minDisplayDistance);
			const handleX = vertex.x + bisX * displayRadius;
			const handleY = vertex.y + bisY * displayRadius;

			const handleScreen = worldToScreen(
				handleX,
				handleY,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			handles.push({
				type: "corner-radius",
				pathId: path.id,
				segmentIndex: i,
				pointType: "corner-radius",
				worldX: handleX,
				worldY: handleY,
				screenX: handleScreen.x,
				screenY: handleScreen.y,
				selected: this.selectedHandles.has(`${path.id}:${i}:corner-radius`),
			});

			// K value handle (only when cornerRadius > 0).
			// Position encodes current k value: k=-1 (notch/innermost) .. k=10 (squircle/outermost)
			if (radius > 0) {
				const currentK = (seg as PathSegment).cornerSuperellipseN ?? 2;
				const kMaxDist = displayRadius * 0.85;
				const kMinDist = Math.max(displayRadius * 0.05, 2 / viewport.zoom);
				// Drag inward → notch/scoop/bevel (k→-1), drag outward → squircle (k→10)
				const t = Math.min(1, Math.max(0, (currentK + 1) / 11));
				const kDist = kMaxDist - t * (kMaxDist - kMinDist);
				const kHandleX = vertex.x + bisX * kDist;
				const kHandleY = vertex.y + bisY * kDist;
				const kHandleScreen = worldToScreen(
					kHandleX,
					kHandleY,
					viewport,
					canvasWidth,
					canvasHeight,
				);
				handles.push({
					type: "corner-superellipse-k",
					pathId: path.id,
					segmentIndex: i,
					pointType: "corner-superellipse-k",
					worldX: kHandleX,
					worldY: kHandleY,
					screenX: kHandleScreen.x,
					screenY: kHandleScreen.y,
					selected: this.selectedHandles.has(`${path.id}:${i}:corner-radius`),
				});
			}
		}

		// Cache the calculated handles
		this.cachedControlPoints.set(cacheKey, handles);

		return handles;
	}

	/**
	 * Check if viewport has changed significantly
	 */
	private viewportChanged(viewport: Viewport): boolean {
		if (!this.lastViewport) return true;

		return (
			this.lastViewport.x !== viewport.x ||
			this.lastViewport.y !== viewport.y ||
			this.lastViewport.zoom !== viewport.zoom
		);
	}

	/**
	 * Reset CPs around an anchor to {x:0, y:0} (linear).
	 * Used before Alt+anchor drag to start fresh CP creation.
	 */
	private resetAnchorCPs(
		path: Path,
		segmentIndex: number,
		pointType: "start" | "end",
	): Path {
		return {
			...path,
			segments: resetAnchorSegmentCPs(path.segments, segmentIndex, pointType),
		};
	}

	/**
	 * Alt+drag duplicate: clone every selected path as an independent element
	 * and retarget the tool's selection onto the copies so the ongoing face
	 * drag moves them. The originals are left untouched. Goes through
	 * `duplicateElements` (undo-aware) like SelectTool's alt-drag.
	 */
	private duplicateSelectedPathsForAltDrag(
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const sourceIds = [...this.selectedPaths.keys()];
		const newIds = this.context.duplicateElements(sourceIds);
		if (newIds.length === 0) return;

		this.selectedPaths.clear();
		this.selectedHandles.clear();
		this.pathAncestorTransforms.clear();
		this.cachedControlPoints.clear();

		let firstId: string | null = null;
		for (const newId of newIds) {
			const path = this.context.getPathById(newId);
			if (!path) continue;
			firstId ??= newId;
			this.selectedPaths.set(newId, path);
			this.pathAncestorTransforms.set(
				newId,
				this.context.getAncestorTransform(newId),
			);
			// Select all anchors of the copy, matching the "click a path's face
			// selects every vertex" convention.
			for (const h of this.extractControlPoints(
				path,
				viewport,
				canvasWidth,
				canvasHeight,
			)) {
				if (
					h.type === "corner-radius" ||
					(h.type === "anchor" &&
						(h.pointType === "start" || h.pointType === "end"))
				) {
					this.selectedHandles.add(this.getHandleKey(h));
				}
			}
		}

		if (firstId) this.context.pathSelect(firstId);
	}

	/** Delete a single anchor vertex from a path by handle key */
	private deleteSingleAnchor(handleKey: string): void {
		const [pathId, segIdxStr, pointType] = handleKey.split(":");
		const path = this.selectedPaths.get(pathId);
		if (!path) return;

		const result = deleteAnchorFromPath(
			path,
			Number(segIdxStr),
			pointType as "start" | "end",
		);
		if (result === null) return;

		// Undoing this deletion restores the anchor; stash it so it comes back
		// selected.
		this.context.stashPathEditUndoSelection([handleKey]);

		if (result === "erase") {
			// Not enough anchors for a valid path: erase the element
			this.context.eraseElement(pathId);
			this.selectedPaths.delete(pathId);
			this.cachedControlPoints.delete(pathId);
			this.selectedHandles.clear();
			return;
		}

		this.context.pathUpdate(pathId, result);

		const updatedPath = this.context.getPathById(pathId);
		if (updatedPath) {
			this.selectedPaths.set(pathId, updatedPath);
		}
		this.cachedControlPoints.delete(pathId);

		// Remove deleted handle from selection
		this.selectedHandles.delete(handleKey);
	}

	/**
	 * Determine at pointerDown time whether a CP handle should mirror its
	 * opposite handle during drag. Uses current segment geometry.
	 */
	private shouldMirrorHandle(path: Path, handle: ControlPointHandle): boolean {
		const seg = path.segments[handle.segmentIndex];
		const lastSeg = path.segments[path.segments.length - 1];
		const isClosedPath = lastSeg?.isClosed === true;

		if (handle.pointType === "cp1") {
			const prevSeg =
				handle.segmentIndex > 0
					? path.segments[handle.segmentIndex - 1]
					: isClosedPath
						? path.segments[path.segments.length - 1]
						: null;
			if (!prevSeg) return false;
			const anchor = getStartAnchor(seg, prevSeg?.end);
			const absCP1 = resolveCP1(seg.cp1, anchor);
			const absCP2 = resolveCP2(prevSeg.cp2, prevSeg.end);
			return this.areHandlesSymmetric(
				anchor.x,
				anchor.y,
				absCP1.x,
				absCP1.y,
				absCP2.x,
				absCP2.y,
			);
		}

		if (handle.pointType === "cp2") {
			const nextSeg =
				handle.segmentIndex < path.segments.length - 1
					? path.segments[handle.segmentIndex + 1]
					: isClosedPath
						? path.segments[0]
						: null;
			if (!nextSeg) return false;
			const absCP2 = resolveCP2(seg.cp2, seg.end);
			const nextAnchor = getStartAnchor(nextSeg, seg.end);
			const absNextCP1 = resolveCP1(nextSeg.cp1, nextAnchor);
			return this.areHandlesSymmetric(
				seg.end.x,
				seg.end.y,
				absCP2.x,
				absCP2.y,
				absNextCP1.x,
				absNextCP1.y,
			);
		}

		return false;
	}

	/**
	 * Check if two control points are approximately symmetric around an anchor.
	 * Returns true if angle difference is ~180° and distance ratio is ~1.
	 */
	private areHandlesSymmetric(
		anchorX: number,
		anchorY: number,
		cp1X: number,
		cp1Y: number,
		cp2X: number,
		cp2Y: number,
	): boolean {
		const dx1 = cp1X - anchorX;
		const dy1 = cp1Y - anchorY;
		const dx2 = cp2X - anchorX;
		const dy2 = cp2Y - anchorY;

		const dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
		const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

		// Both handles collapsed onto the anchor → not meaningful to mirror
		if (dist1 < 1e-6 && dist2 < 1e-6) return false;
		// One handle is collapsed → not symmetric
		if (dist1 < 1e-6 || dist2 < 1e-6) return false;

		// Distance ratio check (within 10%)
		const ratio = dist1 / dist2;
		if (ratio < 0.9 || ratio > 1.1) return false;

		// Angle difference check (should be ~π, tolerance ±5°)
		const angle1 = Math.atan2(dy1, dx1);
		const angle2 = Math.atan2(dy2, dx2);
		let angleDiff = Math.abs(angle1 - angle2);
		if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

		const tolerance = (5 * Math.PI) / 180; // 5 degrees
		return Math.abs(angleDiff - Math.PI) < tolerance;
	}

	/**
	 * Update a control point and return new segments.
	 * Mirror behavior for cp1/cp2 is determined by state.mirrorFlags (set at pointerDown)
	 * unless breakTangent is true (Alt key), which forces independent movement.
	 */

	/** @returns true if a face was subdivided */

	private updateControlPoint(
		state: Extract<DragState, { mode: "controlPointDrag" }>,
		segments: CubicBezierSegment[],
		handle: ControlPointHandle,
		newX: number,
		newY: number,
		breakTangent = false,
	): CubicBezierSegment[] {
		// newX/newY are world-space coordinates.
		// Compute inverseTransform helper to convert world→local for writing back to segments.
		const path = this.selectedPaths.get(handle.pathId);
		const ancestorT = this.pathAncestorTransforms.get(handle.pathId) ?? null;
		const toLocal = (wx: number, wy: number): { x: number; y: number } => {
			if (!path) return { x: wx, y: wy };
			const t = getTransform(path);
			const composedT = ancestorT ? composeTransforms(ancestorT, t) : t;
			if (isIdentityTransform(composedT)) return { x: wx, y: wy };
			const localBounds = calculatePathBounds(path);
			const origin = computeTransformOrigin(localBounds);
			return inverseTransform(wx, wy, composedT, origin.x, origin.y);
		};

		// World-space segments for angle/distance mirror calculations
		const worldSegs = path
			? getWorldSegments(path, ancestorT ?? undefined)
			: null;

		// Use structured clone instead of JSON.stringify for better performance
		const newSegments: CubicBezierSegment[] = segments.map((seg) => ({
			...seg,
			start: seg.start ? { ...seg.start } : undefined,
			cp1: { ...seg.cp1 },
			cp2: { ...seg.cp2 },
			end: { ...seg.end },
		}));
		const segment = newSegments[handle.segmentIndex];
		const lastSeg = newSegments[newSegments.length - 1];
		const isClosedPath = lastSeg?.isClosed === true;
		const prevSegment =
			handle.segmentIndex > 0
				? newSegments[handle.segmentIndex - 1]
				: isClosedPath
					? newSegments[newSegments.length - 1]
					: undefined;
		const nextSegment =
			handle.segmentIndex < newSegments.length - 1
				? newSegments[handle.segmentIndex + 1]
				: isClosedPath
					? newSegments[0]
					: undefined;

		const newLocalPoint = toLocal(newX, newY);

		switch (handle.pointType) {
			case "start": {
				if (segment.start) {
					segment.start = newLocalPoint;
					if (prevSegment) {
						prevSegment.end = newLocalPoint;
					}
				}
				break;
			}
			case "cp1": {
				const startAnchor = getStartAnchor(segment, prevSegment?.end);
				segment.cp1 = toRelativeCP1(newLocalPoint, startAnchor);

				if (prevSegment && !breakTangent) {
					const mirrorFlag = state.mirrorFlags.get(this.getHandleKey(handle));
					if (mirrorFlag === true) {
						// Mirror cp2 of prevSegment in world space
						const worldSeg = worldSegs?.[handle.segmentIndex];
						const prevWorldSeg =
							worldSegs?.[
								handle.segmentIndex > 0
									? handle.segmentIndex - 1
									: worldSegs.length - 1
							];
						if (worldSeg && prevWorldSeg) {
							const anchorWorld = worldSeg.start ?? prevWorldSeg.end;
							const anchorWX = anchorWorld.x;
							const anchorWY = anchorWorld.y;

							// Old cp1 world position (from handle's recorded world coords)
							const oldCp1Handle = state.startPositions.get(
								this.getHandleKey(handle),
							);
							const oldCp1WX = oldCp1Handle?.x ?? worldSeg.cp1.x;
							const oldCp1WY = oldCp1Handle?.y ?? worldSeg.cp1.y;

							const oldAngle = Math.atan2(
								oldCp1WY - anchorWY,
								oldCp1WX - anchorWX,
							);
							const oldDist = Math.sqrt(
								(oldCp1WX - anchorWX) ** 2 + (oldCp1WY - anchorWY) ** 2,
							);
							const newAngle = Math.atan2(newY - anchorWY, newX - anchorWX);
							const newDist = Math.sqrt(
								(newX - anchorWX) ** 2 + (newY - anchorWY) ** 2,
							);

							const angleChange = newAngle - oldAngle;
							const distanceRatio = oldDist > 0 ? newDist / oldDist : 1;

							// Use original position from drag start to avoid exponential drift
							const mirrorSource = state.mirrorSources.get(
								this.getHandleKey(handle),
							);
							const cp2World = mirrorSource ?? prevWorldSeg.cp2;
							const cp2Angle = Math.atan2(
								cp2World.y - anchorWY,
								cp2World.x - anchorWX,
							);
							const cp2Dist = Math.sqrt(
								(cp2World.x - anchorWX) ** 2 + (cp2World.y - anchorWY) ** 2,
							);
							const newCp2WX =
								anchorWX +
								Math.cos(cp2Angle + angleChange) * cp2Dist * distanceRatio;
							const newCp2WY =
								anchorWY +
								Math.sin(cp2Angle + angleChange) * cp2Dist * distanceRatio;

							prevSegment.cp2 = toRelativeCP2(
								toLocal(newCp2WX, newCp2WY),
								prevSegment.end,
							);
						}
					}
				}
				break;
			}
			case "cp2": {
				segment.cp2 = toRelativeCP2(newLocalPoint, segment.end);

				if (nextSegment && !breakTangent) {
					const mirrorFlag = state.mirrorFlags.get(this.getHandleKey(handle));
					if (mirrorFlag === true) {
						// Mirror cp1 of nextSegment in world space
						const worldSeg = worldSegs?.[handle.segmentIndex];
						const nextWorldSeg =
							worldSegs?.[
								handle.segmentIndex < (worldSegs?.length ?? 0) - 1
									? handle.segmentIndex + 1
									: 0
							];
						if (worldSeg && nextWorldSeg) {
							const anchorWX = worldSeg.end.x;
							const anchorWY = worldSeg.end.y;

							// Old cp2 world position (from handle's recorded world coords)
							const oldCp2Handle = state.startPositions.get(
								this.getHandleKey(handle),
							);
							const oldCp2WX = oldCp2Handle?.x ?? worldSeg.cp2.x;
							const oldCp2WY = oldCp2Handle?.y ?? worldSeg.cp2.y;

							const oldAngle = Math.atan2(
								oldCp2WY - anchorWY,
								oldCp2WX - anchorWX,
							);
							const oldDist = Math.sqrt(
								(oldCp2WX - anchorWX) ** 2 + (oldCp2WY - anchorWY) ** 2,
							);
							const newAngle = Math.atan2(newY - anchorWY, newX - anchorWX);
							const newDist = Math.sqrt(
								(newX - anchorWX) ** 2 + (newY - anchorWY) ** 2,
							);

							const angleChange = newAngle - oldAngle;
							const distanceRatio = oldDist > 0 ? newDist / oldDist : 1;

							// Use original position from drag start to avoid exponential drift
							const mirrorSource = state.mirrorSources.get(
								this.getHandleKey(handle),
							);
							const cp1World = mirrorSource ?? nextWorldSeg.cp1;
							const cp1Angle = Math.atan2(
								cp1World.y - anchorWY,
								cp1World.x - anchorWX,
							);
							const cp1Dist = Math.sqrt(
								(cp1World.x - anchorWX) ** 2 + (cp1World.y - anchorWY) ** 2,
							);
							const newCp1WX =
								anchorWX +
								Math.cos(cp1Angle + angleChange) * cp1Dist * distanceRatio;
							const newCp1WY =
								anchorWY +
								Math.sin(cp1Angle + angleChange) * cp1Dist * distanceRatio;

							const nextAnchorLocal = getStartAnchor(nextSegment, segment.end);
							nextSegment.cp1 = toRelativeCP1(
								toLocal(newCp1WX, newCp1WY),
								nextAnchorLocal,
							);
						}
					}
				}
				break;
			}
			case "end": {
				segment.end = newLocalPoint;

				const nextSeg =
					handle.segmentIndex < newSegments.length - 1
						? newSegments[handle.segmentIndex + 1]
						: isClosedPath
							? newSegments[0]
							: undefined;

				if (nextSeg?.start) {
					nextSeg.start = newLocalPoint;
				}
				break;
			}
		}

		return newSegments;
	}

	/**
	 * Handle corner radius drag: compute delta from the primary dragged handle's
	 * bisector projection and apply the same delta to all selected handles.
	 */
	private handleCornerRadiusDrag(
		state: Extract<DragState, { mode: "cornerRadiusDrag" }>,
		path: Path,
		handles: ControlPointHandle[],
		screenX: number,
		screenY: number,
		zoom: number,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): PathSegment[] {
		const newSegments = path.segments.map((seg) => ({ ...seg }));
		const crHandles = handles.filter((h) => h.pointType === "corner-radius");
		if (crHandles.length === 0) return newSegments as PathSegment[];

		// Use world-space segments for bisector calculation (consistent with extractControlPoints)
		const worldSegs = getWorldSegments(
			path,
			this.pathAncestorTransforms.get(path.id) ?? undefined,
		);

		// Use the handle the user actually clicked as primary
		const primary =
			crHandles.find((h) => this.getHandleKey(h) === state.primaryHandleKey) ??
			crHandles[0];
		const primaryDelta = this.computeCornerRadiusDelta(
			state,
			worldSegs,
			primary,
			screenX,
			screenY,
			zoom,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		if (primaryDelta === null) return newSegments as PathSegment[];

		// Apply same delta to all selected corner-radius handles
		for (const handle of crHandles) {
			const key = this.getHandleKey(handle);
			const startRadius = state.startRadii.get(key) ?? 0;
			const newRadius = Math.max(0, startRadius + primaryDelta);

			const seg = newSegments[handle.segmentIndex];
			const vertex = seg.end;
			const nextSeg = newSegments[handle.segmentIndex + 1] ?? newSegments[0];

			// Clamp to half of adjacent segment chord lengths
			const segStart =
				seg.start ??
				(handle.segmentIndex > 0
					? newSegments[handle.segmentIndex - 1].end
					: vertex);
			const inChord = Math.sqrt(
				(vertex.x - segStart.x) ** 2 + (vertex.y - segStart.y) ** 2,
			);
			const outChord = Math.sqrt(
				(nextSeg.end.x - vertex.x) ** 2 + (nextSeg.end.y - vertex.y) ** 2,
			);
			const maxRadius = Math.min(inChord / 2, outChord / 2);

			(seg as PathSegment).cornerRadius = Math.min(newRadius, maxRadius);
		}

		return newSegments as PathSegment[];
	}

	/**
	 * Compute the corner radius delta for a single handle by projecting
	 * the screen-space drag movement onto the inner bisector at the vertex.
	 * Returns the delta from startRadius, or null if computation fails.
	 */
	private computeCornerRadiusDelta(
		state: Extract<DragState, { mode: "cornerRadiusDrag" }>,
		worldSegs: WorldBezierSegment[],
		handle: ControlPointHandle,
		screenX: number,
		screenY: number,
		_zoom: number,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): number | null {
		const ws = worldSegs[handle.segmentIndex];
		const vertex = ws.end;

		// Incoming direction from world-space segments (cp2 is absolute in world segs)
		let inDx = vertex.x - ws.cp2.x;
		let inDy = vertex.y - ws.cp2.y;
		if (inDx * inDx + inDy * inDy < 1e-12) {
			const segStart =
				ws.start ??
				(handle.segmentIndex > 0
					? worldSegs[handle.segmentIndex - 1].end
					: vertex);
			inDx = vertex.x - segStart.x;
			inDy = vertex.y - segStart.y;
		}
		const inLen = Math.sqrt(inDx * inDx + inDy * inDy);
		if (inLen < 1e-12) return null;
		inDx /= inLen;
		inDy /= inLen;

		// Outgoing direction from world-space segments (cp1 is absolute in world segs)
		const nextWs = worldSegs[handle.segmentIndex + 1] ?? worldSegs[0];
		let outDx = nextWs.cp1.x - vertex.x;
		let outDy = nextWs.cp1.y - vertex.y;
		if (outDx * outDx + outDy * outDy < 1e-12) {
			outDx = nextWs.end.x - vertex.x;
			outDy = nextWs.end.y - vertex.y;
		}
		const outLen = Math.sqrt(outDx * outDx + outDy * outDy);
		if (outLen < 1e-12) return null;
		outDx /= outLen;
		outDy /= outLen;

		// Inner angle bisector in world space: (-inDir + outDir)
		let bisX = outDx - inDx;
		let bisY = outDy - inDy;
		const bisLen = Math.sqrt(bisX * bisX + bisY * bisY);
		if (bisLen < 1e-12) return null;
		bisX /= bisLen;
		bisY /= bisLen;

		// Convert bisector to screen space via worldToScreen (handles viewport rotation)
		const vertexScreen = worldToScreen(
			vertex.x,
			vertex.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const bisEndScreen = worldToScreen(
			vertex.x + bisX,
			vertex.y + bisY,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		let bisScreenX = bisEndScreen.x - vertexScreen.x;
		let bisScreenY = bisEndScreen.y - vertexScreen.y;
		const bisScreenLen = Math.sqrt(
			bisScreenX * bisScreenX + bisScreenY * bisScreenY,
		);
		if (bisScreenLen < 1e-12) return null;
		bisScreenX /= bisScreenLen;
		bisScreenY /= bisScreenLen;

		// Screen-space drag delta from drag start position
		const dx = screenX - state.startScreenX;
		const dy = screenY - state.startScreenY;

		// Project screen drag onto screen-space bisector (pixels),
		// then divide by bisScreenLen to convert back to world units.
		// bisScreenLen ≈ zoom (1 world unit → zoom screen pixels),
		// so this is equivalent to screenProjection / zoom at rotation=0.
		return (dx * bisScreenX + dy * bisScreenY) / bisScreenLen;
	}

	/**
	 * Update cornerSuperellipseK for dragged corner-superellipse-k handles.
	 * Pointer projected onto the inner bisector maps directly to k value:
	 * at kMaxDist from vertex → k=2 (circular); at kMinDist → k=10 (squircle).
	 */
	private handleSuperellipseKDrag(
		state: Extract<DragState, { mode: "superellipseKDrag" }>,
		path: Path,
		handles: ControlPointHandle[],
		worldX: number,
		worldY: number,
		zoom: number,
	): PathSegment[] {
		const newSegments = path.segments.map((seg) => ({ ...seg }));
		const kHandles = handles.filter(
			(h) => h.pointType === "corner-superellipse-k",
		);
		if (kHandles.length === 0) return newSegments as PathSegment[];

		// Use world-space segments for bisector calculation (consistent with extractControlPoints)
		const worldSegs = getWorldSegments(
			path,
			this.pathAncestorTransforms.get(path.id) ?? undefined,
		);

		const primary =
			kHandles.find((h) => this.getHandleKey(h) === state.primaryHandleKey) ??
			kHandles[0];
		const primaryKey = this.getHandleKey(primary);
		const primaryStartK = state.startSuperellipseKs.get(primaryKey) ?? 2;
		const primaryNewK = this.computeSuperellipseK(
			worldSegs,
			newSegments,
			primary,
			worldX,
			worldY,
			zoom,
		);
		if (primaryNewK === null) return newSegments as PathSegment[];
		const primaryDelta = primaryNewK - primaryStartK;

		for (const handle of kHandles) {
			const key = this.getHandleKey(handle);
			const startK = state.startSuperellipseKs.get(key) ?? 2;
			const newK = Math.min(10, Math.max(-1, startK + primaryDelta));
			(newSegments[handle.segmentIndex] as PathSegment).cornerSuperellipseN =
				newK;
		}

		return newSegments as PathSegment[];
	}

	/**
	 * Compute k value from pointer position projected onto the inner bisector.
	 * k=2 when projection equals kMaxDist; k=10 when projection equals kMinDist.
	 */
	private computeSuperellipseK(
		worldSegs: WorldBezierSegment[],
		localSegs: CubicBezierSegment[],
		handle: ControlPointHandle,
		worldX: number,
		worldY: number,
		zoom: number,
	): number | null {
		const seg = worldSegs[handle.segmentIndex];
		const vertex = seg.end;
		const cornerRadius =
			(localSegs[handle.segmentIndex] as PathSegment).cornerRadius ?? 0;
		if (cornerRadius <= 0) return null;

		// Use world-space absolute coordinates (same as extractControlPoints)
		let inDx = vertex.x - seg.cp2.x;
		let inDy = vertex.y - seg.cp2.y;
		if (inDx * inDx + inDy * inDy < 1e-12) {
			const segStart =
				seg.start ??
				(handle.segmentIndex > 0
					? worldSegs[handle.segmentIndex - 1].end
					: vertex);
			inDx = vertex.x - segStart.x;
			inDy = vertex.y - segStart.y;
		}
		const inLen = Math.sqrt(inDx * inDx + inDy * inDy);
		if (inLen < 1e-12) return null;
		inDx /= inLen;
		inDy /= inLen;

		const nextSeg = worldSegs[handle.segmentIndex + 1] ?? worldSegs[0];
		let outDx = nextSeg.cp1.x - vertex.x;
		let outDy = nextSeg.cp1.y - vertex.y;
		if (outDx * outDx + outDy * outDy < 1e-12) {
			outDx = nextSeg.end.x - vertex.x;
			outDy = nextSeg.end.y - vertex.y;
		}
		const outLen = Math.sqrt(outDx * outDx + outDy * outDy);
		if (outLen < 1e-12) return null;
		outDx /= outLen;
		outDy /= outLen;

		let bisX = outDx - inDx;
		let bisY = outDy - inDy;
		const bisLen = Math.sqrt(bisX * bisX + bisY * bisY);
		if (bisLen < 1e-12) return null;
		bisX /= bisLen;
		bisY /= bisLen;

		const projection = (worldX - vertex.x) * bisX + (worldY - vertex.y) * bisY;

		const minDisplayDistance = 15 / zoom;
		const displayRadius = Math.max(cornerRadius, minDisplayDistance);
		const kMaxDist = displayRadius * 0.85;
		const kMinDist = Math.max(displayRadius * 0.05, 2 / zoom);
		const clamped = Math.min(kMaxDist, Math.max(kMinDist, projection));
		// innermost (kMaxDist, away from vertex) → k=-1 (notch), outermost (kMinDist, near vertex) → k=10 (squircle)
		const t = (kMaxDist - clamped) / Math.max(1e-9, kMaxDist - kMinDist);
		const raw = -1 + t * 11;
		// Snap to default (k=2) within 4 screen-px deadzone
		const kRange = 11; // total k span: -1 to 10
		const worldRange = Math.max(1e-9, kMaxDist - kMinDist);
		const snapThreshold = (4 / zoom / worldRange) * kRange;
		return Math.abs(raw - 2) < snapThreshold ? 2 : raw;
	}

	public refreshUI(): void {
		const vp = this.context.getViewport();
		if (!vp) return;

		// Re-fetch selected paths from document so undo/redo changes are reflected
		for (const pathId of this.selectedPaths.keys()) {
			const latest = this.context.getPathById(pathId);
			if (latest) {
				this.selectedPaths.set(pathId, latest);
			} else {
				this.selectedPaths.delete(pathId);
				this.pathAncestorTransforms.delete(pathId);
			}
		}
		for (const meshId of this.selectedMeshes.keys()) {
			const latest = this.context.getElement(meshId);
			if (latest && isMesh(latest)) {
				this.selectedMeshes.set(meshId, latest);
			} else {
				this.selectedMeshes.delete(meshId);
				this.meshAncestorTransforms.delete(meshId);
				for (const key of this.selectedMeshVertices) {
					if (parseMeshVertexKey(key).meshId === meshId) {
						this.selectedMeshVertices.delete(key);
					}
				}
			}
		}
		this.cachedControlPoints.clear();

		this.updatePathEditUI(vp.viewport, vp.canvasWidth, vp.canvasHeight);
	}

	private updateMarqueeOverlay(marquee: MarqueeSelectionUIData | null): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.pathEditMarquee,
			marquee
				? {
						zIndex: OVERLAY_Z.marquee,
						primitives: buildMarqueeOverlay(marquee, UI_THEME),
					}
				: null,
		);
	}

	private updatePathEditOverlay(data: PathEditUIData | null): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.pathEditHandles,
			data
				? {
						zIndex: OVERLAY_Z.pathEdit,
						primitives: buildPathEditOverlay(data, UI_THEME),
					}
				: null,
		);
	}

	private updatePathEditUI(
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const hasLasso = this.dragState.mode === "lasso";

		if (
			this.selectedPaths.size === 0 &&
			this.selectedMeshes.size === 0 &&
			!hasLasso
		) {
			this.updatePathEditOverlay(null);
			return;
		}

		const paths = Array.from(this.selectedPaths.values()).map((path) => ({
			pathId: path.id,
			controlPoints: this.extractControlPoints(
				path,
				viewport,
				canvasWidth,
				canvasHeight,
			),
			segments: getWorldSegments(
				path,
				this.pathAncestorTransforms.get(path.id) ?? undefined,
			).map((worldSeg) => ({
				start: worldSeg.start
					? { x: worldSeg.start.x, y: worldSeg.start.y }
					: undefined,
				cp1: { x: worldSeg.cp1.x, y: worldSeg.cp1.y },
				cp2: { x: worldSeg.cp2.x, y: worldSeg.cp2.y },
				end: { x: worldSeg.end.x, y: worldSeg.end.y },
			})),
		}));

		const additionalOutlines = this.collectBlendOutlinesForSelection();
		const meshCages = this.buildMeshCageUIData();

		this.updatePathEditOverlay({
			paths,
			meshCages: meshCages.length > 0 ? meshCages : undefined,
			additionalOutlines:
				additionalOutlines.length > 0 ? additionalOutlines : undefined,
			longPressRing: this.longPressRing ?? undefined,
			// Copy: the overlay sink freezes this array in dev builds, but
			// dragState.path keeps growing via push() on every pointer move.
			lassoPath:
				this.dragState.mode === "lasso" ? [...this.dragState.path] : undefined,
		});

		// Publish selected anchor info for ActionsPanel
		const selectedAnchors: Array<{
			pathId: string;
			segmentIndex: number;
			pointType: "start" | "end";
			isEndpoint: boolean;
		}> = [];

		for (const handleKey of this.selectedHandles) {
			const [pathId, segmentIndexStr, pointType] = handleKey.split(":");
			if (pointType !== "start" && pointType !== "end") continue;
			const segmentIndex = Number.parseInt(segmentIndexStr, 10);
			const path = this.selectedPaths.get(pathId);
			if (!path) continue;

			// A closed path already links its last end back to its first start,
			// so neither counts as an endpoint that could be joined.
			const isEndpoint =
				!path.segments.at(-1)?.isClosed &&
				((segmentIndex === 0 && pointType === "start") ||
					(segmentIndex === path.segments.length - 1 && pointType === "end"));

			selectedAnchors.push({
				pathId,
				segmentIndex,
				pointType: pointType as "start" | "end",
				isEndpoint,
			});
		}

		this.context.pathEditUpdateSelectedAnchors(selectedAnchors);
	}

	/**
	 * When editing paths that belong to a blend (a key object or its spine),
	 * collect that blend's key + spine outlines so the spine is visible as
	 * non-editable context while editing inside the blend.
	 */
	private collectBlendOutlinesForSelection(): WorldBezierSegment[][] {
		const editedIds = new Set(this.selectedPaths.keys());
		if (editedIds.size === 0) return [];

		const result: WorldBezierSegment[][] = [];
		const seen = new Set<string>();
		for (const obj of Object.values(this.context.getObjects())) {
			if (!isBlend(obj) || seen.has(obj.id)) continue;
			const belongs =
				obj.objectIds.some((id) => editedIds.has(id)) ||
				(obj.spineSourceId != null && editedIds.has(obj.spineSourceId));
			if (!belongs) continue;
			seen.add(obj.id);
			for (const outline of blendKeyOutlines(
				obj,
				(id) => this.context.getElement(id) ?? undefined,
				(id) => this.context.getAncestorTransform(id),
			)) {
				result.push(outline);
			}
		}
		return result;
	}

	/**
	 * Pick up a whole element that has no editable vertices of its own (image,
	 * mesh container, …) so it can be selected and dragged from this tool, the
	 * way a direct-selection tool does. Paths keep their anchor-level handling.
	 *
	 * @returns true when an element was picked up.
	 */
	private selectWholeElementAt(
		world: { x: number; y: number },
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		const element = this.context.findElementAtPoint(
			world.x,
			world.y,
			PathEditTool.HIT_TOLERANCE_SCREEN_PX / viewport.zoom,
		);
		if (!element || isPath(element)) return false;
		// A cage already in this session keeps the marquee, so vertices inside it
		// stay selectable by dragging over them.
		if (isMesh(element) && this.selectedMeshes.has(element.id)) return false;
		if (this.context.isElementLocked(element.id)) return false;
		const bounds = this.context.getBounds(element.id);
		if (!bounds) return false;

		this.selectedPaths.clear();
		this.selectedHandles.clear();
		this.pathAncestorTransforms.clear();
		this.selectedMeshVertices.clear();
		this.selectedMeshes.clear();
		this.meshAncestorTransforms.clear();
		if (isMesh(element)) {
			// Hand the cage over for editing, same as a carried-over selection.
			this.selectedMeshes.set(element.id, element);
			this.meshAncestorTransforms.set(
				element.id,
				this.context.getAncestorTransform(element.id),
			);
		}
		this.context.elementSelect(element.id, bounds);

		const layerId = this.context.getCurrentLayerId();
		this.dragState = layerId
			? {
					mode: "elementDrag",
					elementId: element.id,
					layerId,
					startX: world.x,
					startY: world.y,
					originTransform: getTransform(element),
					hasMoved: false,
				}
			: { mode: "idle" };

		this.context.uiRefreshSelectionUI(false);
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		return true;
	}

	// ── Mesh warp cage editing ────────────────────────────────────────────

	/** Replace the cage-vertex selection with a single vertex. */
	private selectOnlyMeshVertex(meshId: string, vertexIndex: number): void {
		this.selectedMeshVertices.clear();
		this.selectedMeshVertices.add(meshVertexKey(meshId, vertexIndex));
	}

	/** Selected vertex indices of one mesh, ascending. */
	private selectedVertexIndicesOf(meshId: string): number[] {
		const indices: number[] = [];
		for (const key of this.selectedMeshVertices) {
			const parsed = parseMeshVertexKey(key);
			if (parsed.meshId === meshId) indices.push(parsed.vertexIndex);
		}
		return indices.sort((a, b) => a - b);
	}

	/** Add every visible cage vertex whose world position passes `contains`. */
	private selectMeshVerticesWhere(
		contains: (world: { x: number; y: number }) => boolean,
	): void {
		for (const mesh of this.selectedMeshes.values()) {
			mesh.vertices.forEach((vertex, vi) => {
				if (vertex.hidden) return;
				if (!contains(this.meshLocalToWorld(mesh, vertex))) return;
				this.selectedMeshVertices.add(meshVertexKey(mesh.id, vi));
			});
		}
	}

	/** Selected vertex indices grouped per mesh. */
	private selectedVertexIndicesByMesh(): Map<string, number[]> {
		const byMesh = new Map<string, number[]>();
		for (const key of this.selectedMeshVertices) {
			const { meshId, vertexIndex } = parseMeshVertexKey(key);
			const indices = byMesh.get(meshId);
			if (indices) indices.push(vertexIndex);
			else byMesh.set(meshId, [vertexIndex]);
		}
		return byMesh;
	}

	/** Reads the overlay as-is: the caller refreshes it once per event. */
	private findMeshHandleAtPoint(
		screenX: number,
		screenY: number,
	):
		| { meshId: string; kind: "vertex"; vertexIndex: number }
		| {
				meshId: string;
				kind: "cp";
				vertexIndex: number;
				neighborIndex: number;
		  }
		| null {
		if (this.selectedMeshes.size === 0) return null;
		const hit = this.context.uiHitTest({ x: screenX, y: screenY });
		if (hit?.overlayKey !== OVERLAY_KEYS.pathEditHandles) return null;
		if (hit.hitId.startsWith("meshv:")) {
			const [, meshId, vi] = hit.hitId.split(":");
			return { meshId, kind: "vertex", vertexIndex: Number.parseInt(vi, 10) };
		}
		if (hit.hitId.startsWith("meshcp:")) {
			const [, meshId, vi, ni] = hit.hitId.split(":");
			return {
				meshId,
				kind: "cp",
				vertexIndex: Number.parseInt(vi, 10),
				neighborIndex: Number.parseInt(ni, 10),
			};
		}
		return null;
	}

	private handleMeshDragMove(
		ds: Extract<DragState, { mode: "meshVertexDrag" | "meshCpDrag" }>,
		world: { x: number; y: number },
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const stored = this.selectedMeshes.get(ds.meshId);
		if (!stored) return;
		const local = this.meshWorldToLocal(stored, world);
		const draft = ds.draft;
		// Snapshot for the cross-handle rotation below: it needs the cage as it
		// was before this frame's edit.
		const previousVertices = draft.vertices.map((vertex) => ({
			...vertex,
			handles: { ...vertex.handles },
		}));

		if (ds.mode === "meshVertexDrag") {
			// One shared delta measured from where the pointer grabbed, not from
			// the vertex: a click that lands a few px off the vertex (the hit
			// tolerance) must not teleport it onto the cursor.
			const deltaX = local.x - ds.startX;
			const deltaY = local.y - ds.startY;
			if (
				!ds.hasMoved &&
				Math.hypot(deltaX, deltaY) * viewport.zoom <
					PathEditTool.DRAG_THRESHOLD_SCREEN_PX
			) {
				// Pointer jitter during a click is not a drag.
				return;
			}
			for (const origin of ds.origins) {
				this.moveDraftVertex(
					draft,
					origin.index,
					origin.x + deltaX,
					origin.y + deltaY,
				);
			}
		} else {
			writeMeshCPHandle(
				draft.vertices,
				draft.faces,
				ds.vertexIndex,
				ds.neighborIndex,
				local,
			);
		}

		// Cage edits can shift positions derived vertices reference.
		// `src` stays untouched throughout: the warp parametrization survives.
		syncDerivedVertices(draft.vertices, draft.faces);
		// Split lines leaving a moved edge turn with it, so bending a boundary
		// handle bends the interior instead of creasing at the cut.
		rotateDerivedCrossHandles(previousVertices, draft.vertices, draft.faces);
		ds.hasMoved = true;

		const layerId = this.context.getCurrentLayerId();
		if (layerId) {
			this.context.previewDeformation([
				{
					elementId: draft.id,
					layerId,
					updates: { vertices: draft.vertices, faces: draft.faces },
				},
			]);
		}
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
	}

	/**
	 * Move one draft cage vertex (and its handles) to a mesh-local target.
	 * Edge-derived vertices are projected back onto their owning root segment
	 * and re-parametrized, so they keep tracking the edge they belong to.
	 */
	private moveDraftVertex(
		draft: MeshArtObject,
		vertexIndex: number,
		targetX: number,
		targetY: number,
	): void {
		slideMeshVertex(draft.vertices, draft.faces, vertexIndex, targetX, targetY);
	}

	/**
	 * Alt-drag fan: rebuild the vertex's CP handles from the vertex outwards in
	 * mesh-local space, at the pointer's distance. An explicit vertex keeps its
	 * handles on their neighbors and turns the fan with the pointer; a derived
	 * one lines them up with the pointer so sliding it never kinks the curve.
	 */
	private handleMeshFanMove(
		ds: Extract<DragState, { mode: "meshFanDrag" }>,
		world: { x: number; y: number },
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const stored = this.selectedMeshes.get(ds.meshId);
		if (!stored) return;
		const local = this.meshWorldToLocal(stored, world);
		const draft = ds.draft;
		const vertex = draft.vertices[ds.vertexIndex];
		if (!vertex) return;

		if (!applyMeshHandleFan(ds.fan, vertex, local, viewport.zoom)) return;

		syncDerivedVertices(draft.vertices, draft.faces);
		ds.hasMoved = true;

		const layerId = this.context.getCurrentLayerId();
		if (layerId) {
			this.context.previewDeformation([
				{
					elementId: draft.id,
					layerId,
					updates: { vertices: draft.vertices, faces: draft.faces },
				},
			]);
		}
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
	}

	/** @returns true when a cage edge near `world` gained a new vertex. */
	private splitMeshEdgeAt(
		world: { x: number; y: number },
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		const layerId = this.context.getCurrentLayerId();
		if (!layerId) return false;
		for (const mesh of this.selectedMeshes.values()) {
			if (this.context.isElementLocked(mesh.id)) continue;
			const local = this.meshWorldToLocal(mesh, world);

			// Closest cage edge within tolerance, measured in screen px.
			const best = findClosestMeshEdgePoint(
				mesh.vertices,
				mesh.faces,
				local,
				(onEdge) => {
					const pw = this.meshLocalToWorld(mesh, onEdge);
					return Math.hypot(pw.x - world.x, pw.y - world.y) * viewport.zoom;
				},
			);
			if (!best || best.dist > PathEditTool.MESH_EDGE_SPLIT_TOLERANCE_PX) {
				continue;
			}

			// Map the edge parameter to the face's logical axis: edges 0/2 run
			// along u (t = u / 1-u), edges 1/3 along v. The other coordinate is
			// pinned to the clicked edge so the cut inserts the vertex there.
			const value = best.edgeIdx <= 1 ? best.t : 1 - best.t;
			const isU = best.edgeIdx % 2 === 0;
			const clickU = isU ? value : best.edgeIdx === 1 ? 1 : 0;
			const clickV = isU ? (best.edgeIdx === 0 ? 0 : 1) : value;
			const result = subdivideWarpFace(
				mesh.vertices,
				mesh.faces,
				best.faceIdx,
				clickU,
				clickV,
				isU ? { u: true } : { v: true },
			);
			if (!result) return false;
			syncDerivedVertices(result.vertices, result.faces);
			// The vertex the user placed is theirs to move: it holds its own
			// position instead of riding the edge it was cut on. The one the cut
			// left on the far side stays derived. Promoting materializes the
			// effective curves first, so the cage keeps its shape.
			const vertices =
				promoteWarpVertexToExplicit(
					result.vertices,
					result.faces,
					result.centerIdx,
				) ?? result.vertices;
			this.context.applyDeformation([
				{
					elementId: mesh.id,
					layerId,
					updates: { vertices, faces: result.faces },
				},
			]);
			this.selectedMeshes.set(mesh.id, {
				...mesh,
				vertices,
				faces: result.faces,
			});
			this.selectOnlyMeshVertex(mesh.id, result.centerIdx);
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
			return true;
		}
		return false;
	}

	/** @returns true when a selected mesh face was subdivided at `world`. */
	private subdivideMeshFaceAt(
		world: { x: number; y: number },
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		const layerId = this.context.getCurrentLayerId();
		if (!layerId) return false;
		for (const mesh of this.selectedMeshes.values()) {
			if (this.context.isElementLocked(mesh.id)) continue;
			const local = this.meshWorldToLocal(mesh, world);
			for (let fi = 0; fi < mesh.faces.length; fi++) {
				const face = mesh.faces[fi];
				if (face.type !== "quad") continue;
				if (
					!pointInBezierFace(mesh.vertices, mesh.faces, face, local.x, local.y)
				) {
					continue;
				}
				const { u, v } = bilinearUV(
					mesh.vertices,
					face.verts,
					local.x,
					local.y,
				);
				const result = subdivideWarpFace(mesh.vertices, mesh.faces, fi, u, v);
				if (!result) return false;
				syncDerivedVertices(result.vertices, result.faces);
				this.context.applyDeformation([
					{
						elementId: mesh.id,
						layerId,
						updates: { vertices: result.vertices, faces: result.faces },
					},
				]);
				this.selectedMeshes.set(mesh.id, {
					...mesh,
					vertices: result.vertices,
					faces: result.faces,
				});
				this.selectOnlyMeshVertex(mesh.id, result.centerIdx);
				this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
				return true;
			}
		}
		return false;
	}

	/** Promote a derived cage vertex to explicit, preserving the curve shape. */
	private promoteMeshVertexToExplicit(
		meshId: string,
		vertexIndex: number,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const mesh = this.selectedMeshes.get(meshId);
		if (!mesh || this.context.isElementLocked(meshId)) return;
		const layerId = this.context.getCurrentLayerId();
		if (!layerId) return;

		const promoted = promoteWarpVertexToExplicit(
			mesh.vertices,
			mesh.faces,
			vertexIndex,
		);
		if (!promoted) return; // already explicit
		syncDerivedVertices(promoted, mesh.faces);
		this.context.applyDeformation([
			{ elementId: meshId, layerId, updates: { vertices: promoted } },
		]);
		this.selectedMeshes.set(meshId, { ...mesh, vertices: promoted });
		this.selectOnlyMeshVertex(meshId, vertexIndex);
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
	}

	/** @returns true when at least one selected cage vertex was deleted. */
	private deleteSelectedMeshVertices(
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		const layerId = this.context.getCurrentLayerId();
		if (!layerId) return false;

		let deletedAny = false;
		for (const [meshId, indices] of this.selectedVertexIndicesByMesh()) {
			const mesh = this.selectedMeshes.get(meshId);
			if (!mesh || this.context.isElementLocked(meshId)) continue;
			// The initial four corners are protected.
			const targets = indices.filter((index) => index >= 4);
			if (targets.length === 0) continue;

			// deleteMeshVertex renumbers the remaining vertices (and drops split
			// siblings), so each removal is re-resolved by position rather than by
			// the stale index. A target already gone as a sibling is skipped.
			let vertices = mesh.vertices;
			let faces = mesh.faces;
			let changed = false;
			const positions = targets.map((index) => ({ ...mesh.vertices[index] }));
			for (const position of positions) {
				const index = vertices.findIndex(
					(v) =>
						Math.abs(v.x - position.x) < 1e-6 &&
						Math.abs(v.y - position.y) < 1e-6,
				);
				if (index < 4) continue;
				// A vertex the user promoted goes back to being derived rather than
				// away: it was part of the cage before they made it explicit, and
				// removing it would leave the cut line it anchors half-attached.
				const demoted = demoteWarpVertexToDerived(vertices, faces, index);
				if (demoted) {
					vertices = demoted;
					changed = true;
					continue;
				}
				const result = deleteMeshVertex(vertices, faces, index, 4);
				if (result.vertices.length === vertices.length) continue;
				vertices = result.vertices;
				faces = result.faces;
				changed = true;
			}
			if (!changed) continue;

			syncDerivedVertices(vertices, faces);
			this.context.applyDeformation([
				{ elementId: meshId, layerId, updates: { vertices, faces } },
			]);
			this.selectedMeshes.set(meshId, { ...mesh, vertices, faces });
			deletedAny = true;
		}
		if (!deletedAny) return false;

		this.selectedMeshVertices.clear();
		this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		return true;
	}

	private meshComposedTransform(mesh: MeshArtObject): ElementTransform {
		const ancestor = this.meshAncestorTransforms.get(mesh.id) ?? null;
		return ancestor
			? composeTransforms(ancestor, getTransform(mesh))
			: getTransform(mesh);
	}

	private meshLocalToWorld(
		mesh: MeshArtObject,
		point: { x: number; y: number },
	): { x: number; y: number } {
		const t = this.meshComposedTransform(mesh);
		if (isIdentityTransform(t)) return { x: point.x, y: point.y };
		const origin = computeTransformOrigin(
			brandLocalBBox(calculateMeshCoordinateBounds(mesh.vertices)),
		);
		return applyTransformToPoint(point.x, point.y, t, origin.x, origin.y);
	}

	private meshWorldToLocal(
		mesh: MeshArtObject,
		point: { x: number; y: number },
	): { x: number; y: number } {
		const t = this.meshComposedTransform(mesh);
		if (isIdentityTransform(t)) return { x: point.x, y: point.y };
		const origin = computeTransformOrigin(
			brandLocalBBox(calculateMeshCoordinateBounds(mesh.vertices)),
		);
		return inverseTransform(point.x, point.y, t, origin.x, origin.y);
	}

	private buildMeshCageUIData(): NonNullable<PathEditUIData["meshCages"]> {
		const cages: NonNullable<PathEditUIData["meshCages"]> = [];
		const ds = this.dragState;
		for (const stored of this.selectedMeshes.values()) {
			const mesh =
				(ds.mode === "meshVertexDrag" ||
					ds.mode === "meshCpDrag" ||
					ds.mode === "meshFanDrag") &&
				ds.meshId === stored.id
					? ds.draft
					: stored;
			const toWorld = (p: { x: number; y: number }) =>
				this.meshLocalToWorld(stored, p);

			const edges = collectMeshEdgeCurves(mesh.vertices, mesh.faces).map(
				({ curve }) => ({
					start: toWorld(curve[0]),
					cp1: toWorld(curve[1]),
					cp2: toWorld(curve[2]),
					end: toWorld(curve[3]),
				}),
			);

			const handles: MeshCageHandle[] = [];
			mesh.vertices.forEach((vertex, vi) => {
				if (vertex.hidden) return;
				const w = toWorld(vertex);
				handles.push({
					id: `meshv:${mesh.id}:${vi}`,
					handleType: "mesh-vertex",
					worldX: w.x,
					worldY: w.y,
					isDerived: vertex.positionSource != null,
					selected: this.selectedMeshVertices.has(meshVertexKey(mesh.id, vi)),
				});
			});

			// CP handles: around every selected vertex, both edge sides, filtered
			// to CPs that actually drive the rendered curve. Two adjacent selected
			// vertices would emit the same handle twice, so ids are deduped.
			const emittedCps = new Set<string>();
			for (const vi of this.selectedVertexIndicesOf(mesh.id)) {
				if (!mesh.vertices[vi]) continue;
				for (const { ownerIdx, neighborIdx, cp } of collectMeshCPHandles(
					mesh.vertices,
					mesh.faces,
					vi,
				)) {
					const id = `meshcp:${mesh.id}:${ownerIdx}:${neighborIdx}`;
					if (emittedCps.has(id)) continue;
					emittedCps.add(id);
					const cpWorld = toWorld(cp);
					const ownerWorld = toWorld(mesh.vertices[ownerIdx]);
					handles.push({
						id,
						handleType: "mesh-cp",
						worldX: cpWorld.x,
						worldY: cpWorld.y,
						stemWorldX: ownerWorld.x,
						stemWorldY: ownerWorld.y,
						selected: false,
					});
				}
			}

			// World AABB of the cage, matching what the select tool draws as the
			// element's bounding box (cage vertices + handles).
			const localBounds = calculateMeshCoordinateBounds(mesh.vertices);
			const corners = [
				toWorld({ x: localBounds.minX, y: localBounds.minY }),
				toWorld({ x: localBounds.maxX, y: localBounds.minY }),
				toWorld({ x: localBounds.maxX, y: localBounds.maxY }),
				toWorld({ x: localBounds.minX, y: localBounds.maxY }),
			];
			const xs = corners.map((c) => c.x);
			const ys = corners.map((c) => c.y);
			const minX = Math.min(...xs);
			const minY = Math.min(...ys);
			const maxX = Math.max(...xs);
			const maxY = Math.max(...ys);

			cages.push({
				meshId: mesh.id,
				bounds: {
					minX,
					minY,
					maxX,
					maxY,
					width: maxX - minX,
					height: maxY - minY,
				},
				edges,
				handles,
			});
		}
		return cages;
	}

	private startLongPressTimer(
		worldX: number,
		worldY: number,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		this.cancelLongPressTimer();
		this.longPressTimer = setTimeout(() => {
			this.longPressTimer = null;
			this.longPressRing = { worldX, worldY };
			this.updatePathEditUI(viewport, canvasWidth, canvasHeight);
		}, PathEditTool.LONG_PRESS_MS);
	}

	private cancelLongPressTimer(): void {
		if (this.longPressTimer != null) {
			clearTimeout(this.longPressTimer);
			this.longPressTimer = null;
		}
	}

	private clearLongPressRing(): void {
		this.cancelLongPressTimer();
		this.longPressRing = null;
	}
}

/** Selection key for one cage vertex. Mesh ids never contain ":". */
function meshVertexKey(meshId: string, vertexIndex: number): string {
	return `${meshId}:${vertexIndex}`;
}

function parseMeshVertexKey(key: string): {
	meshId: string;
	vertexIndex: number;
} {
	const separator = key.lastIndexOf(":");
	return {
		meshId: key.slice(0, separator),
		vertexIndex: Number.parseInt(key.slice(separator + 1), 10),
	};
}

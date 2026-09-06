import { deepClone } from "valtio/utils";
import { buildGradientOverlay } from "../renderer/ui/builders/gradient";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type {
	GradientEditUIData,
	GradientEditUIHandle,
} from "../renderer/ui/types";
import {
	type AnyArtObject,
	type BoundingBox,
	type Color,
	colorToRawRGBA,
	type FillAppearance,
	type FillColor,
	generateUid,
	getTransform,
	isAppearancePresetRef,
	isFreeGradient,
	isLinearGradient,
	isMeshGradient,
	isRadialGradient,
	isSolidColor,
	type MeshGradient,
	type MeshGradientVertex,
	type Viewport,
} from "../schema";
import { getFirstFill } from "../utils/elementQuery";
import {
	defaultEdgeCP,
	freeGradientAdjacency as delaunayAdjacency,
} from "../utils/geometry/freeGradient";
import { screenToWorld } from "../utils/geometry/geometry";
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
	colorFromFaceCorners,
	createEdgeDerivedColorVertex,
	createQuadDerivedColorVertex,
	getBoundarySegmentInfo,
	getLocalEdgeTFromBoundaryT,
	pointInBezierFace,
	rotateDerivedCrossHandles,
	subdivideFace,
	syncDerivedVertices,
} from "../utils/geometry/meshGradient";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

// --- Coordinate helpers ---

function getElementRotationRad(element: AnyArtObject | null): number {
	if (!element) return 0;
	return getTransform(element).rotation;
}

function boundsRelativeToWorld(
	bx: number,
	by: number,
	bounds: BoundingBox,
	rotationRad = 0,
): { x: number; y: number } {
	const x = bounds.minX + bx * bounds.width;
	const y = bounds.minY + by * bounds.height;
	if (rotationRad === 0) return { x, y };

	const cx = bounds.minX + bounds.width / 2;
	const cy = bounds.minY + bounds.height / 2;
	const cos = Math.cos(rotationRad);
	const sin = Math.sin(rotationRad);
	const dx = x - cx;
	const dy = y - cy;
	return {
		x: cx + dx * cos - dy * sin,
		y: cy + dx * sin + dy * cos,
	};
}

function worldToBoundsRelative(
	wx: number,
	wy: number,
	bounds: BoundingBox,
	rotationRad = 0,
): { x: number; y: number } {
	let x = wx;
	let y = wy;
	if (rotationRad !== 0) {
		const cx = bounds.minX + bounds.width / 2;
		const cy = bounds.minY + bounds.height / 2;
		const cos = Math.cos(-rotationRad);
		const sin = Math.sin(-rotationRad);
		const dx = wx - cx;
		const dy = wy - cy;
		x = cx + dx * cos - dy * sin;
		y = cy + dx * sin + dy * cos;
	}
	return {
		x: (x - bounds.minX) / bounds.width,
		y: (y - bounds.minY) / bounds.height,
	};
}

/** Extract the FillColor from an element's FillAppearance filter entry */
function getElementFill(element: AnyArtObject | null): FillColor | undefined {
	if (!element) return undefined;
	return getFirstFill(element.filters)?.paramData.params.fill;
}

/** The element's filters with its fill appearance carrying `fill` instead. */
function filtersWithFill(
	element: AnyArtObject,
	fill: FillColor,
): NonNullable<AnyArtObject["filters"]> {
	return (element.filters ?? []).map((f) =>
		!isAppearancePresetRef(f) && f.processor === "fill"
			? {
					...f,
					paramData: {
						...(f as FillAppearance).paramData,
						params: {
							...(f as FillAppearance).paramData.params,
							fill,
						},
					},
				}
			: f,
	);
}

// --- Tool ---

type DragState =
	| { mode: "idle" }
	| {
			mode: "dragging";
			handleId: string;
			initialRotation?: number;
			initialDragAngle?: number;
			/**
			 * Bounds-relative offset between the pointer's grab position and the
			 * handle's underlying data position (x1/y1, x2/y2, cx/cy), captured
			 * at drag start. Handles like linear-start/linear-end/radial-center
			 * render offset outward from their data position (so they don't
			 * overlap color stops), so applying the raw pointer position
			 * directly would snap the data point to the cursor on the first
			 * move. Subtracting this offset keeps the grabbed spot under the
			 * cursor instead.
			 */
			grabOffsetX?: number;
			grabOffsetY?: number;
			/** Alt-drag on a mesh vertex; see {@link MeshHandleFanState}. */
			meshFan?: MeshHandleFanState;
			/**
			 * Latest fill this drag produced. Frames preview it through the
			 * element-override channel; pointer-up commits it once, so one drag
			 * is one undo step (same shape as the cage editor).
			 */
			pendingFill?: FillColor;
			/** Screen position at pointer-down for the drag threshold. */
			startScreenX: number;
			startScreenY: number;
			/** Set once the pointer has moved past the drag threshold. */
			passedThreshold: boolean;
	  };

export class GradientTool implements Tool {
	/** Screen-px the pointer must move before a drag displaces anything. */
	private static DRAG_THRESHOLD_SCREEN_PX = 3;
	/** Screen-px distance from a mesh edge within which a double-click splits it. */
	private static MESH_EDGE_SPLIT_TOLERANCE_PX = 8;

	public readonly name = "gradient";

	private context: ToolContext;

	private dragState: DragState = { mode: "idle" };

	// Free gradient selected stop
	private selectedStopId: string | null = null;
	// Linear/Radial gradient selected stop index
	private selectedStopIndex: number | null = null;

	public constructor(context: ToolContext) {
		this.context = context;
	}

	private setSelectedStop(id: string | null): void {
		this.selectedStopId = id;
		this.context.setGradientSelectedStopId(id);
	}

	private setSelectedStopIndex(index: number | null): void {
		this.selectedStopIndex = index;
		this.context.setGradientSelectedStopIndex(index);
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly()) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		// Try hit-testing existing handles first
		const element = this.context.getSelectedElement();
		if (element && this.context.isElementLocked(element.id)) return;
		const bounds = this.context.getSelectedElementBounds();

		const fill = getElementFill(element);
		if (fill && bounds && !isSolidColor(fill)) {
			const rotationRad = getElementRotationRad(element);
			// Refresh the overlay so the hit test sees the current handle layout
			// (the historical code rebuilt handles on the spot for this test).
			this.updateUI();
			const hit = this.context.uiHitTest({ x: event.x, y: event.y });
			const handle =
				hit?.overlayKey === OVERLAY_KEYS.gradientHandles
					? (this.buildHandles(fill, bounds, rotationRad).find(
							(h) => h.id === hit.hitId,
						) ?? null)
					: null;

			if (handle) {
				const rel = worldToBoundsRelative(
					world.x,
					world.y,
					bounds,
					rotationRad,
				);

				// For rotation handle, store initial angles
				let initialRotation: number | undefined;
				let initialDragAngle: number | undefined;
				if (handle.handleType === "radial-rotation" && isRadialGradient(fill)) {
					initialRotation = fill.rotation;
					// Calculate initial angle from center to drag point
					const centerPixelX = fill.cx * bounds.width;
					const centerPixelY = fill.cy * bounds.height;
					const dragPixelX = rel.x * bounds.width;
					const dragPixelY = rel.y * bounds.height;
					const dx = dragPixelX - centerPixelX;
					const dy = dragPixelY - centerPixelY;
					initialDragAngle = Math.atan2(dy, dx);
				}

				// linear-start/linear-end render offset outward from x1/y1 or
				// x2/y2 (so the handle doesn't overlap the first/last color
				// stop). Record how far the grab point sits from the real data
				// position so onPointerMove can preserve that offset instead of
				// snapping the data point to the cursor.
				let grabOffsetX: number | undefined;
				let grabOffsetY: number | undefined;
				if (handle.handleType === "linear-start" && isLinearGradient(fill)) {
					grabOffsetX = rel.x - fill.x1;
					grabOffsetY = rel.y - fill.y1;
				} else if (
					handle.handleType === "linear-end" &&
					isLinearGradient(fill)
				) {
					grabOffsetX = rel.x - fill.x2;
					grabOffsetY = rel.y - fill.y2;
				} else if (
					handle.handleType === "mesh-vertex" &&
					isMeshGradient(fill) &&
					!event.altKey
				) {
					// Same for mesh vertices: the hit tolerance lets the grab land
					// up to ~10px off the vertex, and without the offset the first
					// move snapped the vertex to the cursor.
					const vertex =
						fill.vertices[Number.parseInt(handle.id.split(":")[1], 10)];
					if (vertex) {
						grabOffsetX = rel.x - vertex.x;
						grabOffsetY = rel.y - vertex.y;
					}
				}

				// Alt-drag on a mesh vertex adjusts all of its CP handles at once
				// instead of moving the vertex. Directions live in bounds-pixel
				// space so a non-square bounds does not skew the fan.
				let meshFan: MeshHandleFanState | undefined;
				if (
					handle.handleType === "mesh-vertex" &&
					event.altKey &&
					isMeshGradient(fill)
				) {
					meshFan = beginMeshHandleFan(
						fill.vertices,
						fill.faces,
						Number.parseInt(handle.id.split(":")[1], 10),
						bounds.width,
						bounds.height,
					);
				}

				this.dragState = {
					mode: "dragging",
					handleId: handle.id,
					initialRotation,
					initialDragAngle,
					grabOffsetX,
					grabOffsetY,
					meshFan,
					startScreenX: event.x,
					startScreenY: event.y,
					passedThreshold: false,
				};

				// Select gradient stop
				if (handle.handleType === "free-stop") {
					this.setSelectedStop(handle.id);
					this.setSelectedStopIndex(null);
				} else if (handle.handleType === "mesh-vertex") {
					this.setSelectedStop(handle.id);
					this.setSelectedStopIndex(null);
				} else if (
					handle.handleType === "linear-stop" ||
					handle.handleType === "radial-stop"
				) {
					const idx = Number.parseInt(handle.id.split(":")[1], 10);
					this.setSelectedStopIndex(idx);
					this.setSelectedStop(null);
				} else if (
					handle.handleType === "linear-midpoint" ||
					handle.handleType === "radial-midpoint"
				) {
					// The index refers to the segment's left stop (stops[idx] ~
					// stops[idx+1]); dragging the midpoint updates stops[idx].midpoint.
					const idx = Number.parseInt(handle.id.split(":")[1], 10);
					this.setSelectedStopIndex(idx);
					this.setSelectedStop(null);
				} else {
					this.setSelectedStopIndex(null);
				}

				this.updateUI();
				return;
			}
		}

		// No handle hit — try selecting a new element
		const hitElement = this.context.findElementAtPoint(world.x, world.y, 5);

		if (hitElement) {
			const hitFill = getElementFill(hitElement);
			if (hitFill && !isSolidColor(hitFill)) {
				const hitBounds = this.context.getBounds(hitElement.id);
				if (!hitBounds) return;
				this.context.elementSelect(hitElement.id, hitBounds);
				this.setSelectedStop(null);
				this.setSelectedStopIndex(null);
				this.updateUI();
			} else {
				this.context.selectionClear();
				this.setSelectedStop(null);
				this.setSelectedStopIndex(null);
				this.updateGradientOverlay(null);
			}
		} else {
			this.context.selectionClear();
			this.setSelectedStop(null);
			this.setSelectedStopIndex(null);
			this.updateGradientOverlay(null);
		}
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.dragState.mode !== "dragging") return;
		// A click must not displace anything: ignore moves until the pointer
		// has clearly left the pointer-down position.
		if (!this.dragState.passedThreshold) {
			const moved = Math.hypot(
				event.x - this.dragState.startScreenX,
				event.y - this.dragState.startScreenY,
			);
			if (moved < GradientTool.DRAG_THRESHOLD_SCREEN_PX) return;
			this.dragState.passedThreshold = true;
		}
		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		const element = this.context.getSelectedElement();
		const bounds = this.context.getSelectedElementBounds();
		// Frames build on the previewed fill, not the stored one — the store
		// only changes at pointer-up.
		const moveFill = this.dragState.pendingFill ?? getElementFill(element);
		if (!element || !moveFill || !bounds || isSolidColor(moveFill)) return;
		const rotationRad = getElementRotationRad(element);
		const rawRel = worldToBoundsRelative(world.x, world.y, bounds, rotationRad);
		// Mesh vertices keep the spot that was grabbed under the cursor.
		const rel =
			this.dragState.handleId.startsWith("mesh-vertex:") &&
			!this.dragState.meshFan
				? {
						x: rawRel.x - (this.dragState.grabOffsetX ?? 0),
						y: rawRel.y - (this.dragState.grabOffsetY ?? 0),
					}
				: rawRel;
		const updated = deepClone(moveFill);

		if (isLinearGradient(updated)) {
			if (this.dragState.handleId === "linear-start") {
				updated.x1 = rel.x - (this.dragState.grabOffsetX ?? 0);
				updated.y1 = rel.y - (this.dragState.grabOffsetY ?? 0);
			} else if (this.dragState.handleId === "linear-end") {
				updated.x2 = rel.x - (this.dragState.grabOffsetX ?? 0);
				updated.y2 = rel.y - (this.dragState.grabOffsetY ?? 0);
			} else if (this.dragState.handleId?.startsWith("linear-stop:")) {
				if (this.selectedStopIndex == null) return;
				const stop = updated.stops[this.selectedStopIndex];
				if (!stop) return;

				// Project onto the gradient line to compute new offset
				const dx = updated.x2 - updated.x1;
				const dy = updated.y2 - updated.y1;
				const lenSq = dx * dx + dy * dy;
				if (lenSq > 0) {
					const t =
						((rel.x - updated.x1) * dx + (rel.y - updated.y1) * dy) / lenSq;
					stop.offset = Math.max(0, Math.min(1, t));

					// REAL-TIME SORT
					updated.stops.sort((a, b) => a.offset - b.offset);
					this.selectedStopIndex = updated.stops.indexOf(stop);
				}
			} else if (this.dragState.handleId?.startsWith("linear-midpoint:")) {
				if (this.selectedStopIndex == null) return;
				const s0 = updated.stops[this.selectedStopIndex];
				const s1 = updated.stops[this.selectedStopIndex + 1];
				if (!s0 || !s1) return;

				// Project onto the gradient line, same as the stop-drag branch,
				// then normalize within the [s0, s1] segment.
				const dx = updated.x2 - updated.x1;
				const dy = updated.y2 - updated.y1;
				const lenSq = dx * dx + dy * dy;
				if (lenSq > 0) {
					const t =
						((rel.x - updated.x1) * dx + (rel.y - updated.y1) * dy) / lenSq;
					const range = s1.offset - s0.offset;
					const mp = range > 0 ? (t - s0.offset) / range : 0.5;
					s0.midpoint = Math.max(0.0001, Math.min(0.9999, mp));
					// No stops.sort() here — a midpoint drag never changes offset.
				}
			}
		} else if (isRadialGradient(updated)) {
			if (this.dragState.handleId === "radial-center") {
				updated.cx = rel.x;
				updated.cy = rel.y;
			} else if (this.dragState.handleId === "radial-radius-x") {
				// Calculate distance along rotated X-axis
				const dx = rel.x - updated.cx;
				const dy = rel.y - updated.cy;
				const cos = Math.cos(-updated.rotation);
				const sin = Math.sin(-updated.rotation);
				const localX = dx * cos - dy * sin;
				updated.radiusX = Math.max(0.001, Math.abs(localX));
			} else if (this.dragState.handleId === "radial-radius-y") {
				// Calculate distance along rotated Y-axis
				const dx = rel.x - updated.cx;
				const dy = rel.y - updated.cy;
				const cos = Math.cos(-updated.rotation);
				const sin = Math.sin(-updated.rotation);
				const localY = dx * sin + dy * cos;
				updated.radiusY = Math.max(0.001, Math.abs(localY));
			} else if (this.dragState.handleId === "radial-rotation") {
				// Calculate angle Delta from initial drag angle
				const centerPixelX = updated.cx * bounds.width;
				const centerPixelY = updated.cy * bounds.height;
				const dragPixelX = rel.x * bounds.width;
				const dragPixelY = rel.y * bounds.height;
				const dx = dragPixelX - centerPixelX;
				const dy = dragPixelY - centerPixelY;
				const currentDragAngle = Math.atan2(dy, dx);

				// Apply delta rotation from initial
				if (
					this.dragState.initialRotation !== undefined &&
					this.dragState.initialDragAngle !== undefined
				) {
					const angleDelta = currentDragAngle - this.dragState.initialDragAngle;
					updated.rotation = this.dragState.initialRotation + angleDelta;
				}
			} else if (this.dragState.handleId?.startsWith("radial-stop:")) {
				if (this.selectedStopIndex == null) return;
				const stop = updated.stops[this.selectedStopIndex];
				if (!stop) return;

				// Calculate ellipse distance with rotation (bounds-relative space)
				const dx = rel.x - updated.cx;
				const dy = rel.y - updated.cy;
				const cos = Math.cos(-updated.rotation);
				const sin = Math.sin(-updated.rotation);
				const localX = dx * cos - dy * sin;

				// Project onto X-axis in rotated local space (ColorStops only move along X-axis)
				// offset = localX distance / radiusX
				const offset = localX / Math.max(updated.radiusX, 0.001);
				stop.offset = Math.max(0, Math.min(1, offset));

				// REAL-TIME SORT
				updated.stops.sort((a, b) => a.offset - b.offset);
				this.selectedStopIndex = updated.stops.indexOf(stop);
			} else if (this.dragState.handleId?.startsWith("radial-midpoint:")) {
				if (this.selectedStopIndex == null) return;
				const s0 = updated.stops[this.selectedStopIndex];
				const s1 = updated.stops[this.selectedStopIndex + 1];
				if (!s0 || !s1) return;

				const dx = rel.x - updated.cx;
				const dy = rel.y - updated.cy;
				const cos = Math.cos(-updated.rotation);
				const sin = Math.sin(-updated.rotation);
				const localX = dx * cos - dy * sin;
				const offset = localX / Math.max(updated.radiusX, 0.001);

				const range = s1.offset - s0.offset;
				const mp = range > 0 ? (offset - s0.offset) / range : 0.5;
				s0.midpoint = Math.max(0.0001, Math.min(0.9999, mp));
				// No stops.sort() here — a midpoint drag never changes offset.
			}
		} else if (isMeshGradient(updated)) {
			// Snapshot for the cross-handle rotation below: it needs the mesh as
			// it was before this frame's edit.
			const previousVertices = updated.vertices.map((vertex) => ({
				...vertex,
				handles: { ...vertex.handles },
			}));
			if (this.dragState.handleId.startsWith("mesh-vertex:")) {
				const vi = Number.parseInt(this.dragState.handleId.split(":")[1], 10);
				const vertex = updated.vertices[vi];
				if (vertex && this.dragState.meshFan) {
					applyMeshHandleFan(
						this.dragState.meshFan,
						vertex,
						rel,
						viewport.zoom,
						bounds.width,
						bounds.height,
					);
				} else if (vertex) {
					if (vertex.colorMode === "derived") {
						if (vertex.colorSource?.kind === "quad") {
							vertex.colorSource = undefined;
						}
					}

					// An edge-derived vertex is projected back onto its owning root
					// segment; its color follows the slide along the edge.
					const { t } = slideMeshVertex(
						updated.vertices,
						updated.faces,
						vi,
						rel.x,
						rel.y,
					);
					if (t != null && vertex.colorSource?.kind === "edge") {
						vertex.colorSource = {
							...vertex.colorSource,
							t: getLocalEdgeTFromBoundaryT(
								updated.vertices,
								updated.faces,
								vertex.colorSource.edgeVerts,
								t,
							),
						};
					}
				}
			} else if (this.dragState.handleId.startsWith("mesh-cp:")) {
				const parts = this.dragState.handleId.split(":");
				writeMeshCPHandle(
					updated.vertices,
					updated.faces,
					Number.parseInt(parts[1], 10),
					Number.parseInt(parts[2], 10),
					rel,
				);
			}

			// Mesh topology edits (moving a vertex, CP, or face shape) can shift
			// positions / edge parameters that derived vertices reference; keep
			// them in sync after every drag frame so cascaded updates stay
			// visually correct.
			syncDerivedVertices(updated.vertices, updated.faces);
			// Split lines leaving a moved edge turn with it, so bending a
			// boundary handle bends the interior instead of creasing at the cut.
			rotateDerivedCrossHandles(
				previousVertices,
				updated.vertices,
				updated.faces,
			);
		} else if (isFreeGradient(updated)) {
			// Check if dragging a CP handle (format: "cp:{stopId}:{neighborId}")
			if (this.dragState.handleId.startsWith("cp:")) {
				const parts = this.dragState.handleId.split(":");
				const stopId = parts[1];
				const neighborId = parts[2];
				const stop = updated.stops.find((s) => s.id === stopId);
				const neighbor = updated.stops.find((s) => s.id === neighborId);
				if (stop && neighbor) {
					stop.edgeCPs ??= {};
					// Alt: rotate/scale every other CP hanging off this same stop by
					// the same angle and CS-distance delta this drag applies to the
					// grabbed one, instead of moving only the grabbed CP.
					if (event.altKey) {
						const oldCp =
							stop.edgeCPs[neighborId] ?? defaultEdgeCP(stop, neighbor);
						const oldR = Math.hypot(oldCp.x - stop.x, oldCp.y - stop.y);
						const oldTheta = Math.atan2(oldCp.y - stop.y, oldCp.x - stop.x);
						const newR = Math.hypot(rel.x - stop.x, rel.y - stop.y);
						const newTheta = Math.atan2(rel.y - stop.y, rel.x - stop.x);
						const deltaTheta = newTheta - oldTheta;
						const deltaR = newR - oldR;

						const stopIdx = updated.stops.indexOf(stop);
						const neighborIndices =
							delaunayAdjacency(updated.stops).get(stopIdx) ?? new Set();
						for (const ni of neighborIndices) {
							const otherNeighbor = updated.stops[ni];
							if (otherNeighbor.id === neighborId) continue;
							const otherCp =
								stop.edgeCPs[otherNeighbor.id] ??
								defaultEdgeCP(stop, otherNeighbor);
							const otherR = Math.hypot(otherCp.x - stop.x, otherCp.y - stop.y);
							const otherTheta = Math.atan2(
								otherCp.y - stop.y,
								otherCp.x - stop.x,
							);
							const newOtherR = Math.max(0, otherR + deltaR);
							const newOtherTheta = otherTheta + deltaTheta;
							stop.edgeCPs[otherNeighbor.id] = {
								x: stop.x + newOtherR * Math.cos(newOtherTheta),
								y: stop.y + newOtherR * Math.sin(newOtherTheta),
							};
						}
					}
					stop.edgeCPs[neighborId] = { x: rel.x, y: rel.y };
				}
			} else {
				// Dragging a stop
				const stop = updated.stops.find(
					(s) =>
						s.id ===
						(this.dragState as { mode: "dragging"; handleId: string }).handleId,
				);
				if (stop) {
					const dx = rel.x - stop.x;
					const dy = rel.y - stop.y;
					stop.x = rel.x;
					stop.y = rel.y;
					// Move edge CPs with the stop
					if (stop.edgeCPs) {
						for (const cp of Object.values(stop.edgeCPs)) {
							cp.x += dx;
							cp.y += dy;
						}
					}
				}
			}
		}

		// Preview only: the store commits once at pointer-up, so one drag is
		// one undo step.
		this.dragState.pendingFill = updated;
		const layerId = this.context.getCurrentLayerId();
		if (layerId) {
			this.context.previewDeformation([
				{
					elementId: element.id,
					layerId,
					updates: { filters: filtersWithFill(element, updated) },
				},
			]);
		}
		this.updateUI();
	}

	public onPointerUp(
		_event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		if (this.dragState.mode === "dragging" && this.dragState.pendingFill) {
			const element = this.context.getSelectedElement();
			if (element) {
				this.context.clearDeformationPreview([element.id]);
				this.context.updateFill(this.dragState.pendingFill);
			}
		}
		this.dragState = { mode: "idle" };
		this.updateUI();
	}

	public onDoubleClick(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const element = this.context.getSelectedElement();
		const bounds = this.context.getSelectedElementBounds();
		const dblFill = getElementFill(element);
		if (!dblFill || !bounds) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const rotationRad = getElementRotationRad(element);
		const rel = worldToBoundsRelative(world.x, world.y, bounds, rotationRad);

		if (isMeshGradient(dblFill)) {
			// Three tiers, same as the warp cage editor: a vertex promotes, a
			// nearby edge takes a single-direction cut, a face splits crosswise.
			this.updateUI();
			const hit = this.context.uiHitTest({ x: event.x, y: event.y });
			if (
				hit?.overlayKey === OVERLAY_KEYS.gradientHandles &&
				hit.hitId.startsWith("mesh-vertex:")
			) {
				this.promoteMeshGradientVertexAt(
					dblFill,
					Number.parseInt(hit.hitId.split(":")[1], 10),
				);
				return;
			}
			if (
				this.splitMeshGradientEdgeAt(
					dblFill,
					rel,
					bounds,
					rotationRad,
					viewport,
				)
			) {
				return;
			}
			this.subdivideMeshGradientFaceAt(dblFill, rel.x, rel.y);
			return;
		}

		if (!isFreeGradient(dblFill)) return;

		// Add a new stop at double-click position

		// Find nearest stop to interpolate color
		let nearestColor: Color = dblFill.stops[0]?.color ?? {
			type: "rgb" as const,
			r: 0.5,
			g: 0.5,
			b: 0.5,
			a: 1,
		};
		let nearestDist = Infinity;
		for (const s of dblFill.stops) {
			const d = Math.hypot(s.x - rel.x, s.y - rel.y);
			if (d < nearestDist) {
				nearestDist = d;
				nearestColor = s.color;
			}
		}

		const updated = deepClone(dblFill);
		const newId = generateUid("grad-stop");
		updated.stops.push({
			id: newId,
			x: rel.x,
			y: rel.y,
			color: deepClone(nearestColor),
		});

		this.setSelectedStop(newId);
		this.context.updateFill(updated);
		this.updateUI();
	}

	public onKeyDown(
		event: KeyboardEvent,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): boolean {
		// Delete/Backspace: remove selected free gradient stop or mesh vertex.
		// The removal (with its minimum-stop / corner-vertex guards), selection
		// clearing, and overlay rebuild live behind the shared command bridge so
		// UI surfaces like ContextActions trigger the exact same path.
		if (
			(event.code === "Delete" || event.code === "Backspace") &&
			this.selectedStopId
		) {
			this.context.deleteSelectedGradientStop();
			return true;
		}

		return false;
	}

	/**
	 * Clears the stop selection from outside the tool's own event flow
	 * (e.g. after a stop is deleted via the shared command).
	 */
	public clearStopSelection(): void {
		this.setSelectedStop(null);
		this.setSelectedStopIndex(null);
	}

	public onCancel(): void {
		this.dragState = { mode: "idle" };
		this.setSelectedStop(null);
		this.setSelectedStopIndex(null);
		this.updateGradientOverlay(null);
	}

	public getCursor(): string {
		if (this.dragState.mode === "dragging") return "grabbing";
		return "default";
	}

	/** Called externally when selection changes to rebuild UI */
	public refreshUI(): void {
		this.context.uiRefreshSelectionUI(false);
		this.updateUI();
	}

	// --- Build UI data ---

	private updateGradientOverlay(data: GradientEditUIData | null): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.gradientHandles,
			data
				? {
						zIndex: OVERLAY_Z.gradient,
						primitives: buildGradientOverlay(data, UI_THEME),
					}
				: null,
		);
	}

	private buildHandles(
		fill: FillColor,
		bounds: BoundingBox,
		rotationRad = 0,
	): GradientEditUIHandle[] {
		const handles: GradientEditUIHandle[] = [];

		if (isLinearGradient(fill)) {
			const start = boundsRelativeToWorld(
				fill.x1,
				fill.y1,
				bounds,
				rotationRad,
			);
			const end = boundsRelativeToWorld(fill.x2, fill.y2, bounds, rotationRad);

			// Offset position handles outward so they don't overlap color stops
			const dx = end.x - start.x;
			const dy = end.y - start.y;
			const len = Math.sqrt(dx * dx + dy * dy);
			const handleOffset = len > 0 ? 16 : 0;
			const nx = len > 0 ? dx / len : 0;
			const ny = len > 0 ? dy / len : 0;

			handles.push({
				id: "linear-start",
				worldX: start.x - nx * handleOffset,
				worldY: start.y - ny * handleOffset,
				handleType: "linear-start",
				color: UI_THEME.colors.gradientLinearStartHandle,
				selected: false,
			});
			handles.push({
				id: "linear-end",
				worldX: end.x + nx * handleOffset,
				worldY: end.y + ny * handleOffset,
				handleType: "linear-end",
				color: UI_THEME.colors.gradientLinearEndHandle,
				selected: false,
			});

			// Color stop handles along the gradient line
			for (let i = 0; i < fill.stops.length; i++) {
				const stop = fill.stops[i];
				const t = stop.offset;
				const sx = fill.x1 + (fill.x2 - fill.x1) * t;
				const sy = fill.y1 + (fill.y2 - fill.y1) * t;
				const w = boundsRelativeToWorld(sx, sy, bounds, rotationRad);
				const { r, g, b, a } = colorToRawRGBA(stop.color);
				handles.push({
					id: `linear-stop:${i}`,
					worldX: w.x,
					worldY: w.y,
					handleType: "linear-stop",
					color: [r, g, b, a],
					selected: this.selectedStopIndex === i,
				});
			}

			// Midpoint handles between adjacent stops, positioned along the
			// gradient line at the offset the stop's midpoint biases toward.
			for (let i = 0; i < fill.stops.length - 1; i++) {
				const s0 = fill.stops[i];
				const s1 = fill.stops[i + 1];
				const t = s0.offset + s0.midpoint * (s1.offset - s0.offset);
				const sx = fill.x1 + (fill.x2 - fill.x1) * t;
				const sy = fill.y1 + (fill.y2 - fill.y1) * t;
				const w = boundsRelativeToWorld(sx, sy, bounds, rotationRad);
				handles.push({
					id: `linear-midpoint:${i}`,
					worldX: w.x,
					worldY: w.y,
					handleType: "linear-midpoint",
					color: UI_THEME.colors.gradientOutlineDefault,
					selected: false,
				});
			}
		} else if (isRadialGradient(fill)) {
			const center = boundsRelativeToWorld(
				fill.cx,
				fill.cy,
				bounds,
				rotationRad,
			);

			// Calculate rotated axes
			const totalRotation = rotationRad + fill.rotation;
			const cosR = Math.cos(totalRotation);
			const sinR = Math.sin(totalRotation);

			// radiusX handle (along rotated X-axis)
			const radiusXLocalX = fill.radiusX;
			const radiusXLocalY = 0;
			const radiusXBounds = {
				x: fill.cx + radiusXLocalX * cosR - radiusXLocalY * sinR,
				y: fill.cy + radiusXLocalX * sinR + radiusXLocalY * cosR,
			};
			const radiusXPoint = boundsRelativeToWorld(
				radiusXBounds.x,
				radiusXBounds.y,
				bounds,
				rotationRad,
			);

			// radiusY handle (along rotated Y-axis)
			const radiusYLocalX = 0;
			const radiusYLocalY = fill.radiusY;
			const radiusYBounds = {
				x: fill.cx + radiusYLocalX * cosR - radiusYLocalY * sinR,
				y: fill.cy + radiusYLocalX * sinR + radiusYLocalY * cosR,
			};
			const radiusYPoint = boundsRelativeToWorld(
				radiusYBounds.x,
				radiusYBounds.y,
				bounds,
				rotationRad,
			);

			// Rotation handle (at average radius distance, 45° from X-axis)
			const avgRadius = (fill.radiusX + fill.radiusY) / 2;
			const rotHandleAngle = totalRotation + Math.PI / 4;
			const rotHandleBounds = {
				x: fill.cx + avgRadius * Math.cos(rotHandleAngle),
				y: fill.cy + avgRadius * Math.sin(rotHandleAngle),
			};
			const rotationPoint = boundsRelativeToWorld(
				rotHandleBounds.x,
				rotHandleBounds.y,
				bounds,
				rotationRad,
			);

			// CRITICAL: Offset handles BEYOND ColorStop range
			// - Center handle: move INWARD (negative offset, like translate(-100%))
			// - Radius handles: move OUTWARD (positive offset, beyond offset=1)
			const handleOffset = 24;

			// Calculate unit vectors for each axis
			const dxX = radiusXPoint.x - center.x;
			const dyX = radiusXPoint.y - center.y;
			const lenX = Math.sqrt(dxX * dxX + dyX * dyX);
			const nxX = lenX > 0 ? dxX / lenX : 1;
			const nyX = lenX > 0 ? dyX / lenX : 0;

			const dxY = radiusYPoint.x - center.x;
			const dyY = radiusYPoint.y - center.y;
			const lenY = Math.sqrt(dxY * dxY + dyY * dyY);
			const nxY = lenY > 0 ? dxY / lenY : 0;
			const nyY = lenY > 0 ? dyY / lenY : 1;

			const dxRot = rotationPoint.x - center.x;
			const dyRot = rotationPoint.y - center.y;
			const lenRot = Math.sqrt(dxRot * dxRot + dyRot * dyRot);
			const nxRot = lenRot > 0 ? dxRot / lenRot : Math.SQRT1_2;
			const nyRot = lenRot > 0 ? dyRot / lenRot : Math.SQRT1_2;

			// Determine offset direction: center moves inward, others move outward
			const centerOffsetX = -nxX * handleOffset; // INWARD (toward negative offset)
			const centerOffsetY = -nyX * handleOffset;
			const radiusXOffsetX = nxX * handleOffset; // OUTWARD (beyond offset=1)
			const radiusXOffsetY = nyX * handleOffset;
			const radiusYOffsetX = nxY * handleOffset;
			const radiusYOffsetY = nyY * handleOffset;

			handles.push(
				{
					id: "radial-center",
					worldX: center.x + centerOffsetX, // INWARD offset (negative direction)
					worldY: center.y + centerOffsetY,
					handleType: "radial-center",
					color: UI_THEME.colors.gradientRadialCenterHandle,
					selected: false,
				},
				{
					id: "radial-radius-x",
					worldX: radiusXPoint.x + radiusXOffsetX, // OUTWARD offset (beyond offset=1)
					worldY: radiusXPoint.y + radiusXOffsetY,
					handleType: "radial-radius",
					color: UI_THEME.colors.gradientRadialXHandle,
					selected: false,
				},
				{
					id: "radial-radius-y",
					worldX: radiusYPoint.x + radiusYOffsetX, // OUTWARD offset (beyond offset=1)
					worldY: radiusYPoint.y + radiusYOffsetY,
					handleType: "radial-radius",
					color: UI_THEME.colors.gradientRadialYHandle,
					selected: false,
				},
				{
					id: "radial-rotation",
					worldX: rotationPoint.x + nxRot * handleOffset,
					worldY: rotationPoint.y + nyRot * handleOffset,
					handleType: "radial-rotation",
					color: UI_THEME.colors.gradientRadialRotationHandle,
					selected: false,
				},
			);

			// ColorStop handles along rotated X-axis
			for (let i = 0; i < fill.stops.length; i++) {
				const stop = fill.stops[i];
				const t = stop.offset;
				const stopLocalX = fill.radiusX * t;
				const stopLocalY = 0;
				const stopBounds = {
					x: fill.cx + stopLocalX * cosR - stopLocalY * sinR,
					y: fill.cy + stopLocalX * sinR + stopLocalY * cosR,
				};
				const w = boundsRelativeToWorld(
					stopBounds.x,
					stopBounds.y,
					bounds,
					rotationRad,
				);
				const { r, g, b, a } = colorToRawRGBA(stop.color);
				handles.push({
					id: `radial-stop:${i}`,
					worldX: w.x,
					worldY: w.y,
					handleType: "radial-stop",
					color: [r, g, b, a],
					selected: this.selectedStopIndex === i,
				});
			}

			// Midpoint handles between adjacent stops, along the same rotated
			// X-axis the stop handles use.
			for (let i = 0; i < fill.stops.length - 1; i++) {
				const s0 = fill.stops[i];
				const s1 = fill.stops[i + 1];
				const t = s0.offset + s0.midpoint * (s1.offset - s0.offset);
				const midLocalX = fill.radiusX * t;
				const midLocalY = 0;
				const midBounds = {
					x: fill.cx + midLocalX * cosR - midLocalY * sinR,
					y: fill.cy + midLocalX * sinR + midLocalY * cosR,
				};
				const w = boundsRelativeToWorld(
					midBounds.x,
					midBounds.y,
					bounds,
					rotationRad,
				);
				handles.push({
					id: `radial-midpoint:${i}`,
					worldX: w.x,
					worldY: w.y,
					handleType: "radial-midpoint",
					color: UI_THEME.colors.gradientOutlineDefault,
					selected: false,
				});
			}
		} else if (isFreeGradient(fill)) {
			// CP handles first (drawn below stops) — only for Delaunay-adjacent neighbors
			if (this.selectedStopId) {
				const selIdx = fill.stops.findIndex(
					(s) => s.id === this.selectedStopId,
				);
				const selectedStop = selIdx >= 0 ? fill.stops[selIdx] : null;
				if (selectedStop) {
					const adj = delaunayAdjacency(fill.stops);
					const neighbors = adj.get(selIdx) ?? new Set();
					for (const ni of neighbors) {
						const neighbor = fill.stops[ni];
						const cp =
							selectedStop.edgeCPs?.[neighbor.id] ??
							defaultEdgeCP(selectedStop, neighbor);
						const cpWorld = boundsRelativeToWorld(
							cp.x,
							cp.y,
							bounds,
							rotationRad,
						);
						handles.push({
							id: `cp:${this.selectedStopId}:${neighbor.id}`,
							worldX: cpWorld.x,
							worldY: cpWorld.y,
							handleType: "free-cp",
							color: UI_THEME.colors.gradientFreeCp,
							selected: false,
						});
					}
				}
			}

			// Stop handles (drawn on top)
			for (const stop of fill.stops) {
				const w = boundsRelativeToWorld(stop.x, stop.y, bounds, rotationRad);
				const { r, g, b, a } = colorToRawRGBA(stop.color);
				handles.push({
					id: stop.id,
					worldX: w.x,
					worldY: w.y,
					handleType: "free-stop",
					color: [r, g, b, a],
					selected: stop.id === this.selectedStopId,
				});
			}
		} else if (isMeshGradient(fill)) {
			// Vertex handles: one per vertex, colored (white if derived).
			fill.vertices.forEach((v, idx) => {
				if (v.hidden) return;
				const w = boundsRelativeToWorld(v.x, v.y, bounds, rotationRad);
				const { r, g, b, a } = colorToRawRGBA(v.color);
				const isDerived = v.colorMode === "derived";
				handles.push({
					id: `mesh-vertex:${idx}`,
					worldX: w.x,
					worldY: w.y,
					handleType: "mesh-vertex",
					color: [r, g, b, a],
					selected: this.selectedStopId === `mesh-vertex:${idx}`,
					isDerived,
				});
			});

			// CP handles: only for the selected vertex's incident edges, matching
			// the prototype's UX. For each neighbor, show both the outgoing CP
			// (from selected vertex toward neighbor) and the incoming CP (from
			// neighbor toward selected vertex).
			const selectedVi = this.selectedStopId?.startsWith("mesh-vertex:")
				? Number.parseInt(this.selectedStopId.split(":")[1], 10)
				: null;
			if (
				selectedVi !== null &&
				Number.isFinite(selectedVi) &&
				fill.vertices[selectedVi]
			) {
				for (const { ownerIdx, neighborIdx, cp } of collectMeshCPHandles(
					fill.vertices,
					fill.faces,
					selectedVi,
				)) {
					const cpWorld = boundsRelativeToWorld(
						cp.x,
						cp.y,
						bounds,
						rotationRad,
					);
					handles.push({
						id: `mesh-cp:${ownerIdx}:${neighborIdx}`,
						worldX: cpWorld.x,
						worldY: cpWorld.y,
						handleType: "mesh-cp",
						color: UI_THEME.colors.gradientFreeCp,
						selected: false,
					});
				}
			}
		}

		return handles;
	}

	/**
	 * Double-click on a derived vertex promotes it to explicit — the same
	 * promotion assigning a color performs, minus the color change. A vertex
	 * hit always wins over the face beneath it, so a double-click on any
	 * vertex never subdivides.
	 */
	private promoteMeshGradientVertexAt(
		fill: MeshGradient,
		vertexIndex: number,
	): void {
		const vertex = fill.vertices[vertexIndex];
		if (!vertex || vertex.colorMode !== "derived") return;
		const vertices = fill.vertices.map((v, i) =>
			i === vertexIndex
				? {
						...v,
						colorMode: "explicit" as const,
						colorSource: undefined,
						positionSource: undefined,
						meshSource: undefined,
					}
				: v,
		);
		this.setSelectedStop(`mesh-vertex:${vertexIndex}`);
		this.context.updateFill({ ...fill, vertices });
		this.updateUI();
	}

	/**
	 * Double-click near a mesh edge: insert a vertex on it with a
	 * single-direction cut, promoted so the user owns it right away — the
	 * cage editor's edge insert, on the gradient mesh.
	 * @returns true when an edge was within tolerance and was split.
	 */
	private splitMeshGradientEdgeAt(
		fill: MeshGradient,
		rel: { x: number; y: number },
		bounds: BoundingBox,
		rotationRad: number,
		viewport: Viewport,
	): boolean {
		const clickWorld = boundsRelativeToWorld(rel.x, rel.y, bounds, rotationRad);
		const best = findClosestMeshEdgePoint(
			fill.vertices,
			fill.faces,
			rel,
			(onEdge) => {
				const w = boundsRelativeToWorld(
					onEdge.x,
					onEdge.y,
					bounds,
					rotationRad,
				);
				return (
					Math.hypot(w.x - clickWorld.x, w.y - clickWorld.y) * viewport.zoom
				);
			},
		);
		if (!best || best.dist > GradientTool.MESH_EDGE_SPLIT_TOLERANCE_PX) {
			return false;
		}

		// Map the edge parameter to the face's logical axis: edges 0/2 run
		// along u (t / 1-t), edges 1/3 along v. The other coordinate is pinned
		// to the clicked edge so the cut inserts the vertex there.
		const value = best.edgeIdx <= 1 ? best.t : 1 - best.t;
		const isU = best.edgeIdx % 2 === 0;
		const clickU = isU ? value : best.edgeIdx === 1 ? 1 : 0;
		const clickV = isU ? (best.edgeIdx === 0 ? 0 : 1) : value;
		const result = this.subdivideMeshGradient(
			fill,
			best.faceIdx,
			clickU,
			clickV,
			isU ? { u: true } : { v: true },
		);
		if (!result) return false;
		syncDerivedVertices(result.vertices, result.faces);
		// The vertex the user placed is theirs: explicit from the start, like
		// the cage editor's edge insert.
		const inserted = result.vertices[result.centerIdx];
		result.vertices[result.centerIdx] = {
			...inserted,
			colorMode: "explicit",
			colorSource: undefined,
			positionSource: undefined,
			meshSource: undefined,
		};
		this.setSelectedStop(`mesh-vertex:${result.centerIdx}`);
		this.context.updateFill({
			...fill,
			vertices: result.vertices,
			faces: result.faces,
		});
		this.updateUI();
		return true;
	}

	private subdivideMeshGradientFaceAt(
		fill: MeshGradient,
		relX: number,
		relY: number,
	): void {
		for (let fi = 0; fi < fill.faces.length; fi++) {
			const face = fill.faces[fi];
			if (face.type !== "quad") continue;
			if (!pointInBezierFace(fill.vertices, fill.faces, face, relX, relY))
				continue;

			const { u, v } = bilinearUV(fill.vertices, face.verts, relX, relY);
			const result = this.subdivideMeshGradient(fill, fi, u, v);
			if (!result) return;
			syncDerivedVertices(result.vertices, result.faces);
			const updated: MeshGradient = {
				...fill,
				vertices: result.vertices,
				faces: result.faces,
			};
			this.context.updateFill(updated);
			this.updateUI();
			return;
		}
	}

	/** subdivideFace with the gradient vertex factories, optionally one-axis. */
	private subdivideMeshGradient(
		fill: MeshGradient,
		faceIdx: number,
		clickU: number,
		clickV: number,
		cutAxes?: { u?: boolean; v?: boolean },
	): ReturnType<typeof subdivideFace<MeshGradientVertex>> {
		let nextId = nextSplitLineId(fill.vertices);
		return subdivideFace<MeshGradientVertex>(
			fill.vertices,
			fill.faces,
			faceIdx,
			clickU,
			clickV,
			{
				// Clicked location becomes an explicit vertex whose color is
				// seeded from a Coons evaluation at (u, v) so the initial look
				// matches the gradient.
				makeCenterExplicit: (position, faceVerts, cu, cv) => ({
					x: position.x,
					y: position.y,
					color: colorFromFaceCorners(fill.vertices, faceVerts, cu, cv),
					colorMode: "explicit",
					handles: {},
				}),
				makeEdgeDerived: (position, edgeVerts, t) =>
					createEdgeDerivedMeshGradientVertex(
						fill.vertices,
						position,
						edgeVerts,
						t,
					),
				makeQuadDerived: (position, faceVerts, qu, qv) =>
					createQuadDerivedColorVertex<MeshGradientVertex>(
						fill.vertices,
						position,
						faceVerts,
						qu,
						qv,
						(fields) => ({
							x: fields.x,
							y: fields.y,
							color: fields.color,
							colorMode: fields.colorMode,
							colorSource: fields.colorSource,
							handles: fields.handles,
						}),
					),
				nextSplitLineId: () => nextId++,
				cutAxes,
			},
		);
	}

	private updateUI(): void {
		const element = this.context.getSelectedElement();
		const bounds = this.context.getSelectedElementBounds();
		const uiFill =
			(this.dragState.mode === "dragging"
				? this.dragState.pendingFill
				: undefined) ?? getElementFill(element);

		if (!uiFill || !bounds || isSolidColor(uiFill)) {
			this.updateGradientOverlay(null);
			return;
		}
		const rotationRad = getElementRotationRad(element);
		const handles = this.buildHandles(uiFill, bounds, rotationRad);

		const lines: GradientEditUIData["lines"] = [];
		const circles: GradientEditUIData["circles"] = [];
		const ellipses: GradientEditUIData["ellipses"] = [];
		const bezierEdges: NonNullable<GradientEditUIData["bezierEdges"]> = [];

		if (isLinearGradient(uiFill)) {
			const start = boundsRelativeToWorld(
				uiFill.x1,
				uiFill.y1,
				bounds,
				rotationRad,
			);
			const end = boundsRelativeToWorld(
				uiFill.x2,
				uiFill.y2,
				bounds,
				rotationRad,
			);
			lines.push({
				x1: start.x,
				y1: start.y,
				x2: end.x,
				y2: end.y,
				color: UI_THEME.colors.gradientOutlineDefault,
				width: UI_THEME.strokeWidth.gradientAxis,
				outlined: true,
			});
		} else if (isRadialGradient(uiFill)) {
			const center = boundsRelativeToWorld(
				uiFill.cx,
				uiFill.cy,
				bounds,
				rotationRad,
			);

			// Draw ellipse with rotation
			const totalRotation = rotationRad + uiFill.rotation;
			const radiusXWorld = uiFill.radiusX * bounds.width;
			const radiusYWorld = uiFill.radiusY * bounds.height;

			ellipses.push({
				centerX: center.x,
				centerY: center.y,
				radiusX: radiusXWorld,
				radiusY: radiusYWorld,
				rotation: totalRotation,
				color: UI_THEME.colors.gradientLine,
				width: UI_THEME.strokeWidth.path,
			});

			// Draw lines from center to each ColorStop along radiusX axis
			const cosR = Math.cos(totalRotation);
			const sinR = Math.sin(totalRotation);
			for (const stop of uiFill.stops) {
				const t = stop.offset;
				// ColorStops are positioned along the rotated X-axis at offset distance
				const stopLocalX = t; // offset in bounds-relative space (0.0-1.0)
				const stopLocalY = 0;
				const stopBounds = {
					x: uiFill.cx + stopLocalX * uiFill.radiusX * cosR - stopLocalY * sinR,
					y: uiFill.cy + stopLocalX * uiFill.radiusX * sinR + stopLocalY * cosR,
				};
				const stopWorld = boundsRelativeToWorld(
					stopBounds.x,
					stopBounds.y,
					bounds,
					rotationRad,
				);
				lines.push({
					x1: center.x,
					y1: center.y,
					x2: stopWorld.x,
					y2: stopWorld.y,
					color: UI_THEME.colors.gradientOutlineDefault,
					width: UI_THEME.strokeWidth.gradientAxis,
					outlined: true,
				});
			}
		} else if (isMeshGradient(uiFill)) {
			const selectedVi = this.selectedStopId?.startsWith("mesh-vertex:")
				? Number.parseInt(this.selectedStopId.split(":")[1], 10)
				: null;
			for (const { i, j, curve } of collectMeshEdgeCurves(
				uiFill.vertices,
				uiFill.faces,
			)) {
				{
					const boundary = getBoundarySegmentInfo(
						uiFill.vertices,
						uiFill.faces,
						i,
						j,
					);
					const [startP, hi, hj, endP] = curve;
					const toWorld = (p: { x: number; y: number }) =>
						boundsRelativeToWorld(p.x, p.y, bounds, rotationRad);
					const highlighted =
						selectedVi !== null && (i === selectedVi || j === selectedVi);
					bezierEdges.push({
						start: toWorld(startP),
						cp1: toWorld(hi),
						cp2: toWorld(hj),
						end: toWorld(endP),
						boundary: boundary != null,
						highlighted,
					});
				}
			}

			// cp-lines: line from each selected-incident vertex to its CP handle
			if (selectedVi !== null && uiFill.vertices[selectedVi]) {
				for (const { ownerIdx, cp } of collectMeshCPHandles(
					uiFill.vertices,
					uiFill.faces,
					selectedVi,
				)) {
					const owner = uiFill.vertices[ownerIdx];
					const ownerW = boundsRelativeToWorld(
						owner.x,
						owner.y,
						bounds,
						rotationRad,
					);
					const cpW = boundsRelativeToWorld(cp.x, cp.y, bounds, rotationRad);
					lines.push({
						x1: ownerW.x,
						y1: ownerW.y,
						x2: cpW.x,
						y2: cpW.y,
						color: UI_THEME.colors.gradientFreeCp,
					});
				}
			}
		} else if (isFreeGradient(uiFill) && this.selectedStopId) {
			const selIdx = uiFill.stops.findIndex(
				(s) => s.id === this.selectedStopId,
			);
			const selectedStop = selIdx >= 0 ? uiFill.stops[selIdx] : null;
			if (selectedStop) {
				const stopWorld = boundsRelativeToWorld(
					selectedStop.x,
					selectedStop.y,
					bounds,
					rotationRad,
				);
				const adj = delaunayAdjacency(uiFill.stops);
				const neighbors = adj.get(selIdx) ?? new Set();
				for (const ni of neighbors) {
					const neighbor = uiFill.stops[ni];
					const cp =
						selectedStop.edgeCPs?.[neighbor.id] ??
						defaultEdgeCP(selectedStop, neighbor);
					const cpWorld = boundsRelativeToWorld(
						cp.x,
						cp.y,
						bounds,
						rotationRad,
					);
					lines.push({
						x1: stopWorld.x,
						y1: stopWorld.y,
						x2: cpWorld.x,
						y2: cpWorld.y,
						color: UI_THEME.colors.gradientStopConnection,
					});
				}
			}
		}

		this.updateGradientOverlay({
			handles,
			lines,
			circles,
			ellipses,
			bezierEdges,
		});
	}
}

function nextSplitLineId(vertices: readonly MeshGradientVertex[]): number {
	let max = 0;
	for (const v of vertices) {
		if (v.splitLineId != null && v.splitLineId > max) max = v.splitLineId;
	}
	return max + 1;
}

function createEdgeDerivedMeshGradientVertex(
	vertices: readonly MeshGradientVertex[],
	position: { x: number; y: number },
	edgeVerts: readonly number[],
	t: number,
): MeshGradientVertex {
	return createEdgeDerivedColorVertex<MeshGradientVertex>(
		vertices,
		position,
		edgeVerts,
		t,
		(fields) => ({
			x: fields.x,
			y: fields.y,
			color: fields.color,
			colorMode: fields.colorMode,
			colorSource: fields.colorSource,
			positionSource: fields.positionSource,
			meshSource: fields.meshSource,
			handles: fields.handles,
		}),
	);
}

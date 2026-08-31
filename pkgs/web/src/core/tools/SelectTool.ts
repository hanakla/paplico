/**
 * Selection Tool
 * Allows selecting, moving, and resizing elements on the canvas
 * Supports marquee (drag-to-select) functionality
 */

import { buildMarqueeOverlay } from "../renderer/ui/builders/marquee";
import { buildSnapLineOverlay } from "../renderer/ui/builders/snapLine";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type {
	MarqueeSelectionUIData,
	SelectionUIData,
	SnapLine,
} from "../renderer/ui/types";
import {
	type AnyArtObject,
	type BoundingBox,
	type Extrude3DParams,
	isContainer,
	isReference3D,
	isRepeat,
	isText,
	type RepeatObject,
	type Solid3DBaseParams,
	type Vec3,
	type Viewport,
} from "../schema";
import {
	brandWorldBBox,
	calculateRepeatSourceUnion,
	pointInPolygon,
	translateBounds,
	type WorldBBox,
} from "../utils/geometry/bounds";
import {
	screenToWorld,
	toWorld,
	type WorldBezierSegment,
} from "../utils/geometry/geometry";
import {
	applyAffineToPoint,
	elementTransformToAffine,
	invertAffine,
} from "../utils/geometry/repeatInterpolation";
import {
	collectSelectionOutlines,
	shouldDashSelectionBounds,
} from "../utils/geometry/selectionOutlines";
import {
	buildExtrudeGizmoPrimitives,
	createExtrudeGizmoFrame,
	type ExtrudeGizmoFrame,
	type ExtrudeGizmoHandle,
	extrudeDepthAxis,
	extrudeRingPoints,
	resolveSolid3DTarget,
	ringOrientationSign,
	wrapAngleDeg,
} from "./extrudeGizmo";
import {
	buildRepeatGridGizmo,
	buildRepeatRadialGizmo,
} from "./repeatGridGizmo";
import {
	calculateResizedBounds,
	createResizeHandles,
	createRotationHandle,
	getResizeCursor,
	getResizeSnapTargets,
	hitTestResizeHandle,
	hitTestRotationHandle,
	type ResizeHandle,
} from "./resizeHandleHelper";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

type DragState =
	| { mode: "idle" }
	| {
			mode: "pending";
			hitElement: { id: string; bounds: WorldBBox } | null;
			dragStartX: number;
			dragStartY: number;
			pointerType: "mouse" | "pen" | "touch";
	  }
	| {
			mode: "move";
			dragStartX: number;
			dragStartY: number;
			originalBounds: WorldBBox;
			hasDuplicatedForAltDrag: boolean;
			hasPreviewDelta: boolean;
			lastPreviewDeltaX: number;
			lastPreviewDeltaY: number;
	  }
	| {
			mode: "resize";
			dragStartX: number;
			dragStartY: number;
			originalBounds: WorldBBox;
			activeHandle: ResizeHandle;
			lastPreviewBounds: BoundingBox | null;
	  }
	| {
			mode: "rotate";
			dragStartX: number;
			dragStartY: number;
			originalBounds: WorldBBox;
			rotationStartAngle: number;
			rotationCenter: { x: number; y: number };
	  }
	| {
			mode: "marquee";
			dragStartX: number;
			dragStartY: number;
	  }
	| {
			mode: "pending-lasso";
			dragStartX: number;
			dragStartY: number;
	  }
	| {
			mode: "lasso";
			path: Array<{ x: number; y: number }>;
	  }
	| {
			mode: "extrude-rotate";
			filterIndex: number;
			startParams: Solid3DBaseParams;
			axisIndex: 0 | 1 | 2;
			/** Ring center in canvas-world coordinates (angle pivot). */
			center: { x: number; y: number };
			startPointerAngle: number;
			/** Maps a CCW pointer angle onto a positive axis rotation. */
			angleSign: 1 | -1;
	  }
	| {
			mode: "extrude-depth";
			filterIndex: number;
			startParams: Extrude3DParams;
			/** Canvas-world direction the back cap moves per +1 depth. */
			axisDir: { x: number; y: number };
			/** Canvas-world units per +1 depth unit. */
			unitPerDepth: number;
			startPointer: { x: number; y: number };
	  }
	| {
			mode: "repeat-grid";
			repeatId: string;
			handle: "region" | "spacing-x" | "spacing-y";
			startWorld: { x: number; y: number };
			startWidth: number;
			startHeight: number;
			startSpacingX: number;
			startSpacingY: number;
	  }
	| {
			mode: "repeat-radial";
			repeatId: string;
			handle: "radius" | "sweep" | "count";
			startWorld: { x: number; y: number };
			center: { x: number; y: number };
			startCount: number;
			startRadius: number;
			startAngle: number;
			startSweep: number;
	  };

export class SelectTool implements Tool {
	public readonly name = "select";

	private context: ToolContext;
	private dragState: DragState = { mode: "idle" };
	private selectedBounds: WorldBBox | null = null;
	/** Extrude gizmo handle under the cursor (highlight + rebuilt on change). */
	private hoveredExtrudeHandle: ExtrudeGizmoHandle | null = null;
	private shiftKey = false;
	private altKey = false;
	private lastWorldX = 0;
	private lastWorldY = 0;
	private lastViewport: Viewport | null = null;

	public constructor(context: ToolContext) {
		this.context = context;
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		this.shiftKey = event.shiftKey;
		this.altKey = event.altKey;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const worldX = world.x;
		const worldY = world.y;

		// Check if clicking on a resize handle or rotation zone of selected elements
		const selectedIds = this.context.getSelectedElementIds();
		if (
			selectedIds.length > 0 &&
			this.selectedBounds &&
			!this.context.isReadonly()
		) {
			// Extrude gizmo first: its rings/handle sit on top of the box.
			const overlayHit = this.context.uiHitTest({ x: event.x, y: event.y });
			if (
				overlayHit?.overlayKey === OVERLAY_KEYS.selectExtrudeGizmo &&
				this.beginExtrudeGizmoDrag(
					overlayHit.hitId as ExtrudeGizmoHandle,
					{ x: worldX, y: worldY },
					viewport,
				)
			) {
				return;
			}

			// Repeat gizmo handles (grid region/spacing, radial radius/sweep/count).
			if (
				overlayHit?.overlayKey === OVERLAY_KEYS.repeatHandles &&
				this.beginRepeatGizmoDrag(overlayHit.hitId, { x: worldX, y: worldY })
			) {
				return;
			}

			// Check rotation zone first (outside corners)
			if (this.hitTestRotationZone(worldX, worldY, viewport)) {
				const cx = (this.selectedBounds.minX + this.selectedBounds.maxX) / 2;
				const cy = (this.selectedBounds.minY + this.selectedBounds.maxY) / 2;
				this.dragState = {
					mode: "rotate",
					dragStartX: worldX,
					dragStartY: worldY,
					originalBounds: { ...this.selectedBounds },
					rotationCenter: { x: cx, y: cy },
					rotationStartAngle: Math.atan2(worldY - cy, worldX - cx),
				};
				return;
			}

			const handle = this.hitTestHandle(worldX, worldY, viewport);
			if (handle) {
				this.dragState = {
					mode: "resize",
					dragStartX: worldX,
					dragStartY: worldY,
					originalBounds: { ...this.selectedBounds },
					activeHandle: handle,
					lastPreviewBounds: null,
				};
				return;
			}
		}

		// Get current layer
		const layer = this.context.getCurrentLayer();
		if (!layer) {
			this.context.selectionClear();
			this.selectedBounds = null;
			return;
		}

		let hitElement: { id: string; bounds: WorldBBox } | null = null;

		const tolerance = this.calculateTolerance(viewport);

		const element = this.context.findElementAtPoint(worldX, worldY, tolerance);
		if (element) {
			const elBounds = this.context.getBounds(element.id);
			if (elBounds) {
				const isEditable = this.context.isElementEditable(element.id);
				if (isEditable) {
					hitElement = { id: element.id, bounds: elBounds };
				}
			}
		}

		if (hitElement) {
			const alreadySelected = selectedIds.includes(hitElement.id);

			if (event.shiftKey) {
				// Shift+click: toggle selection (multi-select)
				this.context.elementToggleSelect(hitElement.id, hitElement.bounds);
				hitElement = null; // Don't change selection on pointerup for shift-click
			} else if (!alreadySelected) {
				// Normal click on unselected element: replace selection immediately,
				// but keep hitElement so a drag starting right here promotes to "move".
				this.context.elementSelect(hitElement.id, hitElement.bounds);
			}
			// else: Clicked on already-selected element without shift
			// hitElement is preserved for potential selection change on pointerup (if no drag)

			this.refreshUI();

			this.dragState = {
				mode: "pending",
				hitElement,
				dragStartX: worldX,
				dragStartY: worldY,
				pointerType: event.pointerType,
			};
		} else {
			if (!event.shiftKey) {
				this.context.selectionClear();
				this.selectedBounds = null;
			}

			this.dragState = {
				mode: "pending",
				hitElement: null,
				dragStartX: worldX,
				dragStartY: worldY,
				pointerType: event.pointerType,
			};
		}
	}

	public refreshUI(): void {
		this.refreshExtrudeGizmo();
		this.refreshRepeatGizmo();
		const selectedIds = this.context.getSelectedElementIds();

		if (selectedIds.length === 0) {
			this.selectedBounds = null;
			this.context.uiRefreshSelectionUI(true);
			return;
		}

		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		let hasBounds = false;
		for (const id of selectedIds) {
			const elBounds = this.context.getBounds(id);

			if (elBounds) {
				hasBounds = true;
				minX = Math.min(minX, elBounds.minX);
				minY = Math.min(minY, elBounds.minY);
				maxX = Math.max(maxX, elBounds.maxX);
				maxY = Math.max(maxY, elBounds.maxY);
			}
		}

		if (hasBounds) {
			this.selectedBounds = brandWorldBBox({
				minX,
				minY,
				maxX,
				maxY,
				width: maxX - minX,
				height: maxY - minY,
			});
		} else {
			this.selectedBounds = null;
		}

		this.context.uiRefreshSelectionUI(true);
	}

	/** The single selected Repeat, or null. */
	private currentRepeat(): RepeatObject | null {
		if (this.context.isReadonly()) return null;
		const ids = this.context.getSelectedElementIds();
		if (ids.length !== 1) return null;
		const el = this.context.getElement(ids[0]);
		return el && isRepeat(el) ? el : null;
	}

	/** Rebuild (or clear) the grid Repeat's fill-region + spacing handles. The grid
	 *  bounds == the clipped fill region, so the selection box already outlines it
	 *  and follows the continuous width/height — dragging the region handle reads
	 *  as filling a range, not stepping the count. Scaling is handled by the normal
	 *  selection resize box, so only grid mode adds these. */
	private refreshRepeatGizmo(): void {
		const repeat = this.currentRepeat();
		if (!repeat) {
			this.context.uiSetOverlay(OVERLAY_KEYS.repeatHandles, null);
			return;
		}
		const zoom = this.context.getViewport()?.viewport.zoom ?? 1;

		if (repeat.mode === "grid") {
			const bounds = this.context.getBounds(repeat.id);
			if (!bounds) {
				this.context.uiSetOverlay(OVERLAY_KEYS.repeatHandles, null);
				return;
			}
			this.context.uiSetOverlay(OVERLAY_KEYS.repeatHandles, {
				primitives: buildRepeatGridGizmo(bounds, zoom),
			});
			return;
		}

		if (repeat.mode === "radial") {
			const union = calculateRepeatSourceUnion(
				repeat,
				this.repeatElementsMap(),
			);
			if (!union) {
				this.context.uiSetOverlay(OVERLAY_KEYS.repeatHandles, null);
				return;
			}
			const center = {
				x: (union.minX + union.maxX) / 2,
				y: (union.minY + union.maxY) / 2,
			};
			const affine = elementTransformToAffine(
				repeat.transform,
				center.x,
				center.y,
			);
			this.context.uiSetOverlay(OVERLAY_KEYS.repeatHandles, {
				primitives: buildRepeatRadialGizmo(repeat, center, affine, zoom),
			});
			return;
		}

		// Mirror: no on-canvas handles yet (edited via the ActionsPanel).
		this.context.uiSetOverlay(OVERLAY_KEYS.repeatHandles, null);
	}

	private beginRepeatGizmoDrag(
		hitId: string,
		world: { x: number; y: number },
	): boolean {
		const repeat = this.currentRepeat();
		if (!repeat) return false;

		if (repeat.mode === "grid") {
			const handle =
				hitId === "grid-region"
					? "region"
					: hitId === "grid-spacing-x"
						? "spacing-x"
						: hitId === "grid-spacing-y"
							? "spacing-y"
							: null;
			if (!handle) return false;
			this.dragState = {
				mode: "repeat-grid",
				repeatId: repeat.id,
				handle,
				startWorld: world,
				startWidth: repeat.grid.width,
				startHeight: repeat.grid.height,
				startSpacingX: repeat.grid.spacingX,
				startSpacingY: repeat.grid.spacingY,
			};
			return true;
		}

		if (repeat.mode === "radial") {
			const handle =
				hitId === "radial-radius"
					? "radius"
					: hitId === "radial-sweep"
						? "sweep"
						: hitId === "radial-count"
							? "count"
							: null;
			if (!handle) return false;
			const union = calculateRepeatSourceUnion(
				repeat,
				this.repeatElementsMap(),
			);
			if (!union) return false;
			this.dragState = {
				mode: "repeat-radial",
				repeatId: repeat.id,
				handle,
				startWorld: world,
				center: {
					x: (union.minX + union.maxX) / 2,
					y: (union.minY + union.maxY) / 2,
				},
				startCount: repeat.radial.count,
				startRadius: repeat.radial.radius,
				startAngle: repeat.radial.startAngle,
				startSweep: repeat.radial.sweep,
			};
			return true;
		}

		return false;
	}

	private handleRepeatRadialDrag(
		state: Extract<DragState, { mode: "repeat-radial" }>,
		worldX: number,
		worldY: number,
	): void {
		const { repeatId, handle, startWorld, center, startCount, startAngle } =
			state;
		const repeat = this.currentRepeat();
		if (!repeat) return;
		const inv = invertAffine(
			elementTransformToAffine(repeat.transform, center.x, center.y),
		);

		if (handle === "count") {
			// Drag horizontally at the center: ~24 world units per copy.
			const count = clampRadialCount(
				startCount + Math.round((worldX - startWorld.x) / 24),
			);
			this.context.transact((c) => c.updateRepeatRadial(repeatId, { count }));
			this.refreshRepeatGizmo();
			return;
		}

		// radius / sweep: the pointer angle about the center (0 = up), and its
		// distance for the radius.
		const p = applyAffineToPoint(inv, { x: worldX, y: worldY });
		const dx = p.x - center.x;
		const dy = p.y - center.y;
		const angle = Math.atan2(dx, -dy);
		if (handle === "radius") {
			const radius = Math.max(1, Math.hypot(dx, dy));
			if (this.shiftKey) {
				// Shift locks the drag to one axis: change either the radius or the
				// rotation angle, whichever the pointer has moved more (radial vs
				// tangential displacement measured from the grab point).
				const sp = applyAffineToPoint(inv, startWorld);
				const startRadius = Math.hypot(sp.x - center.x, sp.y - center.y);
				let dAngle = angle - Math.atan2(sp.x - center.x, -(sp.y - center.y));
				while (dAngle > Math.PI) dAngle -= Math.PI * 2;
				while (dAngle < -Math.PI) dAngle += Math.PI * 2;
				if (Math.abs(radius - startRadius) >= Math.abs(startRadius * dAngle)) {
					this.context.transact((c) =>
						c.updateRepeatRadial(repeatId, { radius }),
					);
				} else {
					this.context.transact((c) =>
						c.updateRepeatRadial(repeatId, { startAngle: angle }),
					);
				}
			} else {
				this.context.transact((c) =>
					c.updateRepeatRadial(repeatId, { radius, startAngle: angle }),
				);
			}
		} else {
			// Sweep: the last copy reaches the pointer angle (measured from start).
			let sweep = angle - startAngle;
			while (sweep <= 0) sweep += Math.PI * 2;
			while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
			this.context.transact((c) => c.updateRepeatRadial(repeatId, { sweep }));
		}
		this.refreshRepeatGizmo();
	}

	private handleRepeatGridDrag(
		state: Extract<DragState, { mode: "repeat-grid" }>,
		worldX: number,
		worldY: number,
	): void {
		const {
			repeatId,
			handle,
			startWorld,
			startWidth,
			startHeight,
			startSpacingX,
			startSpacingY,
		} = state;
		if (handle === "spacing-x" || handle === "spacing-y") {
			if (handle === "spacing-x") {
				const spacingX = Math.max(1, startSpacingX + (worldX - startWorld.x));
				this.context.transact((c) =>
					c.updateRepeatGrid(repeatId, { spacingX }),
				);
			} else {
				// Row gap grows downward (screen), i.e. -y.
				const spacingY = Math.max(1, startSpacingY + (startWorld.y - worldY));
				this.context.transact((c) =>
					c.updateRepeatGrid(repeatId, { spacingY }),
				);
			}
			this.refreshRepeatGizmo();
			return;
		}

		// Fill-region resize: measure the drag in the source's authored space (undo
		// the repeat's own transform) and add the delta to the start width/height,
		// so the offset handle grows the region without a jump on grab. The region
		// extends right/down (world Y-up, so down = -y).
		const repeat = this.currentRepeat();
		const union = repeat
			? calculateRepeatSourceUnion(repeat, this.repeatElementsMap())
			: null;
		if (!repeat || !union) return;
		const center = {
			x: (union.minX + union.maxX) / 2,
			y: (union.minY + union.maxY) / 2,
		};
		const inv = invertAffine(
			elementTransformToAffine(repeat.transform, center.x, center.y),
		);
		const authoredStart = applyAffineToPoint(inv, startWorld);
		const authoredNow = applyAffineToPoint(inv, { x: worldX, y: worldY });
		const width = Math.max(0, startWidth + (authoredNow.x - authoredStart.x));
		const height = Math.max(0, startHeight + (authoredStart.y - authoredNow.y));
		this.context.transact((c) =>
			c.updateRepeatGrid(repeatId, { width, height }),
		);
		this.refreshRepeatGizmo();
	}

	private repeatElementsMap(): ReadonlyMap<string, AnyArtObject> {
		return new Map(Object.entries(this.context.getObjects()));
	}

	/** Rebuild (or clear) the 3D solid gizmo for the current single selection.
	 *  `paramsOverride` lets drags preview without re-reading the document. */
	private refreshExtrudeGizmo(paramsOverride?: Solid3DBaseParams): void {
		const current = this.currentExtrudeFrame(paramsOverride);
		if (!current) {
			this.context.uiSetOverlay(OVERLAY_KEYS.selectExtrudeGizmo, null);
			return;
		}
		const zoom = this.context.getViewport()?.viewport.zoom ?? 1;
		this.context.uiSetOverlay(OVERLAY_KEYS.selectExtrudeGizmo, {
			primitives: buildExtrudeGizmoPrimitives(
				current.frame,
				zoom,
				this.hoveredExtrudeHandle,
			),
		});
	}

	private currentExtrudeFrame(
		paramsOverride?: Solid3DBaseParams,
	): { frame: ExtrudeGizmoFrame; filterIndex: number } | null {
		if (this.context.isReadonly()) return null;
		const selectedIds = this.context.getSelectedElementIds();
		if (selectedIds.length !== 1) return null;
		const element = this.context.getElement(selectedIds[0]);
		if (!element) return null;
		const target = resolveSolid3DTarget(element);
		if (!target) return null;
		// A group sweeps a world-space outline; the gizmo needs its world bounds.
		const worldBounds =
			element.type === "group" ? this.context.getBounds(element.id) : null;
		const frame = createExtrudeGizmoFrame(
			element,
			{
				processor: target.processor,
				params: paramsOverride ?? target.params,
			},
			this.context.getAncestorTransform(element.id),
			worldBounds,
		);
		if (!frame) return null;
		return { frame, filterIndex: target.filterIndex };
	}

	private beginExtrudeGizmoDrag(
		handle: ExtrudeGizmoHandle,
		pointerWorld: { x: number; y: number },
		viewport: Viewport,
	): boolean {
		const current = this.currentExtrudeFrame();
		if (!current) return false;
		const { frame, filterIndex } = current;

		if (handle === "extrude-depth") {
			// The depth handle only exists on extrusion frames (frame.depth set),
			// so the params are Extrude3DParams here.
			const axis = extrudeDepthAxis(frame);
			if (!axis) return false;
			this.dragState = {
				mode: "extrude-depth",
				filterIndex,
				startParams: frame.params as Extrude3DParams,
				axisDir: axis.dir,
				unitPerDepth: axis.unitPerDepth,
				startPointer: pointerWorld,
			};
			return true;
		}

		const axisIndex = EXTRUDE_ROTATE_AXIS_INDEX[handle];
		const ring = extrudeRingPoints(frame, axisIndex, viewport.zoom);
		if (!ring) return false;
		const center = frame.centerCanvas;
		this.dragState = {
			mode: "extrude-rotate",
			filterIndex,
			startParams: frame.params,
			axisIndex,
			center,
			startPointerAngle: Math.atan2(
				pointerWorld.y - center.y,
				pointerWorld.x - center.x,
			),
			angleSign: ringOrientationSign(ring),
		};
		return true;
	}

	private handleExtrudeRotateDrag(
		state: Extract<DragState, { mode: "extrude-rotate" }>,
		worldX: number,
		worldY: number,
	): void {
		const angle = Math.atan2(worldY - state.center.y, worldX - state.center.x);
		const deltaDeg =
			wrapAngleDeg(((angle - state.startPointerAngle) * 180) / Math.PI) *
			state.angleSign;
		const rotationDeg: Vec3 = [...state.startParams.rotationDeg];
		rotationDeg[state.axisIndex] = wrapAngleDeg(
			rotationDeg[state.axisIndex] + deltaDeg,
		);
		this.context.updateSelectedElementFilter(state.filterIndex, {
			rotationDeg,
		});
		this.refreshExtrudeGizmo({ ...state.startParams, rotationDeg });
	}

	private handleExtrudeDepthDrag(
		state: Extract<DragState, { mode: "extrude-depth" }>,
		worldX: number,
		worldY: number,
	): void {
		const proj =
			(worldX - state.startPointer.x) * state.axisDir.x +
			(worldY - state.startPointer.y) * state.axisDir.y;
		const depth = Math.min(
			Math.max(state.startParams.depth + proj / state.unitPerDepth, 1),
			500,
		);
		this.context.updateSelectedElementFilter(state.filterIndex, { depth });
		const preview: Extrude3DParams = { ...state.startParams, depth };
		this.refreshExtrudeGizmo(preview);
	}

	/** Highlight the extrude gizmo handle under the cursor (no active drag). */
	private updateExtrudeGizmoHover(event: PointerEventData): void {
		const hit = this.context.uiHitTest({ x: event.x, y: event.y });
		const hovered =
			hit?.overlayKey === OVERLAY_KEYS.selectExtrudeGizmo
				? (hit.hitId as ExtrudeGizmoHandle)
				: null;
		if (hovered === this.hoveredExtrudeHandle) return;
		this.hoveredExtrudeHandle = hovered;
		this.refreshExtrudeGizmo();
		this.context.requestRender("selection");
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		// Track last known cursor position for hover cursor updates
		const hoverWorld = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		this.lastWorldX = hoverWorld.x;
		this.lastWorldY = hoverWorld.y;
		this.lastViewport = viewport;

		if (this.dragState.mode === "idle") {
			this.updateExtrudeGizmoHover(event);
			return;
		}

		this.shiftKey = event.shiftKey;
		this.altKey = event.altKey;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const worldX = world.x;
		const worldY = world.y;

		// Promote pending → move/marquee on threshold
		if (this.dragState.mode === "pending") {
			const deltaX = worldX - this.dragState.dragStartX;
			const deltaY = worldY - this.dragState.dragStartY;
			const thresholdWorld = this.calculateDragThreshold(
				this.dragState.pointerType,
				viewport.zoom,
			);
			const movedEnough =
				Math.abs(deltaX) > thresholdWorld || Math.abs(deltaY) > thresholdWorld;

			if (!movedEnough) return;

			const selectedIds = this.context.getSelectedElementIds();
			if (
				selectedIds.length > 0 &&
				this.selectedBounds &&
				this.dragState.hitElement &&
				!this.context.isReadonly()
			) {
				let moveOriginalBounds = { ...this.selectedBounds };
				let { dragStartX, dragStartY } = this.dragState;
				let hasDuplicatedForAltDrag = false;

				// Alt+drag: duplicate elements on first move
				if (this.altKey) {
					hasDuplicatedForAltDrag = true;
					const newIds = this.context.duplicateElements(selectedIds);
					this.context.selectionClear();
					for (const newId of newIds) {
						const elBounds = this.context.getBounds(newId);
						if (elBounds) {
							this.context.elementToggleSelect(newId, elBounds);
						}
					}
					this.refreshUI();
					dragStartX = worldX;
					dragStartY = worldY;
					moveOriginalBounds = this.selectedBounds
						? { ...this.selectedBounds }
						: moveOriginalBounds;
				}

				this.dragState = {
					mode: "move",
					dragStartX,
					dragStartY,
					originalBounds: moveOriginalBounds,
					hasDuplicatedForAltDrag,
					hasPreviewDelta: false,
					lastPreviewDeltaX: 0,
					lastPreviewDeltaY: 0,
				};
			} else {
				const selMode = this.context.selectGetSelectionMode();
				if (selMode === "lasso") {
					this.dragState = {
						mode: "pending-lasso",
						dragStartX: this.dragState.dragStartX,
						dragStartY: this.dragState.dragStartY,
					};
				} else {
					this.dragState = {
						mode: "marquee",
						dragStartX: this.dragState.dragStartX,
						dragStartY: this.dragState.dragStartY,
					};
				}
			}
		}

		if (this.dragState.mode === "pending-lasso") {
			const worldDist = Math.hypot(
				worldX - this.dragState.dragStartX,
				worldY - this.dragState.dragStartY,
			);
			if (worldDist * viewport.zoom > 3) {
				this.dragState = {
					mode: "lasso",
					path: [
						{ x: this.dragState.dragStartX, y: this.dragState.dragStartY },
						{ x: worldX, y: worldY },
					],
				};
				this.updateMarqueeOverlay({
					startX: 0,
					startY: 0,
					endX: 0,
					endY: 0,
					// Copy: the overlay sink freezes this array in dev builds, but
					// dragState.path keeps growing via push() on every pointer move.
					lassoPath: [...this.dragState.path],
				});
			}
			return;
		}

		if (this.dragState.mode === "lasso") {
			this.dragState.path.push({ x: worldX, y: worldY });
			this.handleLassoDrag(this.dragState, viewport);
			return;
		}

		const ds = this.dragState;
		switch (ds.mode) {
			case "move":
				this.handleMoveDrag(ds, worldX, worldY, viewport);
				break;
			case "resize":
				this.handleResizeDrag(ds, worldX, worldY, viewport);
				break;
			case "rotate":
				this.handleRotateDrag(
					ds,
					worldX,
					worldY,
					viewport,
					canvasWidth,
					canvasHeight,
				);
				break;
			case "marquee":
				this.handleMarqueeDrag(ds, worldX, worldY);
				break;
			case "extrude-rotate":
				this.handleExtrudeRotateDrag(ds, worldX, worldY);
				break;
			case "extrude-depth":
				this.handleExtrudeDepthDrag(ds, worldX, worldY);
				break;
			case "repeat-grid":
				this.handleRepeatGridDrag(ds, worldX, worldY);
				break;
			case "repeat-radial":
				this.handleRepeatRadialDrag(ds, worldX, worldY);
				break;
		}
	}

	private handleMoveDrag(
		state: Extract<DragState, { mode: "move" }>,
		worldX: number,
		worldY: number,
		viewport: Viewport,
	): void {
		let proposedDeltaX = worldX - state.dragStartX;
		let proposedDeltaY = worldY - state.dragStartY;

		if (this.shiftKey) {
			[proposedDeltaX, proposedDeltaY] = constrainAxis(
				proposedDeltaX,
				proposedDeltaY,
			);
		}

		const selectedIds = this.context.getSelectedElementIds();
		const snapResult = this.context.snapElements(
			selectedIds,
			state.originalBounds,
			proposedDeltaX,
			proposedDeltaY,
			viewport.zoom,
		) ?? { deltaX: proposedDeltaX, deltaY: proposedDeltaY, snapLines: [] };
		state.hasPreviewDelta = true;
		state.lastPreviewDeltaX = snapResult.deltaX;
		state.lastPreviewDeltaY = snapResult.deltaY;

		const newBounds = translateBounds(
			state.originalBounds,
			snapResult.deltaX,
			snapResult.deltaY,
		);

		const selectionUI = this.createSelectionUI(newBounds);
		this.context.uiUpdateSelectionUI(selectionUI);

		this.updateSnapLineOverlay(snapResult.snapLines);
	}

	private handleResizeDrag(
		state: Extract<DragState, { mode: "resize" }>,
		worldX: number,
		worldY: number,
		viewport: Viewport,
	): void {
		const rawBounds = calculateResizedBounds(
			state.originalBounds,
			state.activeHandle,
			worldX,
			worldY,
			state.dragStartX,
			state.dragStartY,
			this.shiftKey,
			this.altKey,
		);
		const snapped = this.snapResizedBounds(
			rawBounds,
			state.activeHandle,
			viewport.zoom,
		);
		state.lastPreviewBounds = snapped.bounds;

		const selectionUI = this.createSelectionUI(snapped.bounds);
		this.context.uiUpdateSelectionUI(selectionUI);

		this.updateSnapLineOverlay(snapped.snapLines);
	}

	/**
	 * Snap the handle-dragged edges of resized bounds to other elements and
	 * artboards, per axis. The selected elements themselves are excluded from
	 * the snap targets via snapElements.
	 */
	private snapResizedBounds(
		rawBounds: BoundingBox,
		handle: ResizeHandle,
		zoom: number,
	): { bounds: BoundingBox; snapLines: SnapLine[] } {
		const selectedIds = this.context.getSelectedElementIds();
		const targets = getResizeSnapTargets(handle);
		const snapLines: SnapLine[] = [];
		const bounds: BoundingBox = { ...rawBounds };

		if (targets.x !== "none") {
			const edge = targets.x === "min" ? bounds.minX : bounds.maxX;
			const xSnap = this.context.snapElements(
				selectedIds,
				brandWorldBBox({
					minX: edge,
					maxX: edge,
					minY: bounds.minY,
					maxY: bounds.maxY,
					width: 0,
					height: bounds.height,
				}),
				0,
				0,
				zoom,
			);
			if (targets.x === "min") {
				bounds.minX += xSnap.deltaX;
			} else {
				bounds.maxX += xSnap.deltaX;
			}
			bounds.width = bounds.maxX - bounds.minX;
			const verticalLine = xSnap.snapLines.find(
				(line) => line.axis === "vertical",
			);
			if (verticalLine) snapLines.push(verticalLine);
		}

		if (targets.y !== "none") {
			const edge = targets.y === "min" ? bounds.minY : bounds.maxY;
			const ySnap = this.context.snapElements(
				selectedIds,
				brandWorldBBox({
					minX: bounds.minX,
					maxX: bounds.maxX,
					minY: edge,
					maxY: edge,
					width: bounds.width,
					height: 0,
				}),
				0,
				0,
				zoom,
			);
			if (targets.y === "min") {
				bounds.minY += ySnap.deltaY;
			} else {
				bounds.maxY += ySnap.deltaY;
			}
			bounds.height = bounds.maxY - bounds.minY;
			const horizontalLine = ySnap.snapLines.find(
				(line) => line.axis === "horizontal",
			);
			if (horizontalLine) snapLines.push(horizontalLine);
		}

		return { bounds, snapLines };
	}

	private handleRotateDrag(
		state: Extract<DragState, { mode: "rotate" }>,
		worldX: number,
		worldY: number,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		const { x: cx, y: cy } = state.rotationCenter;
		const currentAngle = Math.atan2(worldY - cy, worldX - cx);
		let angleDelta = currentAngle - state.rotationStartAngle;

		// Shift key: snap to 15-degree increments
		if (this.shiftKey) {
			const snapRad = (15 * Math.PI) / 180;
			angleDelta = Math.round(angleDelta / snapRad) * snapRad;
		}

		const cos = Math.cos(angleDelta);
		const sin = Math.sin(angleDelta);

		const rotatePoint = (px: number, py: number) => ({
			x: cx + (px - cx) * cos - (py - cy) * sin,
			y: cy + (px - cx) * sin + (py - cy) * cos,
		});

		// Compute rotated AABB from original bounds corners
		const bbCorners = [
			rotatePoint(state.originalBounds.minX, state.originalBounds.minY),
			rotatePoint(state.originalBounds.maxX, state.originalBounds.minY),
			rotatePoint(state.originalBounds.maxX, state.originalBounds.maxY),
			rotatePoint(state.originalBounds.minX, state.originalBounds.maxY),
		];

		let rMinX = Infinity;
		let rMinY = Infinity;
		let rMaxX = -Infinity;
		let rMaxY = -Infinity;
		for (const c of bbCorners) {
			rMinX = Math.min(rMinX, c.x);
			rMinY = Math.min(rMinY, c.y);
			rMaxX = Math.max(rMaxX, c.x);
			rMaxY = Math.max(rMaxY, c.y);
		}

		const rotatedBounds: BoundingBox = {
			minX: rMinX,
			minY: rMinY,
			maxX: rMaxX,
			maxY: rMaxY,
			width: rMaxX - rMinX,
			height: rMaxY - rMinY,
		};

		// Build rotated path outlines for preview
		const pathSegments: SelectionUIData["pathSegments"] = [];
		const selectedIds = this.context.getSelectedElementIds();
		const rotateSegs = (segs: WorldBezierSegment[]) =>
			segs.map((ws) => {
				const rp = (p: { x: number; y: number }) => {
					const r = rotatePoint(p.x, p.y);
					return toWorld(r.x, r.y);
				};
				return {
					start: ws.start ? rp(ws.start) : undefined,
					cp1: rp(ws.cp1),
					cp2: rp(ws.cp2),
					end: rp(ws.end),
				};
			});
		for (const id of selectedIds) {
			const element = this.context.getElement(id);
			if (!element) continue;
			for (const outline of this.collectOutlines(element)) {
				pathSegments.push(rotateSegs(outline));
			}
		}

		const handles = createResizeHandles(rotatedBounds);
		this.context.uiUpdateSelectionUI({
			bounds: rotatedBounds,
			handles,
			rotationHandle: createRotationHandle(rotatedBounds, _viewport.zoom),
			pathSegments: pathSegments.length > 0 ? pathSegments : undefined,
			boundsDashed: shouldDashSelectionBounds(
				selectedIds.map((id) => this.context.getElement(id) ?? undefined),
			),
		});
	}

	private handleMarqueeDrag(
		state: Extract<DragState, { mode: "marquee" }>,
		worldX: number,
		worldY: number,
	): void {
		this.updateMarqueeOverlay({
			startX: state.dragStartX,
			startY: state.dragStartY,
			endX: worldX,
			endY: worldY,
		});

		// Find elements in marquee rect (for live preview)
		const minX = Math.min(state.dragStartX, worldX);
		const maxX = Math.max(state.dragStartX, worldX);
		const minY = Math.min(state.dragStartY, worldY);
		const maxY = Math.max(state.dragStartY, worldY);

		this.context.findElementsInRect(minX, minY, maxX, maxY);
	}

	public onPointerUp(
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
		const worldX = world.x;
		const worldY = world.y;

		const ds = this.dragState;
		switch (ds.mode) {
			case "move":
				this.finalizeMoveDrag(ds, worldX, worldY, viewport);
				break;
			case "resize":
				this.finalizeResizeDrag(ds, worldX, worldY, viewport);
				break;
			case "rotate":
				this.finalizeRotateDrag(ds, worldX, worldY);
				break;
			case "marquee":
				this.finalizeMarqueeDrag(ds, worldX, worldY);
				break;
			case "lasso":
				this.finalizeLassoDrag(ds);
				break;
			case "pending-lasso":
				break;
			case "pending":
				if (ds.hitElement) {
					const selectedIds = this.context.getSelectedElementIds();
					const noModifiers =
						!event.shiftKey &&
						!event.altKey &&
						!event.ctrlKey &&
						!event.metaKey;
					if (
						noModifiers &&
						selectedIds.length > 1 &&
						selectedIds.includes(ds.hitElement.id)
					) {
						// Click on an already-selected element within a multi-selection:
						// make it the alignment key object instead of collapsing to a
						// single selection.
						this.context.setKeyObject(ds.hitElement.id);
					} else {
						this.context.elementSelect(ds.hitElement.id, ds.hitElement.bounds);
					}
					this.refreshUI();
				}
				break;
			case "extrude-rotate":
			case "extrude-depth":
			case "repeat-grid":
			case "repeat-radial":
				// Each move already wrote through the command; just re-sync the gizmo
				// from the document.
				this.refreshUI();
				break;
		}

		this.dragState = { mode: "idle" };
	}

	private finalizeMoveDrag(
		state: Extract<DragState, { mode: "move" }>,
		worldX: number,
		worldY: number,
		viewport: Viewport,
	): void {
		const selectedIds = this.context.getSelectedElementIds();
		if (selectedIds.length === 0) return;

		let deltaX = state.lastPreviewDeltaX;
		let deltaY = state.lastPreviewDeltaY;

		if (!state.hasPreviewDelta) {
			let proposedDeltaX = worldX - state.dragStartX;
			let proposedDeltaY = worldY - state.dragStartY;

			if (this.shiftKey) {
				[proposedDeltaX, proposedDeltaY] = constrainAxis(
					proposedDeltaX,
					proposedDeltaY,
				);
			}

			const snapResult = this.context.snapElements(
				selectedIds,
				state.originalBounds,
				proposedDeltaX,
				proposedDeltaY,
				viewport.zoom,
			) ?? { deltaX: proposedDeltaX, deltaY: proposedDeltaY, snapLines: [] };
			deltaX = snapResult.deltaX;
			deltaY = snapResult.deltaY;
		}

		this.context.elementsMove(selectedIds, deltaX, deltaY);

		this.selectedBounds = translateBounds(state.originalBounds, deltaX, deltaY);

		this.updateSnapLineOverlay([]);

		this.refreshUI();
	}

	private finalizeResizeDrag(
		state: Extract<DragState, { mode: "resize" }>,
		worldX: number,
		worldY: number,
		viewport: Viewport,
	): void {
		const selectedIds = this.context.getSelectedElementIds();
		if (selectedIds.length === 0) return;

		const newBounds =
			state.lastPreviewBounds ??
			this.snapResizedBounds(
				calculateResizedBounds(
					state.originalBounds,
					state.activeHandle,
					worldX,
					worldY,
					state.dragStartX,
					state.dragStartY,
					this.shiftKey,
					this.altKey,
				),
				state.activeHandle,
				viewport.zoom,
			).bounds;

		const newWorldBounds = brandWorldBBox(newBounds);

		this.context.elementsResize(
			selectedIds,
			state.originalBounds,
			newWorldBounds,
		);

		this.selectedBounds = newWorldBounds;

		this.updateSnapLineOverlay([]);

		this.refreshUI();
	}

	private finalizeRotateDrag(
		state: Extract<DragState, { mode: "rotate" }>,
		worldX: number,
		worldY: number,
	): void {
		const selectedIds = this.context.getSelectedElementIds();
		if (selectedIds.length === 0) return;

		const { x: cx, y: cy } = state.rotationCenter;
		const currentAngle = Math.atan2(worldY - cy, worldX - cx);
		let angleDelta = currentAngle - state.rotationStartAngle;

		// Shift key: snap to 15-degree increments
		if (this.shiftKey) {
			const snapRad = (15 * Math.PI) / 180;
			angleDelta = Math.round(angleDelta / snapRad) * snapRad;
		}

		const angleDeg = (angleDelta * 180) / Math.PI;

		if (Math.abs(angleDeg) < 0.1) {
			this.refreshUI();
			return;
		}

		this.context.elementsRotate(selectedIds, angleDeg, cx, cy);

		this.refreshUI();
	}

	private finalizeMarqueeDrag(
		state: Extract<DragState, { mode: "marquee" }>,
		worldX: number,
		worldY: number,
	): void {
		this.updateMarqueeOverlay(null);

		const minX = Math.min(state.dragStartX, worldX);
		const maxX = Math.max(state.dragStartX, worldX);
		const minY = Math.min(state.dragStartY, worldY);
		const maxY = Math.max(state.dragStartY, worldY);

		const elementsInRect = this.context.findElementsInRect(
			minX,
			minY,
			maxX,
			maxY,
		);

		if (elementsInRect.length > 0) {
			const newIds = elementsInRect.map((el) => el.id);
			if (this.shiftKey) {
				const existing = this.context.getSelectedElementIds();
				this.context.selectionSelectMultiple([
					...new Set([...existing, ...newIds]),
				]);
			} else {
				this.context.selectionSelectMultiple(newIds);
			}

			this.refreshUI();
		}
	}

	public onCancel(): void {
		this.dragState = { mode: "idle" };
		this.updateSnapLineOverlay([]);
		this.updateMarqueeOverlay(null);
		this.selectedBounds = null;
	}

	private handleLassoDrag(
		state: Extract<DragState, { mode: "lasso" }>,
		_viewport: Viewport,
	): void {
		this.updateMarqueeOverlay({
			startX: 0,
			startY: 0,
			endX: 0,
			endY: 0,
			// Copy: the overlay sink freezes this array in dev builds, but
			// state.path keeps growing via push() on every pointer move.
			lassoPath: [...state.path],
		});

		const polygon = state.path;
		if (polygon.length < 3) return;

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of polygon) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}

		const candidates = this.context.findElementsInRect(minX, minY, maxX, maxY);
		const hits: string[] = [];
		for (const el of candidates) {
			const bounds = this.context.getBounds(el.id);
			if (bounds && elementIntersectsLasso(bounds, polygon)) {
				hits.push(el.id);
			}
		}

		if (hits.length > 0) {
			if (this.shiftKey) {
				const existing = this.context.getSelectedElementIds();
				this.context.selectionSelectMultiple([
					...new Set([...existing, ...hits]),
				]);
			} else {
				this.context.selectionSelectMultiple(hits);
			}
		} else if (!this.shiftKey) {
			this.context.selectionClear();
		}
	}

	private finalizeLassoDrag(
		state: Extract<DragState, { mode: "lasso" }>,
	): void {
		this.updateMarqueeOverlay(null);

		const polygon = state.path;
		if (polygon.length < 3) return;

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of polygon) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}

		const candidates = this.context.findElementsInRect(minX, minY, maxX, maxY);
		const hits: string[] = [];
		for (const el of candidates) {
			const bounds = this.context.getBounds(el.id);
			if (bounds && elementIntersectsLasso(bounds, polygon)) {
				hits.push(el.id);
			}
		}

		if (hits.length > 0) {
			const newIds = hits;
			if (this.shiftKey) {
				const existing = this.context.getSelectedElementIds();
				this.context.selectionSelectMultiple([
					...new Set([...existing, ...newIds]),
				]);
			} else {
				this.context.selectionSelectMultiple(newIds);
			}
			this.refreshUI();
		}
	}

	public saveInterruptibleState(): unknown {
		return { selectedBounds: this.selectedBounds };
	}

	public restoreFromInterrupt(state: unknown): void {
		const s = state as { selectedBounds: typeof this.selectedBounds };
		this.selectedBounds = s.selectedBounds;
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
		const worldX = world.x;
		const worldY = world.y;

		const layer = this.context.getCurrentLayer();
		if (!layer) return;

		const tolerance = this.calculateTolerance(viewport);

		const editingScopeId = this.context.getEditingScopeId();

		if (editingScopeId) {
			const element = this.context.findElementAtPoint(
				worldX,
				worldY,
				tolerance,
			);

			if (!element || !this.context.isElementEditable(element.id)) {
				this.context.exitEditingScopeOneLevel();
				return;
			}

			// Re-double-clicking the scope element itself is a no-op (it is
			// editable inside its own single-element scope).
			if (element.id === editingScopeId) return;

			if (isContainer(element)) {
				this.context.enterEditingScope(element.id);
				return;
			}

			if (isText(element)) {
				this.context.textEdit(element);
				return;
			}

			if (isReference3D(element)) {
				this.context.reference3dEdit(element);
				return;
			}

			// Editable non-container child: nest into a single-element scope.
			this.context.enterEditingScope(element.id);
			return;
		}

		const element = this.context.findElementAtPoint(worldX, worldY, tolerance);
		if (element) {
			if (isText(element)) {
				this.context.textEdit(element);
				return;
			}
			if (isReference3D(element)) {
				this.context.reference3dEdit(element);
				return;
			}
			// Containers and single elements alike enter an editing scope.
			this.context.enterEditingScope(element.id);
		}
	}

	public onKeyDown(
		event: KeyboardEvent,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): boolean {
		const selectedIds = this.context.getSelectedElementIds();
		if (selectedIds.length === 0) return false;
		if (this.dragState.mode !== "idle") return false;

		let dx = 0;
		let dy = 0;
		const step = event.shiftKey ? 10 : 1;

		switch (event.key) {
			case "ArrowLeft":
				dx = -step;
				break;
			case "ArrowRight":
				dx = step;
				break;
			case "ArrowUp":
				dy = step;
				break;
			case "ArrowDown":
				dy = -step;
				break;
			default:
				return false;
		}

		this.context.elementsMove(selectedIds, dx, dy);

		this.refreshUI();

		return true;
	}

	public getCursor(): string {
		const ds = this.dragState;
		switch (ds.mode) {
			case "move":
				return "grabbing";
			case "resize":
				return getResizeCursor(ds.activeHandle);
			case "rotate":
				return "grabbing";
			case "marquee":
			case "lasso":
			case "pending-lasso":
				return "crosshair";
		}

		// Hover state: check rotation zone and resize handles
		const selectedIds = this.context.getSelectedElementIds();
		if (selectedIds.length > 0 && this.selectedBounds && this.lastViewport) {
			if (
				this.hitTestRotationZone(
					this.lastWorldX,
					this.lastWorldY,
					this.lastViewport,
				)
			) {
				return "crosshair";
			}

			const handle = this.hitTestHandle(
				this.lastWorldX,
				this.lastWorldY,
				this.lastViewport,
			);
			if (handle) {
				return getResizeCursor(handle);
			}

			return "grab";
		}
		return "default";
	}

	private calculateTolerance(viewport: Viewport, minScreenPx = 2): number {
		return minScreenPx / viewport.zoom;
	}

	private calculateDragThreshold(
		pointerType: "mouse" | "pen" | "touch",
		zoom: number,
	): number {
		const screenPx = pointerType === "mouse" ? 3 : 8;
		return screenPx / zoom;
	}

	private updateSnapLineOverlay(lines: SnapLine[]): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.selectSnapLines,
			lines.length > 0
				? {
						zIndex: OVERLAY_Z.snapLine,
						primitives: buildSnapLineOverlay({ lines }, UI_THEME),
					}
				: null,
		);
	}

	private updateMarqueeOverlay(marquee: MarqueeSelectionUIData | null): void {
		this.context.uiSetOverlay(
			OVERLAY_KEYS.selectMarquee,
			marquee
				? {
						zIndex: OVERLAY_Z.marquee,
						primitives: buildMarqueeOverlay(marquee, UI_THEME),
					}
				: null,
		);
	}

	private createSelectionUI(bounds: BoundingBox): SelectionUIData {
		const handles = createResizeHandles(bounds);

		const pathSegments: SelectionUIData["pathSegments"] = [];
		const keyObjectSegments: SelectionUIData["keyObjectSegments"] = [];
		const selectedIds = this.context.getSelectedElementIds();
		const keyObjectId = this.context.getKeyObjectId();
		for (const id of selectedIds) {
			const element = this.context.getElement(id);
			if (!element) continue;
			const outlines = this.collectOutlines(element);
			if (id === keyObjectId) keyObjectSegments.push(...outlines);
			else pathSegments.push(...outlines);
		}

		const zoom = this.lastViewport?.zoom ?? 1;
		return {
			bounds,
			rotation: 0,
			rotationCenter: {
				x: (bounds.minX + bounds.maxX) / 2,
				y: (bounds.minY + bounds.maxY) / 2,
			},
			handles,
			rotationHandle: createRotationHandle(bounds, zoom),
			pathSegments: pathSegments.length > 0 ? pathSegments : undefined,
			keyObjectSegments:
				keyObjectSegments.length > 0 ? keyObjectSegments : undefined,
			boundsDashed: shouldDashSelectionBounds(
				selectedIds.map((id) => this.context.getElement(id) ?? undefined),
			),
		};
	}

	private collectOutlines(element: AnyArtObject): WorldBezierSegment[][] {
		return collectSelectionOutlines(
			element,
			(oid) => this.context.getElement(oid) ?? undefined,
			(oid) => this.context.getAncestorTransform(oid),
			(oid) => this.context.getElementWorldSegments(oid),
		);
	}

	private hitTestHandle(
		worldX: number,
		worldY: number,
		viewport: Viewport,
	): ResizeHandle | null {
		if (!this.selectedBounds) return null;
		return hitTestResizeHandle(worldX, worldY, this.selectedBounds, viewport);
	}

	/**
	 * Hit test rotation zones (areas just outside corner handles).
	 * The zone starts outside the resize handle square and extends outward.
	 * Uses square distance (Chebyshev) to match the resize handle's square shape.
	 */
	private hitTestRotationZone(
		worldX: number,
		worldY: number,
		viewport: Viewport,
	): boolean {
		if (!this.selectedBounds) return false;

		// Check explicit rotation handle first
		if (hitTestRotationHandle(worldX, worldY, this.selectedBounds, viewport)) {
			return true;
		}

		// Must match hitTestHandle's halfHandle so the zones don't overlap
		const handleHalf = 12 / viewport.zoom / 2;
		const rotationMargin = 14 / viewport.zoom;

		const { minX, maxX, minY, maxY } = this.selectedBounds;

		const corners = [
			{ x: minX, y: maxY }, // nw
			{ x: maxX, y: maxY }, // ne
			{ x: maxX, y: minY }, // se
			{ x: minX, y: minY }, // sw
		];

		for (const corner of corners) {
			const adx = Math.abs(worldX - corner.x);
			const ady = Math.abs(worldY - corner.y);
			const chebyshev = Math.max(adx, ady);

			if (chebyshev > handleHalf && chebyshev <= handleHalf + rotationMargin) {
				return true;
			}
		}

		return false;
	}

	/** Expose selection bounds so a gesture interrupt can restore them */
	public getSelectionBounds(): BoundingBox | null {
		return this.selectedBounds;
	}
}

/** Snap delta to nearest 45° axis (0°, 45°, 90°, 135°, …) */
const EXTRUDE_ROTATE_AXIS_INDEX = {
	"extrude-rotate-x": 0,
	"extrude-rotate-y": 1,
	"extrude-rotate-z": 2,
} as const;

export function constrainAxis(dx: number, dy: number): [number, number] {
	const angle = Math.atan2(dy, dx);
	const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
	const dist = Math.hypot(dx, dy);
	return [dist * Math.cos(snapped), dist * Math.sin(snapped)];
}

function clampRadialCount(value: number): number {
	return Math.max(1, Math.min(100, value));
}

function elementIntersectsLasso(
	bounds: BoundingBox,
	polygon: Array<{ x: number; y: number }>,
): boolean {
	const corners = [
		{ x: bounds.minX, y: bounds.minY },
		{ x: bounds.maxX, y: bounds.minY },
		{ x: bounds.maxX, y: bounds.maxY },
		{ x: bounds.minX, y: bounds.maxY },
	];

	// Phase 1: any bbox corner inside polygon
	for (const c of corners) {
		if (pointInPolygon(c.x, c.y, polygon)) return true;
	}

	// Phase 2: any lasso vertex inside bbox
	for (const p of polygon) {
		if (
			p.x >= bounds.minX &&
			p.x <= bounds.maxX &&
			p.y >= bounds.minY &&
			p.y <= bounds.maxY
		) {
			return true;
		}
	}

	// Phase 3: segment intersection between lasso edges and bbox edges
	const bboxEdges: Array<[{ x: number; y: number }, { x: number; y: number }]> =
		[
			[corners[0], corners[1]],
			[corners[1], corners[2]],
			[corners[2], corners[3]],
			[corners[3], corners[0]],
		];

	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i];
		const b = polygon[(i + 1) % polygon.length];
		for (const [c, d] of bboxEdges) {
			if (segmentsIntersect(a, b, c, d)) return true;
		}
	}

	return false;
}

function segmentsIntersect(
	a: { x: number; y: number },
	b: { x: number; y: number },
	c: { x: number; y: number },
	d: { x: number; y: number },
): boolean {
	const cross = (
		o: { x: number; y: number },
		p: { x: number; y: number },
		q: { x: number; y: number },
	) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);

	const d1 = cross(c, d, a);
	const d2 = cross(c, d, b);
	const d3 = cross(a, b, c);
	const d4 = cross(a, b, d);

	if (
		((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
		((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
	) {
		return true;
	}

	return false;
}

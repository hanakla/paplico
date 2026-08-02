import {
	add3,
	cameraBasis,
	canvasToLocalPoint,
	dot3,
	type LocalRect,
	length3,
	localToCanvasPoint,
	ndcToLocal,
	normalize3,
	projectToNdc,
	scale3,
	sub3,
	viewHalfHeightAt,
} from "../reference3d/perspective/projection";
import {
	computeWorldJoints,
	type IKChainDef,
	type IKRigData,
	quatFromAxisAngle,
	quatFromTo,
	quatInvert,
	quatMultiply,
	quatNormalize,
	type RootTransform,
	rotateVec3,
	solveCCD,
	solveLookAt,
	VRM_IK_CHAINS,
} from "../reference3d/vrm/ikSolver";
import { sparsifyPose } from "../reference3d/vrm/pose";
import { PRESET_POSES } from "../reference3d/vrm/presetPoses";
import { buildMarqueeOverlay } from "../renderer/ui/builders/marquee";
import { rectGeom } from "../renderer/ui/builders/shared";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import type { UIPrimitive } from "../renderer/ui/primitives";
import { OVERLAY_Z, type RGBA, UI_THEME } from "../renderer/ui/theme";
import {
	type ElementTransform,
	generateUid,
	isReference3D,
	type Quat,
	type Reference3DCamera,
	type Reference3DDef,
	type Reference3DElement,
	type Reference3DNode,
	type Reference3DPrimitiveShape,
	type Vec3,
	type Viewport,
} from "../schema";
import { composeTransforms, screenToWorld } from "../utils/geometry/geometry";
import {
	type GizmoProjectFn,
	meanTransformScale,
	projectRingPoints,
	ringOrientationSign,
} from "./gizmoRings";
import type {
	PointerEventData,
	Tool,
	TouchGestureEventData,
	WheelEventData,
} from "./Tool";
import type { ToolContext } from "./ToolContext";

/** Overlay channel key for the move gizmo. */
const GIZMO_OVERLAY_KEY = OVERLAY_KEYS.reference3dGizmo;
/** Overlay channel key for pose-mode bone handles. */
const POSE_OVERLAY_KEY = OVERLAY_KEYS.reference3dPose;
/** Overlay channel key for the camera zoom/pan button strip. */
const CAMERA_UI_OVERLAY_KEY = OVERLAY_KEYS.reference3dCameraUi;
/** Overlay channel key for the edited element's bounding-box outline (selection is cleared while editing). */
const EDIT_BOUNDS_OVERLAY_KEY = OVERLAY_KEYS.reference3dEditBounds;
/** Overlay channel key for the drag-to-size rectangle while creating an element. */
const CREATE_PREVIEW_OVERLAY_KEY = OVERLAY_KEYS.reference3dCreatePreview;

/** Screen-pixel movement that turns a create click into a size-defining drag. */
const CREATE_DRAG_THRESHOLD_PX = 3;
/** Minimum side length of a drag-created element (world units). */
const CREATE_MIN_SIZE = 10;

/** Orbit rotation speed in radians per screen pixel. */
const ORBIT_SPEED = 0.008;
/** Dolly speed per wheel deltaY unit. */
const DOLLY_SPEED = 0.002;
/** Pinch (ctrl+wheel) deltas are tiny and continuous — boost, then clamp the
 * per-event step so mouse ctrl+wheel (delta ~±100) stays controllable. */
const PINCH_DOLLY_BOOST = 10;
const PINCH_DOLLY_MAX_STEP = 40;
/** Camera-to-target distance limits for dolly (meters). */
const DOLLY_MIN_DISTANCE = 0.1;
const DOLLY_MAX_DISTANCE = 150;
/** Target on-screen length of a gizmo axis arrow (pixels). */
const GIZMO_AXIS_SCREEN_PX = 60;
/** On-screen radius of the rotation rings (outside the move arrows). */
const GIZMO_RING_SCREEN_PX = 78;
/** Camera axis-drag handles: arrow length, gap between handles, and margin above the bbox (pixels). */
const CAMERA_UI_AXIS_LENGTH_PX = 20;
const CAMERA_UI_AXIS_GAP_PX = 14;
const CAMERA_UI_MARGIN_PX = 14;

type MoveGizmoHandle = "axis-x" | "axis-y" | "axis-z" | "plane";
type RotateGizmoHandle = "rotate-x" | "rotate-y" | "rotate-z";
type AxisScaleGizmoHandle = "scale-x" | "scale-y" | "scale-z";
type GizmoHandle =
	| MoveGizmoHandle
	| RotateGizmoHandle
	| AxisScaleGizmoHandle
	| "scale";

/** Camera UI: drag handles for the camera's own local X/Y/Z axes (right/up/forward). */
type CameraUiHandle = "cam-axis-x" | "cam-axis-y" | "cam-axis-z";

type FigureNode = Extract<Reference3DNode, { kind: "figure" }>;

type PoseHandleKind = "ik" | "fk" | "hips" | "look";

interface PoseHandleDef {
	kind: PoseHandleKind;
	/** IK chain to solve (kind "ik"). */
	chain?: IKChainDef;
	/** Bone rotated by the drag (kind "fk" — the handle's parent joint). */
	fkBone?: string;
}

/**
 * Draggable joints in pose mode: wrists/ankles drive IK, elbows and
 * knees rotate their parent bone directly (FK), hips translate, the head
 * aims (look-at).
 */
const POSE_HANDLES: Record<string, PoseHandleDef> = {
	hips: { kind: "hips" },
	head: { kind: "look" },
	leftHand: { kind: "ik", chain: VRM_IK_CHAINS.leftArm },
	rightHand: { kind: "ik", chain: VRM_IK_CHAINS.rightArm },
	leftFoot: { kind: "ik", chain: VRM_IK_CHAINS.leftLeg },
	rightFoot: { kind: "ik", chain: VRM_IK_CHAINS.rightLeg },
	leftLowerArm: { kind: "fk", fkBone: "leftUpperArm" },
	rightLowerArm: { kind: "fk", fkBone: "rightUpperArm" },
	leftLowerLeg: { kind: "fk", fkBone: "leftUpperLeg" },
	rightLowerLeg: { kind: "fk", fkBone: "rightUpperLeg" },
};

/** Head look-at: local forward axis on the normalized rig + swing limit. */
const HEAD_FORWARD: Vec3 = [0, 0, 1];
const HEAD_MAX_ANGLE_DEG = 60;

interface EditState {
	elementId: string;
	element: Reference3DElement;
	localRect: LocalRect;
	/** Composed ancestor ∘ self transform, pivoting around the localRect center. */
	transform: ElementTransform;
	def: Reference3DDef;
}

interface CameraDragState {
	type: "camera";
	/**
	 * "axis-x"/"axis-y" pan along a single camera-local axis (the camera UI's
	 * X/Y handles); "axis-z" dollies along the view axis (its Z handle).
	 */
	mode: "orbit" | "pan" | "axis-x" | "axis-y" | "axis-z";
	startX: number;
	startY: number;
	/** Pointer position in element-local coordinates at drag start (pan). */
	startPointerLocal: { x: number; y: number };
	startCamera: Reference3DCamera;
	/** World-3D units per element-local unit at the target's depth (pan). */
	worldPerLocalUnit: number;
	currentCamera: Reference3DCamera | null;
}

/** Two-finger camera gesture: centroid pan + pinch dolly. */
interface CameraGestureDragState {
	type: "camera-gesture";
	/** Gesture centroid in element-local coordinates at gesture start. */
	startCenterLocal: { x: number; y: number };
	startCamera: Reference3DCamera;
	/** World-3D units per element-local unit at the target's depth (pan). */
	worldPerLocalUnit: number;
	currentCamera: Reference3DCamera | null;
}

interface GizmoDragState {
	type: "gizmo";
	handle: GizmoHandle;
	nodeId: string;
	startNodes: readonly Reference3DNode[];
	/** Alt-drag: phantom copy being moved; added to the scene on pointer-up. */
	pendingDuplicate: Reference3DNode | null;
	startPosition: Vec3;
	startPointerLocal: { x: number; y: number };
	/** World-3D axis direction (axis handles only). */
	axisDir: Vec3 | null;
	/** Element-local vector produced by +1 world-3D unit along the axis. */
	axisLocalVec: { x: number; y: number } | null;
	/** Camera right / up (plane handle only). */
	planeBasis: { right: Vec3; up: Vec3 } | null;
	/** World-3D units per element-local unit at the node's depth. */
	worldPerLocalUnit: number;
	currentPosition: Vec3 | null;
}

interface GizmoRotateDragState {
	type: "gizmo-rotate";
	nodeId: string;
	startNodes: readonly Reference3DNode[];
	startRotation: Quat;
	/** World-3D rotation axis of the dragged ring. */
	axisDir: Vec3;
	/** Node center in element-local coordinates (angle pivot). */
	centerLocal: { x: number; y: number };
	startPointerLocal: { x: number; y: number };
	/** Maps the pointer's local CCW angle onto the 3D rotation direction
	 *  (orientation of the projected ring, fixed at drag start). */
	angleSign: 1 | -1;
	currentRotation: Quat | null;
}

/**
 * Scale drag. Uniform mode ("scale" diamond) scales by the pointer's
 * distance ratio from the node's projected center; axis mode ("scale-x/y/z"
 * boxes) scales one component by the signed projection ratio onto the axis.
 */
interface GizmoScaleDragState {
	type: "gizmo-scale";
	nodeId: string;
	startNodes: readonly Reference3DNode[];
	startScale: Vec3;
	/** Node center in element-local coordinates (ratio pivot). */
	centerLocal: { x: number; y: number };
	/** Uniform mode: pointer distance from the center at drag start. */
	startDistance: number;
	/** Axis mode: scaled component index; null = uniform. */
	axisIndex: 0 | 1 | 2 | null;
	/** Axis mode: unit element-local direction of the scaled axis. */
	axisLocalDir: { x: number; y: number } | null;
	/** Axis mode: signed start-pointer projection onto the axis. */
	startAxisProj: number;
	currentScale: Vec3 | null;
}

interface PoseDragState {
	type: "pose";
	handleBone: string;
	handle: PoseHandleDef;
	nodeId: string;
	startNodes: readonly Reference3DNode[];
	startPose: FigureNode["pose"];
	rig: IKRigData;
	root: RootTransform;
	/** Dragged joint's world position at drag start. */
	startJointWorld: Vec3;
	startPointerLocal: { x: number; y: number };
	/** Camera right / up for the drag plane at the joint's depth. */
	planeBasis: { right: Vec3; up: Vec3 };
	/** World-3D units per element-local unit at the joint's depth. */
	worldPerLocalUnit: number;
	currentPose: FigureNode["pose"] | null;
}

/**
 * Element creation on empty canvas: the pointer went down and the gesture is
 * still undecided. `currentWorld` stays null for a plain click (default-size
 * element) and tracks the pointer once the drag threshold is passed
 * (drag-to-size).
 */
interface CreateDragState {
	type: "create";
	startWorld: { x: number; y: number };
	startScreen: { x: number; y: number };
	currentWorld: { x: number; y: number } | null;
}

type DragState =
	| CameraDragState
	| CameraGestureDragState
	| CreateDragState
	| GizmoDragState
	| GizmoRotateDragState
	| GizmoScaleDragState
	| PoseDragState;

/**
 * Reference3D editing tool: enter-to-edit on a Reference3DElement, camera
 * orbit / pan / dolly, primitive insertion, node selection via service
 * raycast, and a move gizmo (3 axes + screen plane) plus world-axis
 * rotation rings, both driven by the declarative overlay hit-test.
 *
 * All pixel↔scene math runs in element-local coordinates: canvas points are
 * pulled through the inverse of the composed element transform, and gizmo
 * geometry is pushed back out through the forward transform. This matches
 * Reference3DElementRenderer's quad blit exactly, so rotated / scaled elements
 * keep gizmo, raycast, and rendered pixels aligned.
 *
 * Camera and node drags never write to Yjs while in progress — previews go
 * through ToolContext.reference3dPreviewCamera / reference3dPreviewNodes and the
 * final state is committed once on pointer-up.
 */
export class Reference3DTool implements Tool {
	public readonly name = "reference3d";

	private context: ToolContext;
	private dragState: DragState | null = null;
	/** Gizmo handle under the cursor (highlight + rebuilt on change). */
	private hoveredGizmoHandle: GizmoHandle | null = null;
	/** Camera pinned at the start of an ActionsPanel axis-move drag (see moveCameraAlongAxis). */
	private axisMoveBase: {
		axis: "x" | "y" | "z";
		camera: Reference3DCamera;
	} | null = null;

	public constructor(context: ToolContext) {
		this.context = context;
	}

	// --- Edit lifecycle ---

	public enterEditModeForElement(element: Reference3DElement): void {
		this.context.reference3dController?.startEdit(element.id);
		this.context.selectionClear();
		// The edited scene doubles as the perspective ruler source, so pen
		// strokes can snap to it right after (or while) framing the camera.
		this.context.reference3dSetGuideSource(element.id);
		this.refreshGizmo();
		this.refreshCameraUi();
		this.refreshEditBoundsOverlay();
		this.context.requestRender("selection");
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

		const controller = this.context.reference3dController;
		if (!controller) return;

		if (!controller.isEditing()) {
			const hitElement = this.context.findElementAtPoint(world.x, world.y);
			if (hitElement && isReference3D(hitElement)) {
				this.enterEditModeForElement(hitElement);
				return;
			}
			// Empty canvas: decide on pointer-up — a click creates a
			// default-size element, a drag defines the element's rect.
			this.dragState = {
				type: "create",
				startWorld: world,
				startScreen: { x: event.x, y: event.y },
				currentWorld: null,
			};
			return;
		}

		const state = this.getEditState();
		if (!state) return;

		const hit = this.context.uiHitTest({ x: event.x, y: event.y });
		const local = toLocalPoint(state, world);

		// Pose mode: bone handles first, empty space orbits the camera.
		if (controller.getMode() === "pose") {
			if (hit?.overlayKey === POSE_OVERLAY_KEY) {
				this.beginPoseDrag(state, hit.hitId, local);
				return;
			}
		} else {
			// 1. Camera axis-drag handles (checked before the move gizmo — they
			// sit above the scene, outside where a gizmo handle could be).
			if (hit?.overlayKey === CAMERA_UI_OVERLAY_KEY) {
				this.beginCameraAxisDrag(
					state,
					hit.hitId as CameraUiHandle,
					event,
					local,
				);
				return;
			}

			// 2. Gizmo handles (declarative overlay hit-test).
			if (hit?.overlayKey === GIZMO_OVERLAY_KEY) {
				this.beginGizmoDrag(
					state,
					hit.hitId as GizmoHandle,
					world,
					event.altKey,
				);
				return;
			}

			// 3. Scene node raycast (element-local NDC through the camera).
			const nodeId = this.raycastNodeAt(state, local);
			if (nodeId) {
				controller.selectNode(nodeId);
				this.refreshGizmo();
				this.context.requestRender("selection");
				return;
			}

			// 4. Empty space: clear node selection before the camera gesture.
			if (controller.getSelectedNodeId()) {
				controller.selectNode(null);
				this.refreshGizmo();
			}
		}
		const camera = state.element.camera;
		this.dragState = {
			type: "camera",
			mode: event.shiftKey || event.button === 2 ? "pan" : "orbit",
			startX: event.x,
			startY: event.y,
			startPointerLocal: local,
			startCamera: camera,
			worldPerLocalUnit: worldPerLocalUnitAt(
				camera.target,
				camera,
				state.localRect.height,
			),
			currentCamera: null,
		};
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const drag = this.dragState;
		if (!drag) {
			this.updateGizmoHover(event);
			return;
		}

		if (drag.type === "create") {
			if (
				drag.currentWorld === null &&
				Math.hypot(event.x - drag.startScreen.x, event.y - drag.startScreen.y) <
					CREATE_DRAG_THRESHOLD_PX
			) {
				return;
			}
			drag.currentWorld = screenToWorld(
				event.x,
				event.y,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			this.context.uiSetOverlay(CREATE_PREVIEW_OVERLAY_KEY, {
				zIndex: OVERLAY_Z.marquee,
				primitives: buildMarqueeOverlay(
					{
						startX: drag.startWorld.x,
						startY: drag.startWorld.y,
						endX: drag.currentWorld.x,
						endY: drag.currentWorld.y,
					},
					UI_THEME,
				),
			});
			this.context.requestRender("selection");
			return;
		}

		const state = this.getEditState();
		if (!state) return;

		const pointerLocal = toLocalPoint(
			state,
			screenToWorld(event.x, event.y, viewport, canvasWidth, canvasHeight),
		);

		if (drag.type === "camera") {
			const camera = computeCameraDrag(drag, event, pointerLocal);
			drag.currentCamera = camera;
			this.context.reference3dPreviewCamera(state.elementId, camera);
			this.refreshGizmo(camera);
			this.refreshPoseOverlay(camera);
			return;
		}

		// Two-finger camera gestures are driven by onTouchGesture, not moves.
		if (drag.type === "camera-gesture") return;

		if (drag.type === "gizmo-scale") {
			this.moveScaleDrag(state, drag, pointerLocal);
			return;
		}

		const deltaLocal = {
			x: pointerLocal.x - drag.startPointerLocal.x,
			y: pointerLocal.y - drag.startPointerLocal.y,
		};

		if (drag.type === "pose") {
			this.movePoseDrag(state, drag, deltaLocal);
			return;
		}

		if (drag.type === "gizmo-rotate") {
			this.moveRotateDrag(state, drag, pointerLocal);
			return;
		}

		let position: Vec3;
		if (drag.axisDir && drag.axisLocalVec) {
			// Project the 2D drag onto the axis's element-local direction, then
			// convert the amount back into world-3D units along the axis.
			const v = drag.axisLocalVec;
			const lenSq = v.x * v.x + v.y * v.y;
			if (lenSq < 1e-12) return;
			const t = (deltaLocal.x * v.x + deltaLocal.y * v.y) / lenSq;
			position = add3(drag.startPosition, scale3(drag.axisDir, t));
		} else if (drag.planeBasis) {
			// Screen-plane move: shift along camera right/up at the node's depth.
			const wx = deltaLocal.x * drag.worldPerLocalUnit;
			const wy = deltaLocal.y * drag.worldPerLocalUnit;
			position = add3(
				drag.startPosition,
				add3(scale3(drag.planeBasis.right, wx), scale3(drag.planeBasis.up, wy)),
			);
		} else {
			return;
		}

		drag.currentPosition = position;
		this.context.reference3dPreviewNodes(
			state.element.sceneId,
			moveNode(drag.startNodes, drag.nodeId, position),
		);
		this.refreshGizmo();
	}

	public onPointerUp(
		_event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		const drag = this.dragState;
		this.dragState = null;
		if (!drag) return;

		// Two-finger camera gestures end via onTouchGesture — a stray
		// single-pointer up must not tear the gesture down.
		if (drag.type === "camera-gesture") {
			this.dragState = drag;
			return;
		}

		if (drag.type === "create") {
			this.context.uiSetOverlay(CREATE_PREVIEW_OVERLAY_KEY, null);
			const end = drag.currentWorld;
			const created = end
				? this.context.reference3dCreate(
						(drag.startWorld.x + end.x) / 2,
						(drag.startWorld.y + end.y) / 2,
						Math.max(Math.abs(end.x - drag.startWorld.x), CREATE_MIN_SIZE),
						Math.max(Math.abs(end.y - drag.startWorld.y), CREATE_MIN_SIZE),
					)
				: this.context.reference3dCreate(drag.startWorld.x, drag.startWorld.y);
			if (created && isReference3D(created)) {
				this.enterEditModeForElement(created);
			}
			return;
		}

		const state = this.getEditState();
		if (!state) return;

		if (drag.type === "camera") {
			if (drag.currentCamera) {
				// Single Yjs write per gesture = one undo step.
				this.context.updateElement(state.elementId, {
					camera: drag.currentCamera,
				});
			}
			this.context.reference3dPreviewCamera(state.elementId, null);
			this.refreshGizmo();
			this.refreshPoseOverlay();
			return;
		}

		if (drag.type === "pose") {
			if (drag.currentPose) {
				this.context.reference3dCommitNode(state.element.sceneId, drag.nodeId, {
					pose: sparsifyPose(drag.currentPose),
				});
			}
			this.context.reference3dPreviewNodes(state.element.sceneId, null);
			this.refreshPoseOverlay();
			return;
		}

		if (drag.type === "gizmo-rotate") {
			if (drag.currentRotation) {
				const node = drag.startNodes.find((n) => n.id === drag.nodeId);
				if (node) {
					this.context.reference3dCommitNode(
						state.element.sceneId,
						drag.nodeId,
						{
							transform: { ...node.transform, rotation: drag.currentRotation },
						},
					);
				}
			}
			this.context.reference3dPreviewNodes(state.element.sceneId, null);
			this.refreshGizmo();
			return;
		}

		if (drag.type === "gizmo-scale") {
			if (drag.currentScale) {
				const node = drag.startNodes.find((n) => n.id === drag.nodeId);
				if (node) {
					this.context.reference3dCommitNode(
						state.element.sceneId,
						drag.nodeId,
						{
							transform: { ...node.transform, scale: drag.currentScale },
						},
					);
				}
			}
			this.context.reference3dPreviewNodes(state.element.sceneId, null);
			this.refreshGizmo();
			return;
		}

		if (drag.currentPosition) {
			const node = drag.startNodes.find((n) => n.id === drag.nodeId);
			if (node) {
				if (drag.pendingDuplicate) {
					// Alt-drag: materialize the phantom copy at its drop position.
					this.context.reference3dAddNode(state.element.sceneId, {
						...node,
						transform: { ...node.transform, position: drag.currentPosition },
					});
					this.context.reference3dController?.selectNode(drag.nodeId);
				} else {
					this.context.reference3dCommitNode(
						state.element.sceneId,
						drag.nodeId,
						{
							transform: { ...node.transform, position: drag.currentPosition },
						},
					);
				}
			}
		}
		this.context.reference3dPreviewNodes(state.element.sceneId, null);
		this.refreshGizmo();
	}

	/** Enter pose mode when double-clicking a figure node in object mode. */
	public onDoubleClick(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const controller = this.context.reference3dController;
		if (!controller?.isEditing() || controller.getMode() === "pose") return;
		const state = this.getEditState();
		if (!state) return;

		const world = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		const nodeId = this.raycastNodeAt(state, toLocalPoint(state, world));
		const node = nodeId
			? state.def.nodes.find((n) => n.id === nodeId)
			: undefined;
		if (!node || node.kind !== "figure") return;

		controller.selectNode(node.id);
		controller.enterPoseMode(node.id);
		this.context.uiSetOverlay(GIZMO_OVERLAY_KEY, null);
		this.refreshPoseOverlay();
		this.context.requestRender("selection");
	}

	public onWheel(
		event: WheelEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		if (this.context.isReadonly()) return false;
		const controller = this.context.reference3dController;
		if (!controller?.isEditing()) return false;
		const state = this.getEditState();
		if (!state) return false;

		const local = toLocalPoint(
			state,
			screenToWorld(event.x, event.y, viewport, canvasWidth, canvasHeight),
		);
		if (!isInsideRect(local, state.localRect)) return false;

		// Trackpad pinch arrives as ctrl+wheel and is the platform zoom
		// gesture — dolly with it too instead of letting the canvas zoom.
		const effectiveDelta = event.ctrlKey
			? clamp(
					event.deltaY * PINCH_DOLLY_BOOST,
					-PINCH_DOLLY_MAX_STEP,
					PINCH_DOLLY_MAX_STEP,
				)
			: event.deltaY;

		// Discrete wheel ticks commit directly; the Yjs captureTimeout groups
		// a burst of ticks into a single undo step.
		this.context.updateElement(state.elementId, {
			camera: dollyCamera(state.element.camera, effectiveDelta),
		});
		this.refreshGizmo();
		return true;
	}

	/** Set the camera-to-target distance to an absolute value. For ActionsPanel and the camera UI overlay. */
	public setCameraZoom(distance: number): void {
		if (this.context.isReadonly()) return;
		const state = this.getEditState();
		if (!state) return;
		this.context.updateElement(state.elementId, {
			camera: setCameraDistance(this.currentCamera(state), distance),
		});
		this.refreshGizmo();
	}

	/** Set the camera's orbit angles around the target to absolute values. For ActionsPanel. */
	public setCameraOrbit(yawDeg: number, pitchDeg: number): void {
		if (this.context.isReadonly()) return;
		const state = this.getEditState();
		if (!state) return;
		this.context.updateElement(state.elementId, {
			camera: setCameraOrbitAngles(this.currentCamera(state), yawDeg, pitchDeg),
		});
		this.refreshGizmo();
	}

	/**
	 * Move the camera along one of its own local axes to an absolute offset
	 * from where the drag started: "x"/"y" pan (position and target move
	 * together along right/up, so the view direction doesn't change); "z"
	 * dollies (target stays put, so a positive offset moves the camera
	 * closer). For the ActionsPanel's move sliders, which fire continuously
	 * during a drag with the *total* offset since drag start (an InfiniteSlider
	 * pinned at 0) — the first call each drag pins the base camera so
	 * subsequent calls replace rather than compound on top of it. Call
	 * `endCameraAxisMove` once the drag ends (pointerup) to unpin it.
	 */
	public moveCameraAlongAxis(axis: "x" | "y" | "z", offset: number): void {
		if (this.context.isReadonly()) return;
		const state = this.getEditState();
		if (!state) return;
		if (this.axisMoveBase?.axis !== axis) {
			this.axisMoveBase = { axis, camera: this.currentCamera(state) };
		}
		const baseCamera = this.axisMoveBase.camera;

		if (axis === "z") {
			this.context.updateElement(state.elementId, {
				camera: setCameraDistance(
					baseCamera,
					getCameraDistance(baseCamera) - offset,
				),
			});
			this.refreshGizmo();
			return;
		}

		const basis = cameraBasis(baseCamera);
		const axisOffset = scale3(axis === "x" ? basis.right : basis.up, offset);
		this.context.updateElement(state.elementId, {
			camera: {
				...baseCamera,
				position: add3(baseCamera.position, axisOffset),
				target: add3(baseCamera.target, axisOffset),
			},
		});
		this.refreshGizmo();
	}

	/** Unpin the base camera captured by moveCameraAlongAxis. Call on drag end (pointerup). */
	public endCameraAxisMove(): void {
		this.axisMoveBase = null;
	}

	/** Start dragging a camera UI axis handle (see CameraDragState's axis-x/y/z modes). */
	private beginCameraAxisDrag(
		state: EditState,
		handle: CameraUiHandle,
		event: PointerEventData,
		local: { x: number; y: number },
	): void {
		const camera = this.currentCamera(state);
		const mode =
			handle === "cam-axis-x"
				? "axis-x"
				: handle === "cam-axis-y"
					? "axis-y"
					: "axis-z";
		this.dragState = {
			type: "camera",
			mode,
			startX: event.x,
			startY: event.y,
			startPointerLocal: local,
			startCamera: camera,
			worldPerLocalUnit: worldPerLocalUnitAt(
				camera.target,
				camera,
				state.localRect.height,
			),
			currentCamera: null,
		};
	}

	/**
	 * Two-finger gesture starting inside the edited scene: the centroid pans
	 * the camera and the pinch dollies it, so pen/touch users get viewpoint
	 * control without a wheel or middle button.
	 */
	public onTouchGesture(
		event: TouchGestureEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean {
		if (this.context.isReadonly()) return false;
		const controller = this.context.reference3dController;
		if (!controller?.isEditing()) return false;
		const state = this.getEditState();
		if (!state) return false;

		if (event.phase === "start") {
			const local = toLocalPoint(
				state,
				screenToWorld(
					event.centerX,
					event.centerY,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			);
			if (!isInsideRect(local, state.localRect)) return false;
			const camera = state.element.camera;
			this.dragState = {
				type: "camera-gesture",
				startCenterLocal: local,
				startCamera: camera,
				worldPerLocalUnit: worldPerLocalUnitAt(
					camera.target,
					camera,
					state.localRect.height,
				),
				currentCamera: null,
			};
			return true;
		}

		const drag = this.dragState;
		if (drag?.type !== "camera-gesture") return false;

		if (event.phase === "update") {
			const local = toLocalPoint(
				state,
				screenToWorld(
					event.centerX,
					event.centerY,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			);
			// Pan by the centroid movement, then dolly by the pinch ratio
			// (pinching out brings the camera closer).
			const panned = panCamera(
				drag.startCamera,
				{
					x: local.x - drag.startCenterLocal.x,
					y: local.y - drag.startCenterLocal.y,
				},
				drag.worldPerLocalUnit,
			);
			const camera = dollyCameraByFactor(
				panned,
				1 / Math.max(event.scale, 1e-3),
			);
			drag.currentCamera = camera;
			this.context.reference3dPreviewCamera(state.elementId, camera);
			this.refreshGizmo(camera);
			this.refreshPoseOverlay(camera);
			return true;
		}

		// "end": single Yjs write per gesture = one undo step.
		this.dragState = null;
		if (drag.currentCamera) {
			this.context.updateElement(state.elementId, {
				camera: drag.currentCamera,
			});
		}
		this.context.reference3dPreviewCamera(state.elementId, null);
		this.refreshGizmo();
		this.refreshPoseOverlay();
		return true;
	}

	public onKeyDown(
		event: KeyboardEvent,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): boolean {
		const controller = this.context.reference3dController;
		if (!controller?.isEditing()) return false;

		if (event.code === "Escape") {
			// Mode ladder: cancel drag → pose→object → deselect node → exit.
			if (this.dragState) {
				this.cancelActiveDrag();
				return true;
			}
			if (controller.getMode() === "pose") {
				controller.exitPoseMode();
				this.context.uiSetOverlay(POSE_OVERLAY_KEY, null);
				this.refreshGizmo();
				this.context.requestRender("selection");
				return true;
			}
			if (controller.getSelectedNodeId()) {
				controller.selectNode(null);
				this.refreshGizmo();
				this.context.requestRender("selection");
				return true;
			}
			controller.endEdit();
			this.context.reference3dSetGuideSource(null);
			this.context.uiSetOverlay(GIZMO_OVERLAY_KEY, null);
			this.context.uiSetOverlay(EDIT_BOUNDS_OVERLAY_KEY, null);
			this.context.reference3dExitEdit();
			return true;
		}

		if (this.context.isReadonly()) return false;

		// Pose mode: number keys apply preset poses to the posed figure.
		// Primitives are added from the actions panel, not number keys.
		if (controller.getMode() === "pose") {
			const presetIndex = PRESET_KEY_ORDER.indexOf(event.code);
			if (presetIndex >= 0) {
				this.applyPresetPose(presetIndex);
				return true;
			}
		}

		return false;
	}

	/** Apply a built-in preset pose to the figure being posed (one undo step). */
	public applyPresetPose(presetIndex: number): void {
		const controller = this.context.reference3dController;
		const state = this.getEditState();
		const nodeId = controller?.getPoseNodeId();
		const preset = PRESET_POSES[presetIndex];
		if (!state || !nodeId || !preset) return;

		this.context.reference3dCommitNode(state.element.sceneId, nodeId, {
			pose: sparsifyPose(preset.pose),
		});
		this.refreshPoseOverlay();
		this.context.requestRender("document");
	}

	/** Add a primitive node at the scene origin and select it. */
	public addPrimitive(shape: Reference3DPrimitiveShape): void {
		const state = this.getEditState();
		if (!state) return;

		const node: Reference3DNode = {
			id: generateUid("node"),
			kind: "primitive",
			shape,
			transform: {
				position: [0, 0.5, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			},
		};
		this.context.reference3dAddNode(state.element.sceneId, node);
		this.context.reference3dController?.selectNode(node.id);
		this.refreshGizmo();
		this.context.requestRender("document");
	}

	public onCancel(): void {
		this.cancelActiveDrag();
		this.hoveredGizmoHandle = null;
		this.context.uiSetOverlay(GIZMO_OVERLAY_KEY, null);
		this.context.uiSetOverlay(POSE_OVERLAY_KEY, null);
		this.context.uiSetOverlay(CAMERA_UI_OVERLAY_KEY, null);
		this.context.uiSetOverlay(EDIT_BOUNDS_OVERLAY_KEY, null);
	}

	/**
	 * Called on tool switch. The Reference3DController outlives tool instances, so
	 * end the edit session here — otherwise re-selecting the tool resumes the
	 * stale session and clicking empty canvas orbits the old scene instead of
	 * creating a new one. The perspective guide source is intentionally kept
	 * so pen strokes can still snap to the framed scene.
	 */
	public dispose(): void {
		this.context.reference3dController?.endEdit();
	}

	public getCursor(): string {
		if (
			this.dragState?.type === "gizmo" ||
			this.dragState?.type === "gizmo-rotate" ||
			this.dragState?.type === "gizmo-scale" ||
			this.dragState?.type === "pose"
		) {
			return "move";
		}
		if (
			this.dragState?.type === "camera" ||
			this.dragState?.type === "camera-gesture"
		) {
			return "grabbing";
		}
		return this.context.reference3dController?.isEditing() ? "grab" : "default";
	}

	public refreshUI(): void {
		this.refreshGizmo();
		this.refreshPoseOverlay();
		this.refreshCameraUi();
		this.refreshEditBoundsOverlay();
	}

	// --- Private helpers ---

	/** Resolve the editing element, its composed transform, and the def. */
	private getEditState(): EditState | null {
		const controller = this.context.reference3dController;
		const elementId = controller?.getEditingElementId();
		if (!controller || !elementId) return null;

		const element = this.context.getElement(elementId);
		if (!element || !isReference3D(element)) {
			controller.endEdit();
			return null;
		}

		const ancestorTransform = this.context.getAncestorTransform(elementId);
		const transform = ancestorTransform
			? composeTransforms(ancestorTransform, element.transform)
			: element.transform;

		const def = this.context.reference3dGetDef(element.sceneId);
		if (!def) return null;

		return {
			elementId,
			element,
			localRect: {
				cx: element.x,
				cy: element.y,
				width: element.width,
				height: element.height,
			},
			transform,
			def,
		};
	}

	private beginGizmoDrag(
		state: EditState,
		handle: GizmoHandle,
		pointerWorld: { x: number; y: number },
		duplicate: boolean,
	): void {
		if (
			handle === "rotate-x" ||
			handle === "rotate-y" ||
			handle === "rotate-z"
		) {
			this.beginGizmoRotateDrag(state, handle, pointerWorld);
			return;
		}

		if (
			handle === "scale" ||
			handle === "scale-x" ||
			handle === "scale-y" ||
			handle === "scale-z"
		) {
			this.beginGizmoScaleDrag(state, pointerWorld, handle);
			return;
		}

		const nodeId = this.context.reference3dController?.getSelectedNodeId();
		if (!nodeId) return;
		const node = state.def.nodes.find((n) => n.id === nodeId);
		if (!node) return;

		const camera = this.currentCamera(state);
		const aspect = state.localRect.width / state.localRect.height;
		const position = node.transform.position;

		let axisDir: Vec3 | null = null;
		let axisLocalVec: { x: number; y: number } | null = null;
		let planeBasis: { right: Vec3; up: Vec3 } | null = null;

		if (handle === "plane") {
			const basis = cameraBasis(camera);
			planeBasis = { right: basis.right, up: basis.up };
		} else {
			axisDir = AXIS_DIRECTIONS[handle];
			axisLocalVec = axisLocalVector(
				position,
				axisDir,
				camera,
				aspect,
				state.localRect,
			);
			if (!axisLocalVec) return;
		}

		// Alt-drag: move a phantom copy instead; it only becomes a real node
		// on pointer-up (a single scene write = one undo step).
		let dragNodeId = nodeId;
		let startNodes: Reference3DNode[] = state.def.nodes.map((n) => ({ ...n }));
		let pendingDuplicate: Reference3DNode | null = null;
		if (duplicate) {
			pendingDuplicate = {
				...structuredClone(node),
				id: generateUid("node"),
			};
			startNodes = [...startNodes, pendingDuplicate];
			dragNodeId = pendingDuplicate.id;
		}

		this.dragState = {
			type: "gizmo",
			handle,
			nodeId: dragNodeId,
			startNodes,
			pendingDuplicate,
			startPosition: [...position],
			startPointerLocal: toLocalPoint(state, pointerWorld),
			axisDir,
			axisLocalVec,
			planeBasis,
			worldPerLocalUnit: worldPerLocalUnitAt(
				position,
				camera,
				state.localRect.height,
			),
			currentPosition: null,
		};
	}

	private beginGizmoRotateDrag(
		state: EditState,
		handle: RotateGizmoHandle,
		pointerWorld: { x: number; y: number },
	): void {
		const nodeId = this.context.reference3dController?.getSelectedNodeId();
		if (!nodeId) return;
		const node = state.def.nodes.find((n) => n.id === nodeId);
		if (!node) return;

		const camera = this.currentCamera(state);
		const aspect = state.localRect.width / state.localRect.height;
		const position = node.transform.position;
		const centerNdc = projectToNdc(position, camera, aspect);
		if (!centerNdc) return;

		const ringPoints = projectRingPoints(
			position,
			ROTATE_AXIS_DIRECTIONS[handle],
			this.ringRadiusLocal(state),
			reference3dProjector(camera, aspect, state.localRect),
		);
		if (!ringPoints) return;

		this.dragState = {
			type: "gizmo-rotate",
			nodeId,
			startNodes: state.def.nodes.map((n) => ({ ...n })),
			startRotation: [...node.transform.rotation],
			axisDir: ROTATE_AXIS_DIRECTIONS[handle],
			centerLocal: ndcToLocal(centerNdc, state.localRect),
			startPointerLocal: toLocalPoint(state, pointerWorld),
			angleSign: ringOrientationSign(ringPoints),
			currentRotation: null,
		};
	}

	/** Highlight the gizmo handle under the cursor (hover, no active drag). */
	private updateGizmoHover(event: PointerEventData): void {
		if (!this.context.reference3dController?.isEditing()) return;
		const hit = this.context.uiHitTest({ x: event.x, y: event.y });
		const hovered =
			hit?.overlayKey === GIZMO_OVERLAY_KEY ? (hit.hitId as GizmoHandle) : null;
		if (hovered === this.hoveredGizmoHandle) return;
		this.hoveredGizmoHandle = hovered;
		this.refreshGizmo();
		this.context.requestRender("selection");
	}

	private beginGizmoScaleDrag(
		state: EditState,
		pointerWorld: { x: number; y: number },
		handle: AxisScaleGizmoHandle | "scale",
	): void {
		const nodeId = this.context.reference3dController?.getSelectedNodeId();
		if (!nodeId) return;
		const node = state.def.nodes.find((n) => n.id === nodeId);
		if (!node) return;

		const camera = this.currentCamera(state);
		const aspect = state.localRect.width / state.localRect.height;
		const position = node.transform.position;
		const centerNdc = projectToNdc(position, camera, aspect);
		if (!centerNdc) return;
		const centerLocal = ndcToLocal(centerNdc, state.localRect);
		const startPointerLocal = toLocalPoint(state, pointerWorld);

		let axisIndex: 0 | 1 | 2 | null = null;
		let axisLocalDir: { x: number; y: number } | null = null;
		let startAxisProj = 0;
		if (handle !== "scale") {
			axisIndex = SCALE_AXIS_INDEX[handle];
			const axisVec = axisLocalVector(
				position,
				AXIS_VECTORS[axisIndex],
				camera,
				aspect,
				state.localRect,
			);
			if (!axisVec) return;
			const len = Math.hypot(axisVec.x, axisVec.y);
			if (len < 1e-6) return;
			axisLocalDir = { x: axisVec.x / len, y: axisVec.y / len };
			startAxisProj =
				(startPointerLocal.x - centerLocal.x) * axisLocalDir.x +
				(startPointerLocal.y - centerLocal.y) * axisLocalDir.y;
			if (Math.abs(startAxisProj) < 1e-6) return;
		}

		const startDistance = Math.hypot(
			startPointerLocal.x - centerLocal.x,
			startPointerLocal.y - centerLocal.y,
		);
		if (handle === "scale" && startDistance < 1e-6) return;

		this.dragState = {
			type: "gizmo-scale",
			nodeId,
			startNodes: state.def.nodes.map((n) => ({ ...n })),
			startScale: [...node.transform.scale],
			centerLocal,
			startDistance,
			axisIndex,
			axisLocalDir,
			startAxisProj,
			currentScale: null,
		};
	}

	private moveScaleDrag(
		state: EditState,
		drag: GizmoScaleDragState,
		pointerLocal: { x: number; y: number },
	): void {
		let scale: Vec3;
		if (drag.axisIndex !== null && drag.axisLocalDir) {
			// Axis mode: signed projection ratio along the axis = one component.
			const proj =
				(pointerLocal.x - drag.centerLocal.x) * drag.axisLocalDir.x +
				(pointerLocal.y - drag.centerLocal.y) * drag.axisLocalDir.y;
			const factor = clamp(proj / drag.startAxisProj, 0.05, 100);
			scale = [...drag.startScale];
			scale[drag.axisIndex] *= factor;
		} else {
			// Uniform: distance ratio from the projected node center.
			const distance = Math.hypot(
				pointerLocal.x - drag.centerLocal.x,
				pointerLocal.y - drag.centerLocal.y,
			);
			const factor = clamp(distance / drag.startDistance, 0.05, 100);
			scale = [
				drag.startScale[0] * factor,
				drag.startScale[1] * factor,
				drag.startScale[2] * factor,
			];
		}
		drag.currentScale = scale;
		this.context.reference3dPreviewNodes(
			state.element.sceneId,
			scaleNode(drag.startNodes, drag.nodeId, scale),
		);
		this.refreshGizmo();
	}

	private moveRotateDrag(
		state: EditState,
		drag: GizmoRotateDragState,
		pointerLocal: { x: number; y: number },
	): void {
		const sx = drag.startPointerLocal.x - drag.centerLocal.x;
		const sy = drag.startPointerLocal.y - drag.centerLocal.y;
		const nx = pointerLocal.x - drag.centerLocal.x;
		const ny = pointerLocal.y - drag.centerLocal.y;
		if (Math.hypot(sx, sy) < 1e-6 || Math.hypot(nx, ny) < 1e-6) return;

		// Pointer angle around the node's projected center; the ring's
		// projected orientation maps it onto the 3D rotation direction. The
		// world-axis rotation composes on the left of the start rotation.
		const delta = Math.atan2(sx * ny - sy * nx, sx * nx + sy * ny);
		const rotation = quatNormalize(
			quatMultiply(
				quatFromAxisAngle(drag.axisDir, drag.angleSign * delta),
				drag.startRotation,
			),
		);
		drag.currentRotation = rotation;
		this.context.reference3dPreviewNodes(
			state.element.sceneId,
			rotateNode(drag.startNodes, drag.nodeId, rotation),
		);
		this.refreshGizmo();
	}

	/** Ring radius in element-local units for a fixed on-screen size. */
	private ringRadiusLocal(state: EditState): number {
		const zoom = this.context.getViewport()?.viewport.zoom ?? 1;
		return GIZMO_RING_SCREEN_PX / (zoom * meanTransformScale(state.transform));
	}

	private cancelActiveDrag(): void {
		const drag = this.dragState;
		this.dragState = null;
		if (!drag) return;
		if (drag.type === "create") {
			this.context.uiSetOverlay(CREATE_PREVIEW_OVERLAY_KEY, null);
			return;
		}
		const state = this.getEditState();
		if (!state) return;
		if (drag.type === "camera" || drag.type === "camera-gesture") {
			this.context.reference3dPreviewCamera(state.elementId, null);
		} else {
			this.context.reference3dPreviewNodes(state.element.sceneId, null);
		}
		this.refreshGizmo();
		this.refreshPoseOverlay();
	}

	private raycastNodeAt(
		state: EditState,
		local: { x: number; y: number },
	): string | null {
		if (!isInsideRect(local, state.localRect)) return null;
		const ndcX = (local.x - state.localRect.cx) / (state.localRect.width / 2);
		const ndcY = (local.y - state.localRect.cy) / (state.localRect.height / 2);
		return this.context.reference3dRaycastNode({
			sceneId: state.element.sceneId,
			nodes: state.def.nodes,
			camera: this.currentCamera(state),
			ndcX,
			ndcY,
			aspect: state.localRect.width / state.localRect.height,
		});
	}

	/** Camera to use for projection math (live drag preview wins). */
	private currentCamera(state: EditState): Reference3DCamera {
		const drag = this.dragState;
		if (
			(drag?.type === "camera" || drag?.type === "camera-gesture") &&
			drag.currentCamera
		) {
			return drag.currentCamera;
		}
		return state.element.camera;
	}

	/**
	 * Show the edited element's bounding-box outline. Entering edit mode
	 * clears the document selection (so ordinary clicks orbit the camera
	 * instead of dragging a resize handle), which also removes its normal
	 * selection frame — this stands in for that frame while editing.
	 */
	private refreshEditBoundsOverlay(): void {
		const state = this.getEditState();
		const bounds = state ? this.context.getBounds(state.elementId) : null;
		if (!bounds) {
			this.context.uiSetOverlay(EDIT_BOUNDS_OVERLAY_KEY, null);
			return;
		}
		this.context.uiSetOverlay(EDIT_BOUNDS_OVERLAY_KEY, {
			primitives: [
				{
					kind: "rect",
					...rectGeom(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY),
					stroke: {
						color: UI_THEME.colors.selectionBounds,
						width: UI_THEME.strokeWidth.default,
					},
				},
			],
		});
	}

	/**
	 * Rebuild (or clear) the three camera axis-drag handles anchored above
	 * the scene's bounding box. Its position only depends on `localRect`
	 * (the element's own placement) and the viewport zoom, not the camera,
	 * so camera-changing methods don't need to call this.
	 */
	private refreshCameraUi(): void {
		const state = this.getEditState();
		const controller = this.context.reference3dController;
		if (!state || controller?.getMode() === "pose") {
			this.context.uiSetOverlay(CAMERA_UI_OVERLAY_KEY, null);
			return;
		}

		const topCenterLocal = {
			x: state.localRect.cx,
			y: state.localRect.cy + state.localRect.height / 2,
		};
		const topCenter = toCanvasPoint(state, topCenterLocal);

		// Handle positions are in world units, so target-on-screen sizes are
		// divided by zoom (same approach as the move-gizmo arrows above).
		const zoom = this.context.getViewport()?.viewport.zoom ?? 1;
		const toWorld = (px: number) => px / zoom;

		const originY = topCenter.y + toWorld(CAMERA_UI_MARGIN_PX);
		const length = toWorld(CAMERA_UI_AXIS_LENGTH_PX);
		const step = toWorld(CAMERA_UI_AXIS_LENGTH_PX + CAMERA_UI_AXIS_GAP_PX);

		const handles: CameraUiHandle[] = [
			"cam-axis-x",
			"cam-axis-y",
			"cam-axis-z",
		];
		const totalWidth = step * (handles.length - 1);

		const primitives: UIPrimitive[] = [];
		handles.forEach((handle, i) => {
			const originX = topCenter.x - totalWidth / 2 + step * i;
			primitives.push(...cameraUiAxisHandle(handle, originX, originY, length));
		});

		this.context.uiSetOverlay(CAMERA_UI_OVERLAY_KEY, { primitives });
	}

	/** Rebuild (or clear) the move gizmo overlay for the selected node. */
	private refreshGizmo(cameraOverride?: Reference3DCamera): void {
		const state = this.getEditState();
		const controller = this.context.reference3dController;
		const nodeId = controller?.getSelectedNodeId();
		const node = state?.def.nodes.find((n) => n.id === nodeId);
		if (!state || !node || controller?.getMode() === "pose") {
			this.context.uiSetOverlay(GIZMO_OVERLAY_KEY, null);
			return;
		}

		const camera = cameraOverride ?? this.currentCamera(state);
		const aspect = state.localRect.width / state.localRect.height;
		const position = node.transform.position;
		const originNdc = projectToNdc(position, camera, aspect);
		if (!originNdc) {
			this.context.uiSetOverlay(GIZMO_OVERLAY_KEY, null);
			return;
		}
		const originLocal = ndcToLocal(originNdc, state.localRect);
		const origin = toCanvasPoint(state, originLocal);

		const zoom = this.context.getViewport()?.viewport.zoom ?? 1;
		// Arrows target a fixed on-screen length; the element's own scale is
		// applied on the way back to canvas space, so divide it out here.
		const axisLength =
			GIZMO_AXIS_SCREEN_PX / (zoom * meanTransformScale(state.transform));

		const primitives: UIPrimitive[] = [];
		// Hovered handles render in the shared highlight color.
		const colorFor = (handle: GizmoHandle, base: RGBA): RGBA =>
			this.hoveredGizmoHandle === handle
				? UI_THEME.colors.reference3dHandleHover
				: base;

		// Rotation rings first: same z as the arrows, so the later-inserted
		// arrows win hit-test ties where they overlap.
		const ringRadius = this.ringRadiusLocal(state);
		const ringProject = reference3dProjector(camera, aspect, state.localRect);
		for (const handle of ["rotate-x", "rotate-y", "rotate-z"] as const) {
			const ringPoints = projectRingPoints(
				position,
				ROTATE_AXIS_DIRECTIONS[handle],
				ringRadius,
				ringProject,
			);
			if (!ringPoints) continue;
			primitives.push({
				kind: "polyline",
				points: ringPoints.map((p) => toCanvasPoint(state, p)),
				closed: true,
				stroke: { color: colorFor(handle, ROTATE_COLORS[handle]), width: 1.5 },
				hitId: handle,
				hitPadding: { screen: 5 },
			});
		}

		for (const handle of ["axis-x", "axis-y", "axis-z"] as const) {
			const axisVec = axisLocalVector(
				position,
				AXIS_DIRECTIONS[handle],
				camera,
				aspect,
				state.localRect,
			);
			if (!axisVec) continue;
			const len = Math.hypot(axisVec.x, axisVec.y);
			if (len < 1e-6) continue;
			const tip = toCanvasPoint(state, {
				x: originLocal.x + (axisVec.x / len) * axisLength,
				y: originLocal.y + (axisVec.y / len) * axisLength,
			});
			primitives.push({
				kind: "arrow",
				x1: origin.x,
				y1: origin.y,
				x2: tip.x,
				y2: tip.y,
				color: colorFor(handle, AXIS_COLORS[handle]),
				width: 2,
				headLength: { screen: 10 },
				headWidth: { screen: 7 },
				hitId: handle,
				hitPadding: { screen: 6 },
			});

			// Per-axis scale box just past the arrow tip.
			const scaleHandleId = `scale-${handle.slice(5)}` as AxisScaleGizmoHandle;
			const box = toCanvasPoint(state, {
				x: originLocal.x + (axisVec.x / len) * axisLength * 1.27,
				y: originLocal.y + (axisVec.y / len) * axisLength * 1.27,
			});
			primitives.push({
				kind: "rect",
				cx: box.x,
				cy: box.y,
				width: { screen: 7 },
				height: { screen: 7 },
				fill: { color: colorFor(scaleHandleId, AXIS_COLORS[handle]) },
				hitId: scaleHandleId,
				hitPadding: { screen: 4 },
				zIndex: 1,
			});
		}
		primitives.push({
			kind: "rect",
			cx: origin.x,
			cy: origin.y,
			width: { screen: 12 },
			height: { screen: 12 },
			fill: { color: colorFor("plane", UI_THEME.colors.reference3dPlaneFill) },
			stroke: { color: UI_THEME.colors.reference3dPlaneOutline, width: 1 },
			hitId: "plane",
			zIndex: 1,
		});

		// Uniform-scale handle: diamond on the screen diagonal, outside the
		// rotation rings so the two drags don't compete.
		const scaleOffsetLocal =
			((GIZMO_RING_SCREEN_PX * 1.25) /
				(zoom * meanTransformScale(state.transform))) *
			Math.SQRT1_2;
		const scaleHandle = toCanvasPoint(state, {
			x: originLocal.x + scaleOffsetLocal,
			y: originLocal.y + scaleOffsetLocal,
		});
		primitives.push({
			kind: "diamond",
			cx: scaleHandle.x,
			cy: scaleHandle.y,
			halfSize: { screen: 6 },
			fill: { color: colorFor("scale", UI_THEME.colors.reference3dPlaneFill) },
			stroke: { color: UI_THEME.colors.reference3dPlaneOutline, width: 1 },
			hitId: "scale",
			hitPadding: { screen: 4 },
			zIndex: 1,
		});

		this.context.uiSetOverlay(GIZMO_OVERLAY_KEY, { primitives });
	}

	// --- Pose mode (VRM figures) ---

	/** Rig + root transform + figure node of the current pose session. */
	private getPoseState(state: EditState): {
		node: FigureNode;
		rig: IKRigData;
		root: RootTransform;
	} | null {
		const nodeId = this.context.reference3dController?.getPoseNodeId();
		const node = state.def.nodes.find((n) => n.id === nodeId);
		if (!node || node.kind !== "figure") return null;
		const rig = this.context.reference3dGetFigureRig(node.fileUid);
		if (!rig) return null;
		return {
			node,
			rig,
			root: {
				position: node.transform.position,
				rotation: node.transform.rotation,
			},
		};
	}

	private beginPoseDrag(
		state: EditState,
		handleId: string,
		pointerLocal: { x: number; y: number },
	): void {
		const bone = handleId.startsWith("bone/") ? handleId.slice(5) : handleId;
		const handle = POSE_HANDLES[bone];
		const pose = this.getPoseState(state);
		if (!handle || !pose) return;

		const joints = computeWorldJoints(pose.rig, pose.node.pose, pose.root);
		const joint = joints.get(bone);
		if (!joint) return;

		const camera = this.currentCamera(state);
		const basis = cameraBasis(camera);
		this.dragState = {
			type: "pose",
			handleBone: bone,
			handle,
			nodeId: pose.node.id,
			startNodes: state.def.nodes.map((n) => ({ ...n })),
			startPose: {
				bones: { ...pose.node.pose.bones },
				hipsPosition: pose.node.pose.hipsPosition,
			},
			rig: pose.rig,
			root: pose.root,
			startJointWorld: joint.position,
			startPointerLocal: pointerLocal,
			planeBasis: { right: basis.right, up: basis.up },
			worldPerLocalUnit: worldPerLocalUnitAt(
				joint.position,
				camera,
				state.localRect.height,
			),
			currentPose: null,
		};
	}

	private movePoseDrag(
		state: EditState,
		drag: PoseDragState,
		deltaLocal: { x: number; y: number },
	): void {
		// The dragged joint moves in the camera-parallel plane at its depth.
		const target = add3(
			drag.startJointWorld,
			add3(
				scale3(drag.planeBasis.right, deltaLocal.x * drag.worldPerLocalUnit),
				scale3(drag.planeBasis.up, deltaLocal.y * drag.worldPerLocalUnit),
			),
		);

		const pose = applyPoseHandleDrag({
			handleBone: drag.handleBone,
			handle: drag.handle,
			rig: drag.rig,
			root: drag.root,
			startPose: drag.startPose,
			startJointWorld: drag.startJointWorld,
			targetWorld: target,
		});
		if (!pose) return;

		drag.currentPose = pose;
		this.context.reference3dPreviewNodes(
			state.element.sceneId,
			drag.startNodes.map((node) =>
				node.id === drag.nodeId && node.kind === "figure"
					? { ...node, pose }
					: node,
			),
		);
		this.refreshPoseOverlay();
	}

	/** Rebuild (or clear) the pose-mode bone handle overlay. */
	private refreshPoseOverlay(cameraOverride?: Reference3DCamera): void {
		const controller = this.context.reference3dController;
		const state = this.getEditState();
		if (!state || controller?.getMode() !== "pose") {
			this.context.uiSetOverlay(POSE_OVERLAY_KEY, null);
			return;
		}
		const pose = this.getPoseState(state);
		if (!pose) {
			this.context.uiSetOverlay(POSE_OVERLAY_KEY, null);
			return;
		}

		const camera = cameraOverride ?? this.currentCamera(state);
		const aspect = state.localRect.width / state.localRect.height;
		const joints = computeWorldJoints(pose.rig, pose.node.pose, pose.root);

		const primitives: UIPrimitive[] = [];
		for (const bone of Object.keys(POSE_HANDLES)) {
			const joint = joints.get(bone);
			if (!joint) continue;
			const ndc = projectToNdc(joint.position, camera, aspect);
			if (!ndc) continue;
			const point = toCanvasPoint(state, ndcToLocal(ndc, state.localRect));
			primitives.push({
				kind: "circle",
				cx: point.x,
				cy: point.y,
				radius: { screen: 5 },
				fill: { color: UI_THEME.colors.reference3dBoneFill },
				stroke: { color: UI_THEME.colors.reference3dBoneOutline, width: 1.5 },
				hitId: `bone/${bone}`,
				hitPadding: { screen: 4 },
			});
		}

		this.context.uiSetOverlay(POSE_OVERLAY_KEY, { primitives });
	}
}

// ---------------------------------------------------------------------------
// Element-local ↔ canvas mapping (matches Reference3DElementRenderer's quad blit)
// ---------------------------------------------------------------------------

/**
 * Forward-map an element-local point to canvas world through the composed
 * transform — identical to the renderer's corner transform.
 */
function toCanvasPoint(
	state: EditState,
	point: { x: number; y: number },
): { x: number; y: number } {
	return localToCanvasPoint(point, state.localRect, state.transform);
}

/** Inverse of toCanvasPoint: canvas world → element-local coordinates. */
function toLocalPoint(
	state: EditState,
	point: { x: number; y: number },
): { x: number; y: number } {
	return canvasToLocalPoint(point, state.localRect, state.transform);
}

/** GizmoProjectFn for a scene camera: world-3D → element-local 2D. */
function reference3dProjector(
	camera: Reference3DCamera,
	aspect: number,
	rect: LocalRect,
): GizmoProjectFn {
	return (point) => {
		const ndc = projectToNdc(point, camera, aspect);
		return ndc ? ndcToLocal(ndc, rect) : null;
	};
}

// ---------------------------------------------------------------------------
// Tool-specific camera helpers (shared projection math lives in
// reference3d/perspective/projection.ts)
// ---------------------------------------------------------------------------

const AXIS_DIRECTIONS: Record<Exclude<MoveGizmoHandle, "plane">, Vec3> = {
	"axis-x": [1, 0, 0],
	"axis-y": [0, 1, 0],
	"axis-z": [0, 0, 1],
};

const AXIS_COLORS = {
	"axis-x": UI_THEME.colors.reference3dAxisX,
	"axis-y": UI_THEME.colors.reference3dAxisY,
	"axis-z": UI_THEME.colors.reference3dAxisZ,
} as const;

const ROTATE_AXIS_DIRECTIONS: Record<RotateGizmoHandle, Vec3> = {
	"rotate-x": [1, 0, 0],
	"rotate-y": [0, 1, 0],
	"rotate-z": [0, 0, 1],
};

const AXIS_VECTORS: readonly Vec3[] = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
];

const SCALE_AXIS_INDEX: Record<AxisScaleGizmoHandle, 0 | 1 | 2> = {
	"scale-x": 0,
	"scale-y": 1,
	"scale-z": 2,
};

const ROTATE_COLORS = {
	"rotate-x": UI_THEME.colors.reference3dAxisX,
	"rotate-y": UI_THEME.colors.reference3dAxisY,
	"rotate-z": UI_THEME.colors.reference3dAxisZ,
} as const;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Element-local vector produced by moving +1 world-3D unit along `axis`. */
function axisLocalVector(
	position: Vec3,
	axis: Vec3,
	camera: Reference3DCamera,
	aspect: number,
	rect: LocalRect,
): { x: number; y: number } | null {
	const fromNdc = projectToNdc(position, camera, aspect);
	const toNdc = projectToNdc(add3(position, axis), camera, aspect);
	if (!fromNdc || !toNdc) return null;
	const from = ndcToLocal(fromNdc, rect);
	const to = ndcToLocal(toNdc, rect);
	return { x: to.x - from.x, y: to.y - from.y };
}

/** World-3D units per element-local unit at the given point's view depth. */
function worldPerLocalUnitAt(
	point: Vec3,
	camera: Reference3DCamera,
	rectHeight: number,
): number {
	const depth = Math.max(
		dot3(sub3(point, camera.position), cameraBasis(camera).forward),
		1e-6,
	);
	return viewHalfHeightAt(camera, depth) / (rectHeight / 2);
}

/** Orbit around the target: yaw around +Y, pitch clamped off the poles. */
function orbitCamera(
	camera: Reference3DCamera,
	dxPx: number,
	dyPx: number,
): Reference3DCamera {
	const offset = sub3(camera.position, camera.target);
	const radius = Math.max(length3(offset), 1e-6);
	let theta = Math.atan2(offset[0], offset[2]);
	let phi = Math.acos(clamp(offset[1] / radius, -1, 1));

	// Dragging right swings the camera counter-clockwise (seen from above),
	// so the scene turns with the pointer instead of against it.
	theta += dxPx * ORBIT_SPEED;
	phi = clamp(phi + dyPx * ORBIT_SPEED, 0.05, Math.PI - 0.05);

	const sinPhi = Math.sin(phi);
	return {
		...camera,
		position: add3(camera.target, [
			radius * sinPhi * Math.sin(theta),
			radius * Math.cos(phi),
			radius * sinPhi * Math.cos(theta),
		]),
	};
}

/**
 * Pan camera + target together along the view plane. The drag delta arrives
 * in element-local units (Y up), so scene content follows the pointer even
 * on rotated elements.
 */
function panCamera(
	camera: Reference3DCamera,
	deltaLocal: { x: number; y: number },
	worldPerLocalUnit: number,
): Reference3DCamera {
	const basis = cameraBasis(camera);
	// Content follows the pointer — the camera moves the opposite way.
	const offset = add3(
		scale3(basis.right, -deltaLocal.x * worldPerLocalUnit),
		scale3(basis.up, -deltaLocal.y * worldPerLocalUnit),
	);
	return {
		...camera,
		position: add3(camera.position, offset),
		target: add3(camera.target, offset),
	};
}

/** Dolly along the view axis, clamped to sane distances. */
function dollyCamera(
	camera: Reference3DCamera,
	deltaY: number,
): Reference3DCamera {
	return dollyCameraByFactor(camera, Math.exp(deltaY * DOLLY_SPEED));
}

/**
 * Resolve a `CameraDragState`'s current pointer position into a camera.
 * "axis-x"/"axis-y" reuse `panCamera` with the other delta axis zeroed out
 * (same "content follows the pointer" feel, constrained to one camera-local
 * axis); "axis-z" dollies, since a view-axis drag has no 2D screen
 * projection to follow.
 */
function computeCameraDrag(
	drag: CameraDragState,
	event: { x: number; y: number },
	pointerLocal: { x: number; y: number },
): Reference3DCamera {
	const deltaLocal = {
		x: pointerLocal.x - drag.startPointerLocal.x,
		y: pointerLocal.y - drag.startPointerLocal.y,
	};
	switch (drag.mode) {
		case "orbit":
			return orbitCamera(
				drag.startCamera,
				event.x - drag.startX,
				event.y - drag.startY,
			);
		case "pan":
			return panCamera(drag.startCamera, deltaLocal, drag.worldPerLocalUnit);
		case "axis-x":
			return panCamera(
				drag.startCamera,
				{ x: deltaLocal.x, y: 0 },
				drag.worldPerLocalUnit,
			);
		case "axis-y":
			return panCamera(
				drag.startCamera,
				{ x: 0, y: deltaLocal.y },
				drag.worldPerLocalUnit,
			);
		case "axis-z":
			return dollyCamera(drag.startCamera, event.y - drag.startY);
	}
}

/** Scale the camera-to-target distance by `factor`, clamped to sane range. */
function dollyCameraByFactor(
	camera: Reference3DCamera,
	factor: number,
): Reference3DCamera {
	const offset = sub3(camera.position, camera.target);
	const distance = Math.max(length3(offset), 1e-6);
	const next = clamp(distance * factor, DOLLY_MIN_DISTANCE, DOLLY_MAX_DISTANCE);
	return {
		...camera,
		position: add3(camera.target, scale3(normalize3(offset), next)),
	};
}

const DEG_PER_RAD = 180 / Math.PI;

/** Camera-to-target distance, in meters. For ActionsPanel and the camera UI overlay. */
export function getCameraDistance(camera: Reference3DCamera): number {
	return length3(sub3(camera.position, camera.target));
}

/**
 * Camera orbit angles around the target, in degrees, using the same
 * convention as the light direction controls: yaw is the horizontal swing,
 * pitch is elevation off the horizon (0 = level, 90 = straight down).
 * For ActionsPanel.
 */
export function getCameraOrbitAngles(camera: Reference3DCamera): {
	yawDeg: number;
	pitchDeg: number;
} {
	const offset = sub3(camera.position, camera.target);
	const radius = Math.max(length3(offset), 1e-6);
	const theta = Math.atan2(offset[0], offset[2]);
	const phi = Math.acos(clamp(offset[1] / radius, -1, 1));
	return {
		yawDeg: theta * DEG_PER_RAD,
		pitchDeg: 90 - phi * DEG_PER_RAD,
	};
}

/** Set the camera-to-target distance to an absolute value, clamped to sane range. For ActionsPanel and the camera UI overlay. */
export function setCameraDistance(
	camera: Reference3DCamera,
	distance: number,
): Reference3DCamera {
	const offset = sub3(camera.position, camera.target);
	const clamped = clamp(distance, DOLLY_MIN_DISTANCE, DOLLY_MAX_DISTANCE);
	return {
		...camera,
		position: add3(camera.target, scale3(normalize3(offset), clamped)),
	};
}

/** Set the camera's orbit angles around the target to absolute values (see getCameraOrbitAngles). For ActionsPanel. */
export function setCameraOrbitAngles(
	camera: Reference3DCamera,
	yawDeg: number,
	pitchDeg: number,
): Reference3DCamera {
	const offset = sub3(camera.position, camera.target);
	const radius = Math.max(length3(offset), 1e-6);
	const theta = yawDeg / DEG_PER_RAD;
	const phi = clamp((90 - pitchDeg) / DEG_PER_RAD, 0.05, Math.PI - 0.05);
	const sinPhi = Math.sin(phi);
	return {
		...camera,
		position: add3(camera.target, [
			radius * sinPhi * Math.sin(theta),
			radius * Math.cos(phi),
			radius * sinPhi * Math.cos(theta),
		]),
	};
}

/**
 * Camera axis-drag handle glyph, anchored at (originX, originY): an arrow
 * along the handle's own local axis for X (right) and Y (up); Z (forward)
 * has no 2D screen projection to draw as an arrow, so it's a dolly dot
 * instead — same axis coloring as the move gizmo's arrows.
 */
function cameraUiAxisHandle(
	handle: CameraUiHandle,
	originX: number,
	originY: number,
	length: number,
): UIPrimitive[] {
	if (handle === "cam-axis-z") {
		return [
			{
				kind: "circle",
				cx: originX,
				cy: originY,
				radius: { screen: CAMERA_UI_AXIS_LENGTH_PX * 0.4 },
				fill: { color: UI_THEME.colors.reference3dAxisZ },
				stroke: { color: UI_THEME.colors.reference3dPlaneOutline, width: 1 },
				hitId: handle,
				hitPadding: { screen: 4 },
			},
		];
	}
	const isX = handle === "cam-axis-x";
	return [
		{
			kind: "arrow",
			x1: originX,
			y1: originY,
			x2: originX + (isX ? length : 0),
			y2: originY + (isX ? 0 : -length),
			color: isX
				? UI_THEME.colors.reference3dAxisX
				: UI_THEME.colors.reference3dAxisY,
			width: 2,
			headLength: { screen: 8 },
			headWidth: { screen: 6 },
			hitId: handle,
			hitPadding: { screen: 6 },
		},
	];
}

function isInsideRect(
	point: { x: number; y: number },
	rect: LocalRect,
): boolean {
	return (
		Math.abs(point.x - rect.cx) <= rect.width / 2 &&
		Math.abs(point.y - rect.cy) <= rect.height / 2
	);
}

/** Return a new node list with one node's position replaced. */
function moveNode(
	nodes: readonly Reference3DNode[],
	nodeId: string,
	position: Vec3,
): Reference3DNode[] {
	return nodes.map((node) =>
		node.id === nodeId
			? { ...node, transform: { ...node.transform, position } }
			: node,
	);
}

function rotateNode(
	nodes: readonly Reference3DNode[],
	nodeId: string,
	rotation: Quat,
): Reference3DNode[] {
	return nodes.map((node) =>
		node.id === nodeId
			? { ...node, transform: { ...node.transform, rotation } }
			: node,
	);
}

function scaleNode(
	nodes: readonly Reference3DNode[],
	nodeId: string,
	scale: Vec3,
): Reference3DNode[] {
	return nodes.map((node) =>
		node.id === nodeId
			? { ...node, transform: { ...node.transform, scale } }
			: node,
	);
}

// ---------------------------------------------------------------------------
// Pose-mode helpers
// ---------------------------------------------------------------------------

/** Number keys applying preset poses while in pose mode (PRESET_POSES order). */
const PRESET_KEY_ORDER = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"];

/**
 * Resolve one pose-handle drag into a new figure pose:
 * hips translate (root-local), wrists/ankles solve their IK chain, elbows/
 * knees rotate the parent bone (FK), and the head aims at the target.
 */
function applyPoseHandleDrag(args: {
	handleBone: string;
	handle: PoseHandleDef;
	rig: IKRigData;
	root: RootTransform;
	startPose: FigureNode["pose"];
	startJointWorld: Vec3;
	targetWorld: Vec3;
}): FigureNode["pose"] | null {
	const { handle, startPose, rig, root } = args;

	if (handle.kind === "hips") {
		const deltaRootLocal = rotateVec3(
			quatInvert(root.rotation),
			sub3(args.targetWorld, args.startJointWorld),
		);
		const base = startPose.hipsPosition ?? ([0, 0, 0] as Vec3);
		return {
			bones: { ...startPose.bones },
			hipsPosition: add3(base, deltaRootLocal),
		};
	}

	if (handle.kind === "ik" && handle.chain) {
		const solved = solveCCD({
			rig,
			pose: startPose,
			chain: handle.chain,
			targetWorld: args.targetWorld,
			root,
		});
		return {
			bones: { ...startPose.bones, ...solved },
			hipsPosition: startPose.hipsPosition,
		};
	}

	if (handle.kind === "look") {
		const rotation = solveLookAt({
			rig,
			pose: startPose,
			bone: args.handleBone,
			forward: HEAD_FORWARD,
			targetWorld: args.targetWorld,
			maxAngleDeg: HEAD_MAX_ANGLE_DEG,
			root,
		});
		if (!rotation) return null;
		return {
			bones: { ...startPose.bones, [args.handleBone]: rotation },
			hipsPosition: startPose.hipsPosition,
		};
	}

	if (handle.kind === "fk" && handle.fkBone) {
		const joints = computeWorldJoints(rig, startPose, root);
		const pivot = joints.get(handle.fkBone);
		if (!pivot) return null;

		const from = normalize3(sub3(args.startJointWorld, pivot.position));
		const to = normalize3(sub3(args.targetWorld, pivot.position));
		if (length3(from) < 1e-9 || length3(to) < 1e-9) return null;

		// World-space swing mapped into the pivot bone's local space (same
		// parent-relative mapping as the CCD step).
		const worldDelta = quatFromTo(from, to);
		const local = startPose.bones[handle.fkBone] ?? ([0, 0, 0, 1] as const);
		const parentWorld = quatMultiply(pivot.rotation, quatInvert([...local]));
		const localDelta = quatMultiply(
			quatInvert(parentWorld),
			quatMultiply(worldDelta, parentWorld),
		);
		return {
			bones: {
				...startPose.bones,
				[handle.fkBone]: quatNormalize(quatMultiply(localDelta, [...local])),
			},
			hipsPosition: startPose.hipsPosition,
		};
	}

	return null;
}

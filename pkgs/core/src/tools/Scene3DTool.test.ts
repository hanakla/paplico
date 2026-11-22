import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIOverlay, UIPrimitive } from "../renderer/ui/primitives";
import { UI_THEME } from "../renderer/ui/theme";
import { type IKRigData, quatToAxisAngle } from "../scene3d/vrm/ikSolver";
import type {
	Quat,
	Scene3DCamera,
	Scene3DDef,
	Scene3DElement,
	Scene3DNode,
	Vec3,
} from "../schema";
import {
	createMockToolContext,
	type MockToolContext,
} from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import { brandWorldBBox } from "../utils/geometry/primitives/box";
import { Scene3DController } from "./Scene3DController";
import { Scene3DTool } from "./Scene3DTool";

const GIZMO_KEY = "scene3d/gizmo";
const EDIT_BOUNDS_KEY = "scene3d/edit-bounds";

interface Harness {
	tool: Scene3DTool;
	context: MockToolContext;
	controller: Scene3DController;
	element: Scene3DElement;
	def: Scene3DDef;
}

describe("Scene3DTool", () => {
	let tool: Scene3DTool;
	let context: MockToolContext;
	let controller: Scene3DController;
	let element: Scene3DElement;
	let def: Scene3DDef;

	beforeEach(() => {
		({ tool, context, controller, element, def } = createHarness());
	});

	function down(x: number, y: number, overrides = {}): void {
		pointerDown(tool, x, y, overrides);
	}
	function move(x: number, y: number): void {
		pointerMove(tool, x, y);
	}
	function up(x: number, y: number): void {
		pointerUp(tool, x, y);
	}
	function pressEscape(): boolean {
		return (
			tool.onKeyDown?.(
				new KeyboardEvent("keydown", { code: "Escape" }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			) ?? false
		);
	}

	describe("entering edit mode", () => {
		it("should create a new scene and enter edit when clicking empty canvas", () => {
			context.scene3dCreate.mockReturnValue(element);

			down(100, 100);
			up(100, 100);

			// screen(100,100) → world(-300,200)
			expect(context.scene3dCreate.mock.calls[0]).toEqual([-300, 200]);
			expect(controller.isEditing()).toBe(true);
			expect(controller.getEditingElementId()).toBe(element.id);
		});

		it("should size the new element by the drag rectangle", () => {
			context.scene3dCreate.mockReturnValue(element);

			down(100, 100);
			move(300, 200);
			up(300, 200);

			// screen(100,100) → world(-300,200), screen(300,200) → world(-100,100):
			// center (-200,150), size 200×100
			expect(context.scene3dCreate.mock.calls[0]).toEqual([
				-200, 150, 200, 100,
			]);
			expect(controller.isEditing()).toBe(true);
		});

		it("should enter edit for an existing scene3d element under the pointer", () => {
			context.findElementAtPoint.mockReturnValue(element);

			down(400, 300);

			expect(context.scene3dCreate).not.toHaveBeenCalled();
			expect(controller.getEditingElementId()).toBe(element.id);
		});

		it("should do nothing while the document is readonly", () => {
			context.isReadonly.mockReturnValue(true);

			down(400, 300);

			expect(context.scene3dCreate).not.toHaveBeenCalled();
			expect(controller.isEditing()).toBe(false);
		});

		it("should set the edited element as the perspective guide source", () => {
			context.findElementAtPoint.mockReturnValue(element);

			down(400, 300);

			expect(context.scene3dSetGuideSource.mock.calls.at(-1)).toEqual([
				element.id,
			]);
		});

		it("should show the element's bounding box as a selection-frame stand-in (entering edit mode clears the real selection)", () => {
			context.findElementAtPoint.mockReturnValue(element);
			context.getBounds.mockReturnValue(
				brandWorldBBox({
					minX: -100,
					minY: -50,
					maxX: 100,
					maxY: 50,
					width: 200,
					height: 100,
				}),
			);

			down(400, 300);

			const overlay = lastEditBoundsOverlay(context);
			expect(overlay).not.toBeNull();
			const rect = overlay?.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "rect" }> => p.kind === "rect",
			);
			expect(rect?.cx).toBe(0);
			expect(rect?.cy).toBe(0);
			expect(rect?.width).toBe(200);
			expect(rect?.height).toBe(100);
		});

		it("should clear the bounding-box overlay once the edit session ends", () => {
			context.findElementAtPoint.mockReturnValue(element);
			context.getBounds.mockReturnValue(
				brandWorldBBox({
					minX: -100,
					minY: -50,
					maxX: 100,
					maxY: 50,
					width: 200,
					height: 100,
				}),
			);
			down(400, 300);
			expect(lastEditBoundsOverlay(context)).not.toBeNull();

			pressEscape();

			expect(lastEditBoundsOverlay(context)).toBeNull();
		});
	});

	describe("tool switching", () => {
		it("should end the edit session on dispose so re-selecting the tool creates a second scene", () => {
			// First scene: clicking empty canvas creates it and enters edit.
			context.scene3dCreate.mockReturnValue(element);
			down(100, 100);
			up(100, 100);
			expect(controller.isEditing()).toBe(true);

			// The user switches to another tool: Paplico cancels and disposes
			// the tool instance while the controller survives in Paplico.
			tool.onCancel();
			tool.dispose();
			expect(controller.isEditing()).toBe(false);

			// Re-selecting the Scene3D tool and clicking another empty spot
			// must create a second scene instead of orbiting the first one.
			const second: Scene3DElement = {
				...makeElement(),
				id: "scene3d-el-2",
				sceneId: "scene-2",
			};
			context.scene3dCreate.mockReturnValue(second);
			const nextTool = new Scene3DTool(context);
			pointerDown(nextTool, 500, 400);
			pointerUp(nextTool, 500, 400);

			expect(context.scene3dCreate).toHaveBeenCalledTimes(2);
			expect(controller.getEditingElementId()).toBe("scene3d-el-2");
		});
	});

	describe("camera orbit", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
		});

		it("should preview the orbited camera during drag without touching Yjs", () => {
			down(400, 300);
			move(450, 300);

			expect(context.updateElement).not.toHaveBeenCalled();
			const [previewId, camera] =
				context.scene3dPreviewCamera.mock.calls.at(-1)!;
			expect(previewId).toBe(element.id);
			expect(camera).not.toBeNull();
			const preview = camera as Scene3DCamera;
			// Orbit keeps the target and the distance to it; the position moves.
			expect(preview.target).toEqual(element.camera.target);
			expect(preview.position).not.toEqual(element.camera.position);
			expect(distance(preview.position, preview.target)).toBeCloseTo(
				distance(element.camera.position, element.camera.target),
				6,
			);
		});

		it("should swing the camera counter-clockwise (from above) on a right drag", () => {
			down(400, 300);
			move(450, 300);

			const [, camera] = context.scene3dPreviewCamera.mock.calls.at(-1)!;
			const preview = camera as Scene3DCamera;
			// Start position [4,3,6]: azimuth increases → +X side, -Z side.
			expect(preview.position[0]).toBeGreaterThan(element.camera.position[0]);
			expect(preview.position[2]).toBeLessThan(element.camera.position[2]);
			// Horizontal drag leaves the height untouched.
			expect(preview.position[1]).toBeCloseTo(element.camera.position[1], 6);
		});

		it("should commit the camera once on pointer-up and clear the preview", () => {
			down(400, 300);
			move(450, 310);
			up(450, 310);

			expect(context.updateElement).toHaveBeenCalledOnce();
			const [committedId, updates] = context.updateElement.mock.calls[0];
			expect(committedId).toBe(element.id);
			const committed = (updates as { camera: Scene3DCamera }).camera;
			expect(committed.position).not.toEqual(element.camera.position);
			// Preview cleared after the commit.
			expect(context.scene3dPreviewCamera.mock.calls.at(-1)).toEqual([
				element.id,
				null,
			]);
		});

		it("should not commit anything for a click without movement", () => {
			down(400, 300);
			up(400, 300);

			expect(context.updateElement).not.toHaveBeenCalled();
		});

		it("should cancel the drag on Escape without committing", () => {
			down(400, 300);
			move(500, 300);

			expect(pressEscape()).toBe(true);
			expect(context.scene3dPreviewCamera.mock.calls.at(-1)).toEqual([
				element.id,
				null,
			]);

			up(500, 300);
			expect(context.updateElement).not.toHaveBeenCalled();
		});
	});

	describe("camera pan (shift+drag)", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
		});

		it("should move position and target together, keeping their offset", () => {
			down(400, 300, { shiftKey: true });
			move(430, 320);

			const camera = context.scene3dPreviewCamera.mock.calls.at(
				-1,
			)![1] as Scene3DCamera;
			expect(camera.target).not.toEqual(element.camera.target);
			const positionDelta = sub(camera.position, element.camera.position);
			const targetDelta = sub(camera.target, element.camera.target);
			for (let i = 0; i < 3; i++) {
				expect(positionDelta[i]).toBeCloseTo(targetDelta[i], 6);
			}
		});
	});

	describe("camera pan (right-click drag)", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
		});

		it("should move position and target together, keeping their offset", () => {
			down(400, 300, { button: 2 });
			move(430, 320);

			const camera = context.scene3dPreviewCamera.mock.calls.at(
				-1,
			)![1] as Scene3DCamera;
			expect(camera.target).not.toEqual(element.camera.target);
			const positionDelta = sub(camera.position, element.camera.position);
			const targetDelta = sub(camera.target, element.camera.target);
			for (let i = 0; i < 3; i++) {
				expect(positionDelta[i]).toBeCloseTo(targetDelta[i], 6);
			}
		});
	});

	describe("camera move (ActionsPanel axis sliders)", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
		});

		it("should move position and target together along the right axis (x)", () => {
			tool.moveCameraAlongAxis("x", 1);

			expect(context.updateElement).toHaveBeenCalledOnce();
			const [, updates] = context.updateElement.mock.calls[0];
			const camera = (updates as { camera: Scene3DCamera }).camera;
			expect(camera.target).not.toEqual(element.camera.target);
			const positionDelta = sub(camera.position, element.camera.position);
			const targetDelta = sub(camera.target, element.camera.target);
			for (let i = 0; i < 3; i++) {
				expect(positionDelta[i]).toBeCloseTo(targetDelta[i], 6);
			}
		});

		it("should move position and target together along the up axis (y)", () => {
			tool.moveCameraAlongAxis("y", 1);

			const [, updates] = context.updateElement.mock.calls[0];
			const camera = (updates as { camera: Scene3DCamera }).camera;
			const positionDelta = sub(camera.position, element.camera.position);
			const targetDelta = sub(camera.target, element.camera.target);
			for (let i = 0; i < 3; i++) {
				expect(positionDelta[i]).toBeCloseTo(targetDelta[i], 6);
			}
		});

		it("should dolly closer while keeping the target fixed for a positive delta on the forward axis (z)", () => {
			tool.moveCameraAlongAxis("z", 1);

			const [, updates] = context.updateElement.mock.calls[0];
			const camera = (updates as { camera: Scene3DCamera }).camera;
			expect(camera.target).toEqual(element.camera.target);
			expect(distance(camera.position, camera.target)).toBeLessThan(
				distance(element.camera.position, element.camera.target),
			);
		});

		it("should not compound repeated calls within the same drag (offset from a pinned base, not the running total)", () => {
			tool.moveCameraAlongAxis("x", 1);
			tool.moveCameraAlongAxis("x", 2);

			const [, updates] = context.updateElement.mock.calls.at(-1)!;
			const camera = (updates as { camera: Scene3DCamera }).camera;
			// Second call's offset (2) replaces the first (1) against the same
			// pinned base — a naive per-call accumulation would total 3.
			expect(distance(camera.position, element.camera.position)).toBeCloseTo(
				2,
				6,
			);
		});

		it("should pin a fresh base camera for the next drag after endCameraAxisMove", () => {
			tool.moveCameraAlongAxis("x", 1);
			// Mirror what updateElement would persist, since the mock context
			// doesn't apply it back to getElement on its own.
			const [, firstUpdate] = context.updateElement.mock.calls[0];
			context.getElement.mockReturnValue({
				...element,
				camera: (firstUpdate as { camera: Scene3DCamera }).camera,
			});
			tool.endCameraAxisMove();

			tool.moveCameraAlongAxis("x", 1);

			const [, updates] = context.updateElement.mock.calls.at(-1)!;
			const camera = (updates as { camera: Scene3DCamera }).camera;
			// Two separate 1-unit drags from the committed result each time,
			// totaling 2 units from the original camera.
			expect(distance(camera.position, element.camera.position)).toBeCloseTo(
				2,
				6,
			);
		});
	});

	describe("scene editor", () => {
		beforeEach(() => {
			tool.enterEditorForElement(element);
		});

		function wheel(x: number, y: number, deltaY: number) {
			return (
				tool.onWheel?.(
					{ x, y, deltaY, ctrlKey: false },
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				) ?? false
			);
		}

		it("should start from the element's camera", () => {
			expect(controller.getEditorCamera()).toEqual(element.camera);
		});

		it("should orbit its own camera and leave the element's camera alone", () => {
			down(400, 300);
			move(450, 310);
			up(450, 310);

			const camera = controller.getEditorCamera()!;
			expect(camera.target).toEqual(element.camera.target);
			expect(camera.position).not.toEqual(element.camera.position);
			expect(context.updateElement).not.toHaveBeenCalled();
			expect(context.scene3dPreviewCamera).not.toHaveBeenCalled();
		});

		it("should dolly on a wheel anywhere on the canvas without writing the element", () => {
			// screen(50,50) lies outside the element's 400×300 rect.
			expect(wheel(50, 50, -120)).toBe(true);

			const camera = controller.getEditorCamera()!;
			expect(distance(camera.position, camera.target)).toBeLessThan(
				distance(element.camera.position, element.camera.target),
			);
			expect(context.updateElement).not.toHaveBeenCalled();
		});

		it("should move only its own camera from the panel's camera controls", () => {
			tool.setCameraZoom(3);
			tool.setCameraOrbit(30, 10);
			tool.moveCameraAlongAxis("x", 1);
			tool.endCameraAxisMove();

			expect(controller.getEditorCamera()).not.toEqual(element.camera);
			expect(context.updateElement).not.toHaveBeenCalled();
		});

		it("should put the camera back where the drag started on Escape", () => {
			const before = controller.getEditorCamera();
			down(400, 300);
			move(450, 310);

			expect(pressEscape()).toBe(true);

			expect(controller.getEditorCamera()).toEqual(before);
		});

		it("should pick nodes outside the element's frame, in the frame's view extended", () => {
			context.scene3dRaycastNode.mockReturnValue("node-box");

			// screen(50,50) → world(-350,250) → NDC (-1.75, 1.667) of the
			// 400×300 frame: outside it, on the same projection.
			down(50, 50);

			const request = context.scene3dRaycastNode.mock.calls[0][0];
			expect(request.ndcX).toBeCloseTo(-1.75, 6);
			expect(request.ndcY).toBeCloseTo(250 / 150, 6);
			expect(request.aspect).toBeCloseTo(400 / 300, 6);
			expect(request.camera).toEqual(controller.getEditorCamera());
			expect(controller.getSelectedNodeId()).toBe("node-box");
		});

		it("should snap an orbit to the nearest axis view while Shift is held", () => {
			down(400, 300);
			pointerMove(tool, 420, 290, { shiftKey: true });

			const camera = controller.getEditorCamera()!;
			const [x, y, z] = [0, 1, 2].map(
				(i) => camera.position[i] - camera.target[i],
			);
			// Start [4,2,6] off the target: the nearest axis view is the front.
			expect(x).toBeCloseTo(0, 6);
			expect(y).toBeCloseTo(0, 6);
			expect(z).toBeGreaterThan(0);
			expect(distance(camera.position, camera.target)).toBeCloseTo(
				distance(element.camera.position, element.camera.target),
				6,
			);
		});

		it("should not snap an orbit inside the element's frame edit", () => {
			tool.enterEditModeForElement(element);
			down(400, 300);
			pointerMove(tool, 420, 290, { shiftKey: true });

			const [, camera] = context.scene3dPreviewCamera.mock.calls.at(-1)!;
			const preview = camera as Scene3DCamera;
			expect(preview.position[0] - preview.target[0]).not.toBeCloseTo(0, 3);
		});

		it("should not frame the element or take over the perspective guides", () => {
			expect(lastEditBoundsOverlay(context)).toBeNull();
			expect(context.scene3dSetGuideSource.mock.calls.at(-1)).toEqual([null]);
		});

		it("should drop its camera when the session ends", () => {
			const cameras: Array<Scene3DCamera | null> = [];
			controller.onEditorCameraChange = (camera) => cameras.push(camera);

			pressEscape();

			expect(controller.getEditorCamera()).toBeNull();
			expect(cameras).toEqual([null]);
			expect(context.updateElement).not.toHaveBeenCalled();
		});

		it("should edit inside the frame again when the element is entered with the tool", () => {
			tool.enterEditModeForElement(element);

			down(400, 300);
			move(450, 310);
			up(450, 310);

			expect(controller.getEditorCamera()).toBeNull();
			expect(context.updateElement).toHaveBeenCalledOnce();
		});
	});

	describe("framing the camera (ActionsPanel buttons)", () => {
		const BOUNDS = { min: [9, 0, -1], max: [11, 2, 1] } satisfies {
			min: Vec3;
			max: Vec3;
		};

		beforeEach(() => {
			tool.enterEditModeForElement(element);
			context.scene3dGetNodeBounds.mockReturnValue(BOUNDS);
		});

		function committedCamera(): Scene3DCamera {
			return (
				context.updateElement.mock.calls.at(-1)![1] as { camera: Scene3DCamera }
			).camera;
		}

		it("should aim at the scene's centre, keeping the view direction, at the distance it fits", () => {
			tool.frameScene();

			expect(context.scene3dGetNodeBounds.mock.calls[0][0].nodeId).toBe(
				undefined,
			);
			const camera = committedCamera();
			expect(camera.target).toEqual([10, 1, 0]);
			const before = distance(element.camera.position, element.camera.target);
			const after = distance(camera.position, camera.target);
			for (const i of [0, 1, 2]) {
				expect((camera.position[i] - camera.target[i]) / after).toBeCloseTo(
					(element.camera.position[i] - element.camera.target[i]) / before,
					6,
				);
			}
			// Bounding sphere √3 m in a 50° view: √3 / sin(25°).
			expect(after).toBeCloseTo(
				Math.sqrt(3) / Math.sin((25 * Math.PI) / 180),
				6,
			);
		});

		it("should measure the selected node alone", () => {
			controller.selectNode("node-box");

			tool.frameSelectedNode();

			expect(context.scene3dGetNodeBounds.mock.calls[0][0].nodeId).toBe(
				"node-box",
			);
			expect(committedCamera().target).toEqual([10, 1, 0]);
		});

		it("should do nothing for the selection while no node is selected", () => {
			tool.frameSelectedNode();

			expect(context.updateElement).not.toHaveBeenCalled();
		});

		it("should leave the camera alone while the nodes have no geometry yet", () => {
			context.scene3dGetNodeBounds.mockReturnValue(null);

			tool.frameScene();

			expect(context.updateElement).not.toHaveBeenCalled();
		});
	});

	describe("edit isolation notification", () => {
		it("should notify editing changes for isolation dimming", () => {
			const events: Array<string | null> = [];
			controller.onEditingChange = (id) => events.push(id);

			tool.enterEditModeForElement(element);
			// Nothing selected → Escape ends the edit session directly.
			pressEscape();

			expect(events).toEqual([element.id, null]);
		});
	});

	describe("camera touch gesture (two-finger pan + pinch dolly)", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
		});

		function gesture(
			phase: "start" | "update" | "end",
			centerX: number,
			centerY: number,
			scale: number,
		) {
			return (
				tool.onTouchGesture?.(
					{
						phase,
						centerX,
						centerY,
						deltaX: 0,
						deltaY: 0,
						scale,
					},
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				) ?? false
			);
		}

		it("should not claim a gesture starting outside the element rect", () => {
			expect(gesture("start", 50, 50, 1)).toBe(false);
			expect(context.scene3dPreviewCamera).not.toHaveBeenCalled();
		});

		it("should dolly in on pinch-out and commit once on end", () => {
			expect(gesture("start", 400, 300, 1)).toBe(true);
			expect(gesture("update", 400, 300, 2)).toBe(true);

			const [, preview] = context.scene3dPreviewCamera.mock.calls.at(-1)!;
			const camera = preview as Scene3DCamera;
			// Pinching out to 2x halves the camera-to-target distance.
			expect(distance(camera.position, camera.target)).toBeCloseTo(
				distance(element.camera.position, element.camera.target) / 2,
				6,
			);

			expect(gesture("end", 0, 0, 1)).toBe(true);
			expect(context.updateElement).toHaveBeenCalledOnce();
			// Preview cleared after the commit.
			expect(context.scene3dPreviewCamera.mock.calls.at(-1)).toEqual([
				element.id,
				null,
			]);
		});

		it("should pan the camera with the centroid, keeping the view offset", () => {
			expect(gesture("start", 400, 300, 1)).toBe(true);
			expect(gesture("update", 450, 300, 1)).toBe(true);

			const [, preview] = context.scene3dPreviewCamera.mock.calls.at(-1)!;
			const camera = preview as Scene3DCamera;
			// Pan moves position and target together (same offset, same distance).
			expect(camera.target).not.toEqual(element.camera.target);
			const movedOffset = [
				camera.position[0] - camera.target[0],
				camera.position[1] - camera.target[1],
				camera.position[2] - camera.target[2],
			];
			const startOffset = [
				element.camera.position[0] - element.camera.target[0],
				element.camera.position[1] - element.camera.target[1],
				element.camera.position[2] - element.camera.target[2],
			];
			expect(movedOffset[0]).toBeCloseTo(startOffset[0], 6);
			expect(movedOffset[1]).toBeCloseTo(startOffset[1], 6);
			expect(movedOffset[2]).toBeCloseTo(startOffset[2], 6);
		});

		it("should not commit anything for a gesture without updates", () => {
			expect(gesture("start", 400, 300, 1)).toBe(true);
			expect(gesture("end", 0, 0, 1)).toBe(true);

			expect(context.updateElement).not.toHaveBeenCalled();
		});
	});

	describe("camera dolly (wheel)", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
		});

		function wheel(x: number, y: number, deltaY: number, ctrlKey = false) {
			return (
				tool.onWheel?.(
					{ x, y, deltaY, ctrlKey },
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				) ?? false
			);
		}

		it("should dolly toward the target on wheel-up over the element", () => {
			expect(wheel(400, 300, -120)).toBe(true);

			const camera = (
				context.updateElement.mock.calls[0][1] as { camera: Scene3DCamera }
			).camera;
			expect(distance(camera.position, camera.target)).toBeLessThan(
				distance(element.camera.position, element.camera.target),
			);
			expect(camera.target).toEqual(element.camera.target);
		});

		it("should ignore wheel outside the element rect", () => {
			expect(wheel(50, 50, -120)).toBe(false);
			expect(wheel(50, 50, -5, true)).toBe(false);
			expect(context.updateElement).not.toHaveBeenCalled();
		});

		it("should dolly with trackpad pinch (ctrl+wheel) over the element", () => {
			expect(wheel(400, 300, -5, true)).toBe(true);

			const camera = (
				context.updateElement.mock.calls[0][1] as { camera: Scene3DCamera }
			).camera;
			expect(distance(camera.position, camera.target)).toBeLessThan(
				distance(element.camera.position, element.camera.target),
			);
		});

		it("should accumulate distance across repeated wheel ticks", () => {
			expect(wheel(400, 300, 120)).toBe(true);
			const first = (
				context.updateElement.mock.calls[0][1] as { camera: Scene3DCamera }
			).camera;

			// Reflect the committed camera as the real document update would.
			context.getElement.mockReturnValue({ ...element, camera: first });
			expect(wheel(400, 300, 120)).toBe(true);

			const second = (
				context.updateElement.mock.calls[1][1] as { camera: Scene3DCamera }
			).camera;
			expect(distance(second.position, second.target)).toBeGreaterThan(
				distance(first.position, first.target),
			);
		});
	});

	describe("primitive insertion", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
		});

		it("should add a primitive via the public addPrimitive entry point and select it", () => {
			tool.addPrimitive("cone");

			const [sceneId, node] = context.scene3dAddNode.mock.calls[0];
			expect(sceneId).toBe("scene-1");
			expect(node).toMatchObject({ kind: "primitive", shape: "cone" });
			expect(controller.getSelectedNodeId()).toBe(node.id);
		});

		it("should not add primitives from number keys (moved to the panel)", () => {
			const handled = tool.onKeyDown?.(
				new KeyboardEvent("keydown", { code: "Digit2" }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(false);
			expect(context.scene3dAddNode).not.toHaveBeenCalled();
		});
	});

	describe("node selection and move gizmo", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
			context.scene3dRaycastNode.mockReturnValue("node-box");
		});

		it("should raycast with element-local NDC and select the hit node", () => {
			// screen(500,225) → world(100,75) → NDC (0.5, 0.5) in the 400×300 rect
			down(500, 225);

			const request = context.scene3dRaycastNode.mock.calls[0][0];
			expect(request.sceneId).toBe("scene-1");
			expect(request.ndcX).toBeCloseTo(0.5, 6);
			expect(request.ndcY).toBeCloseTo(0.5, 6);
			expect(request.aspect).toBeCloseTo(400 / 300, 6);
			expect(controller.getSelectedNodeId()).toBe("node-box");

			const overlay = lastGizmoOverlay(context);
			expect(overlay).not.toBeNull();
			const hitIds = overlay!.primitives.map((p) => p.hitId);
			expect(hitIds).toEqual(
				expect.arrayContaining(["axis-x", "axis-y", "axis-z", "plane"]),
			);
		});

		it("should deselect the node when clicking empty space (raycast miss)", () => {
			down(400, 300);
			expect(controller.getSelectedNodeId()).toBe("node-box");

			context.scene3dRaycastNode.mockReturnValue(null);
			down(250, 180);
			up(250, 180);

			expect(controller.getSelectedNodeId()).toBeNull();
			expect(lastGizmoOverlay(context)).toBeNull();
		});

		it("should keep the node selected through a camera drag on empty space", () => {
			down(400, 300);
			context.scene3dRaycastNode.mockReturnValue(null);

			down(250, 180);
			move(300, 200);
			up(300, 200);

			expect(controller.getSelectedNodeId()).toBe("node-box");
		});

		it("should orbit around the selected node instead of the camera target", () => {
			down(400, 300);
			context.scene3dRaycastNode.mockReturnValue(null);
			const node = def.nodes.find((n) => n.id === "node-box")!;
			const pivot = node.transform.position;

			down(250, 180);
			move(330, 200);

			const [, camera] = context.scene3dPreviewCamera.mock.calls.at(-1)!;
			const preview = camera as Scene3DCamera;
			// The camera and its target swing together around the node.
			expect(preview.target).not.toEqual(element.camera.target);
			expect(distance(preview.position, pivot)).toBeCloseTo(
				distance(element.camera.position, pivot),
				6,
			);
			expect(distance(preview.target, pivot)).toBeCloseTo(
				distance(element.camera.target, pivot),
				6,
			);
			expect(distance(preview.position, preview.target)).toBeCloseTo(
				distance(element.camera.position, element.camera.target),
				6,
			);
		});

		it("should move the node along the world X axis via the axis arrow and commit once", () => {
			down(400, 300);
			up(400, 300);

			const committed = dragAlongAxisXArrow({
				tool,
				context,
				controller,
				element,
				def: makeDef(),
			});

			// Preview carried the node moved along world X only.
			const [previewSceneId, previewNodes] =
				context.scene3dPreviewNodes.mock.calls.at(-2)!;
			expect(previewSceneId).toBe("scene-1");
			const previewBox = (previewNodes as Scene3DDef["nodes"]).find(
				(n) => n.id === "node-box",
			)!;
			expect(previewBox.kind).toBe("primitive");
			const previewPos = (previewBox as { transform: { position: Vec3 } })
				.transform.position;
			expect(previewPos[0]).toBeGreaterThan(0);
			expect(previewPos[1]).toBe(0.5);
			expect(previewPos[2]).toBe(0);

			expect(context.scene3dCommitNode).toHaveBeenCalledOnce();
			expect(committed[0]).toBeGreaterThan(0);
			expect(committed[1]).toBe(0.5);
			expect(committed[2]).toBe(0);
			// Node preview cleared after the commit.
			expect(context.scene3dPreviewNodes.mock.calls.at(-1)).toEqual([
				"scene-1",
				null,
			]);
			// The whole gesture wrote Yjs exactly once (via scene3dCommitNode).
			expect(context.updateElement).not.toHaveBeenCalled();
		});
	});

	describe("alt-drag duplicate", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
			context.scene3dRaycastNode.mockReturnValue("node-box");
			down(400, 300);
			up(400, 300);
		});

		it("should add a moved copy instead of moving the original", () => {
			const arrow = lastGizmoOverlay(context)!.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "arrow" }> =>
					p.hitId === "axis-x",
			)!;
			const grab = worldToScreenPoint({
				x: (arrow.x1 + arrow.x2) / 2,
				y: (arrow.y1 + arrow.y2) / 2,
			});
			const drop = worldToScreenPoint({
				x: (arrow.x1 + arrow.x2) / 2 + (arrow.x2 - arrow.x1),
				y: (arrow.y1 + arrow.y2) / 2 + (arrow.y2 - arrow.y1),
			});

			down(grab.x, grab.y, { altKey: true });
			move(drop.x, drop.y);
			up(drop.x, drop.y);

			// The original stays untouched; a single new node is added at the
			// drop position and gets selected.
			expect(context.scene3dCommitNode).not.toHaveBeenCalled();
			expect(context.scene3dAddNode).toHaveBeenCalledOnce();
			const [sceneId, added] = context.scene3dAddNode.mock.calls[0];
			expect(sceneId).toBe("scene-1");
			expect(added.id).not.toBe("node-box");
			expect(added).toMatchObject({ kind: "primitive", shape: "box" });
			expect(added.transform.position[0]).toBeGreaterThan(0);
			expect(controller.getSelectedNodeId()).toBe(added.id);
		});
	});

	describe("rotation gizmo", () => {
		beforeEach(() => {
			tool.enterEditModeForElement(element);
			context.scene3dRaycastNode.mockReturnValue("node-box");
			down(400, 300);
			up(400, 300);
		});

		it("should show rotation rings alongside the move handles", () => {
			const hitIds = lastGizmoOverlay(context)!.primitives.map((p) => p.hitId);
			expect(hitIds).toEqual(
				expect.arrayContaining(["rotate-x", "rotate-y", "rotate-z"]),
			);
		});

		it("should highlight the hovered handle in the shared hover color", () => {
			const ring = lastGizmoOverlay(context)!.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "polyline" }> =>
					p.hitId === "rotate-y",
			)!;
			const point = worldToScreenPoint(ring.points[0]);

			// Hover (no button): the ring re-renders in the highlight color.
			move(point.x, point.y);
			const hovered = lastGizmoOverlay(context)!.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "polyline" }> =>
					p.hitId === "rotate-y",
			)!;
			expect(hovered.stroke?.color).toEqual(UI_THEME.colors.scene3dHandleHover);

			// Leaving the handle restores the base color.
			move(10, 10);
			const rested = lastGizmoOverlay(context)!.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "polyline" }> =>
					p.hitId === "rotate-y",
			)!;
			expect(rested.stroke?.color).not.toEqual(
				UI_THEME.colors.scene3dHandleHover,
			);
		});

		it("should scale one component by dragging an axis scale box", () => {
			const overlay = lastGizmoOverlay(context)!;
			const box = overlay.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "rect" }> =>
					p.hitId === "scale-x",
			)!;
			const center = planeHandleOf(overlay);
			const start = worldToScreenPoint({ x: box.cx, y: box.cy });
			// Doubling the projection along the axis doubles only that component.
			const end = worldToScreenPoint({
				x: center.cx + (box.cx - center.cx) * 2,
				y: center.cy + (box.cy - center.cy) * 2,
			});

			down(start.x, start.y);
			move(end.x, end.y);
			up(end.x, end.y);

			expect(context.scene3dCommitNode).toHaveBeenCalledOnce();
			const patch = context.scene3dCommitNode.mock.calls[0][2] as {
				transform: { scale: Vec3 };
			};
			expect(patch.transform.scale[0]).toBeCloseTo(2, 6);
			expect(patch.transform.scale[1]).toBeCloseTo(1, 6);
			expect(patch.transform.scale[2]).toBeCloseTo(1, 6);
		});

		it("should scale the node uniformly by dragging the scale handle and commit once", () => {
			const overlay = lastGizmoOverlay(context)!;
			const handle = overlay.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "diamond" }> =>
					p.hitId === "scale",
			)!;
			// The plane rect sits on the node's projected center (ratio pivot).
			const center = planeHandleOf(overlay);
			const start = worldToScreenPoint({ x: handle.cx, y: handle.cy });
			// Doubling the distance from the center doubles the scale.
			const end = worldToScreenPoint({
				x: center.cx + (handle.cx - center.cx) * 2,
				y: center.cy + (handle.cy - center.cy) * 2,
			});

			down(start.x, start.y);
			move(end.x, end.y);
			up(end.x, end.y);

			expect(context.scene3dCommitNode).toHaveBeenCalledOnce();
			const patch = context.scene3dCommitNode.mock.calls[0][2] as {
				transform: { scale: Vec3 };
			};
			expect(patch.transform.scale[0]).toBeCloseTo(2, 6);
			expect(patch.transform.scale[1]).toBeCloseTo(2, 6);
			expect(patch.transform.scale[2]).toBeCloseTo(2, 6);
			expect(context.updateElement).not.toHaveBeenCalled();
		});

		it("should keep the ring at a fixed on-screen size across zoom in/out", () => {
			const radiusAtZoom1 = ringWorldRadius(lastGizmoOverlay(context)!);

			// Zoom in 2x: the canvas-world radius halves exactly (the ring is
			// built from the projection linearized at the node center).
			context.getViewport.mockReturnValue({
				viewport: { ...testViewport, zoom: 2 },
				canvasWidth: testCanvasWidth,
				canvasHeight: testCanvasHeight,
			});
			tool.refreshUI();
			expect(ringWorldRadius(lastGizmoOverlay(context)!)).toBeCloseTo(
				radiusAtZoom1 / 2,
				6,
			);

			// Zoom out to 0.25x: the radius grows 4x without perspective warping
			// (the regression case — huge 3D rings distorted or vanished).
			context.getViewport.mockReturnValue({
				viewport: { ...testViewport, zoom: 0.25 },
				canvasWidth: testCanvasWidth,
				canvasHeight: testCanvasHeight,
			});
			tool.refreshUI();
			expect(ringWorldRadius(lastGizmoOverlay(context)!)).toBeCloseTo(
				radiusAtZoom1 * 4,
				6,
			);
		});

		it("should rotate the node around world Y by dragging its ring and commit once", () => {
			const ring = lastGizmoOverlay(context)!.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "polyline" }> =>
					p.hitId === "rotate-y",
			)!;
			const start = worldToScreenPoint(ring.points[0]);
			// A quarter of the ring's samples ahead — stays on the ring path.
			const end = worldToScreenPoint(ring.points[8]);

			down(start.x, start.y);
			move(end.x, end.y);
			up(end.x, end.y);

			expect(context.scene3dCommitNode).toHaveBeenCalledOnce();
			const patch = context.scene3dCommitNode.mock.calls[0][2] as {
				transform: { rotation: Quat };
			};
			const { axis, angle } = quatToAxisAngle(patch.transform.rotation);
			expect(Math.abs(angle)).toBeGreaterThan(0.5);
			expect(Math.abs(axis[1])).toBeCloseTo(1, 3);
			expect(Math.abs(axis[0])).toBeLessThan(1e-3);
			expect(Math.abs(axis[2])).toBeLessThan(1e-3);
			// Position untouched; the whole gesture wrote once via commit.
			expect(context.updateElement).not.toHaveBeenCalled();
			// Node preview cleared after the commit.
			expect(context.scene3dPreviewNodes.mock.calls.at(-1)).toEqual([
				"scene-1",
				null,
			]);
		});
	});

	describe("rotated element (45°)", () => {
		const ROTATION = Math.PI / 4;

		it("should place the gizmo on the rotated pixels (rotated image of the local origin)", () => {
			// Baseline: identity transform — gizmo origin in local coordinates.
			const base = createHarness();
			base.context.scene3dRaycastNode.mockReturnValue("node-box");
			base.tool.enterEditModeForElement(base.element);
			pointerDown(base.tool, 400, 300);
			pointerUp(base.tool, 400, 300);
			const basePlane = planeHandleOf(lastGizmoOverlay(base.context)!);

			// Rotated element: the same handle must land on the rotated image
			// of that local point (transform pivots at the rect center (0,0)).
			const rotated = createHarness({ rotation: ROTATION });
			rotated.context.scene3dRaycastNode.mockReturnValue("node-box");
			rotated.tool.enterEditModeForElement(rotated.element);
			pointerDown(rotated.tool, 400, 300);
			pointerUp(rotated.tool, 400, 300);
			const rotatedPlane = planeHandleOf(lastGizmoOverlay(rotated.context)!);

			const expected = rotatePoint(
				{ x: basePlane.cx, y: basePlane.cy },
				ROTATION,
			);
			expect(rotatedPlane.cx).toBeCloseTo(expected.x, 6);
			expect(rotatedPlane.cy).toBeCloseTo(expected.y, 6);
		});

		it("should raycast the same NDC when the pointer follows the rotated pixels", () => {
			const rotated = createHarness({ rotation: ROTATION });
			rotated.context.scene3dRaycastNode.mockReturnValue("node-box");
			rotated.tool.enterEditModeForElement(rotated.element);

			// Local (100,75) = NDC (0.5, 0.5); its pixels moved to the rotated spot.
			const canvasPoint = rotatePoint({ x: 100, y: 75 }, ROTATION);
			const screen = worldToScreenPoint(canvasPoint);
			pointerDown(rotated.tool, screen.x, screen.y);

			const request = rotated.context.scene3dRaycastNode.mock.calls[0][0];
			expect(request.ndcX).toBeCloseTo(0.5, 6);
			expect(request.ndcY).toBeCloseTo(0.5, 6);
			expect(rotated.controller.getSelectedNodeId()).toBe("node-box");
		});

		it("should commit the same axis-drag amount regardless of element rotation", () => {
			const committedAt = (rotation: number): Vec3 => {
				const harness = createHarness({ rotation });
				harness.context.scene3dRaycastNode.mockReturnValue("node-box");
				harness.tool.enterEditModeForElement(harness.element);
				pointerDown(harness.tool, 400, 300);
				pointerUp(harness.tool, 400, 300);
				return dragAlongAxisXArrow(harness);
			};

			const straight = committedAt(0);
			const rotated = committedAt(ROTATION);

			expect(straight[0]).toBeGreaterThan(0);
			for (let i = 0; i < 3; i++) {
				expect(rotated[i]).toBeCloseTo(straight[i], 6);
			}
		});
	});

	describe("Escape ladder", () => {
		it("should deselect the node first, then exit to the select tool", () => {
			tool.enterEditModeForElement(element);
			context.scene3dRaycastNode.mockReturnValue("node-box");
			down(400, 300);
			up(400, 300);

			expect(pressEscape()).toBe(true);
			expect(controller.getSelectedNodeId()).toBeNull();
			expect(controller.isEditing()).toBe(true);
			expect(context.scene3dExitEdit).not.toHaveBeenCalled();

			expect(pressEscape()).toBe(true);
			expect(controller.isEditing()).toBe(false);
			expect(context.scene3dExitEdit).toHaveBeenCalledOnce();
			// Leaving the edit session also releases the perspective guide source.
			expect(context.scene3dSetGuideSource.mock.calls.at(-1)).toEqual([null]);
		});
	});

	describe("pose mode (VRM figures)", () => {
		function createPoseHarness(): Harness {
			const harness = createHarness();
			harness.def.nodes.push(makeFigureNode());
			harness.context.scene3dGetDef.mockReturnValue(harness.def);
			harness.context.scene3dGetFigureRig.mockReturnValue(makeTestRig());
			harness.context.scene3dRaycastNode.mockReturnValue("node-fig");
			harness.tool.enterEditModeForElement(harness.element);
			return harness;
		}

		function enterPoseMode(harness: Harness): void {
			harness.tool.onDoubleClick?.(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
		}

		function lastPoseOverlay(
			harnessContext: MockToolContext,
		): UIOverlay | null {
			const calls = harnessContext.uiSetOverlay.mock.calls.filter(
				([key]) => key === "scene3d/pose",
			);
			return (calls.at(-1)?.[1] as UIOverlay | null) ?? null;
		}

		function boneHandleScreen(
			harnessContext: MockToolContext,
			bone: string,
		): { x: number; y: number } {
			const overlay = lastPoseOverlay(harnessContext)!;
			const handle = overlay.primitives.find(
				(p) => p.hitId === `bone/${bone}`,
			) as Extract<UIPrimitive, { kind: "circle" }>;
			return worldToScreenPoint({ x: handle.cx, y: handle.cy });
		}

		function dragBoneHandle(
			harness: Harness,
			bone: string,
			dxScreen: number,
			dyScreen: number,
		): void {
			const grab = boneHandleScreen(harness.context, bone);
			pointerDown(harness.tool, grab.x, grab.y);
			pointerMove(harness.tool, grab.x + dxScreen, grab.y + dyScreen);
			pointerUp(harness.tool, grab.x + dxScreen, grab.y + dyScreen);
		}

		function committedPose(harnessContext: MockToolContext): {
			bones: Record<string, [number, number, number, number]>;
			hipsPosition?: [number, number, number];
		} {
			const [, nodeId, patch] =
				harnessContext.scene3dCommitNode.mock.calls.at(-1)!;
			expect(nodeId).toBe("node-fig");
			return (patch as { pose: never }).pose;
		}

		it("should enter pose mode on double-clicking a figure and show bone handles", () => {
			const harness = createPoseHarness();
			enterPoseMode(harness);

			expect(harness.controller.getMode()).toBe("pose");
			expect(harness.controller.getPoseNodeId()).toBe("node-fig");

			const overlay = lastPoseOverlay(harness.context)!;
			const hitIds = overlay.primitives.map((p) => p.hitId);
			expect(hitIds).toEqual(
				expect.arrayContaining([
					"bone/hips",
					"bone/head",
					"bone/leftHand",
					"bone/leftLowerArm",
				]),
			);
		});

		it("should translate the figure via the hips handle (preview → single commit)", () => {
			const harness = createPoseHarness();
			enterPoseMode(harness);

			dragBoneHandle(harness, "hips", 30, 20);

			expect(harness.context.scene3dPreviewNodes).toHaveBeenCalled();
			expect(harness.context.scene3dCommitNode).toHaveBeenCalledOnce();
			const pose = committedPose(harness.context);
			expect(pose.hipsPosition).toBeDefined();
			const magnitude = Math.hypot(...(pose.hipsPosition as number[]));
			expect(magnitude).toBeGreaterThan(0.01);
			// Pure translation: no bone rotations introduced.
			expect(Object.keys(pose.bones)).toEqual([]);
			// Preview cleared after the commit.
			expect(harness.context.scene3dPreviewNodes.mock.calls.at(-1)).toEqual([
				"scene-1",
				null,
			]);
		});

		it("should solve arm IK when dragging the hand handle", () => {
			const harness = createPoseHarness();
			enterPoseMode(harness);

			dragBoneHandle(harness, "leftHand", -40, 40);

			const pose = committedPose(harness.context);
			// The IK chain rotated the shoulder and/or elbow away from rest.
			expect(
				Object.keys(pose.bones).some(
					(bone) => bone === "leftUpperArm" || bone === "leftLowerArm",
				),
			).toBe(true);
		});

		it("should rotate the parent bone (FK) when dragging the elbow handle", () => {
			const harness = createPoseHarness();
			enterPoseMode(harness);

			dragBoneHandle(harness, "leftLowerArm", 0, 40);

			const pose = committedPose(harness.context);
			expect(pose.bones.leftUpperArm).toBeDefined();
			expect(pose.bones.leftLowerArm).toBeUndefined();
		});

		it("should apply a preset pose with the number keys", () => {
			const harness = createPoseHarness();
			enterPoseMode(harness);

			const handled = harness.tool.onKeyDown?.(
				new KeyboardEvent("keydown", { code: "Digit4" }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			const pose = committedPose(harness.context);
			// Sit preset: bent legs + lowered hips survive sparsification.
			expect(pose.bones.leftUpperLeg).toBeDefined();
			expect(pose.hipsPosition).toEqual([0, -0.4, 0]);
		});

		it("should step pose → object → deselect → exit on Escape", () => {
			const harness = createPoseHarness();
			enterPoseMode(harness);

			const esc = () =>
				harness.tool.onKeyDown?.(
					new KeyboardEvent("keydown", { code: "Escape" }),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				) ?? false;

			expect(esc()).toBe(true);
			expect(harness.controller.getMode()).toBe("object");
			expect(harness.controller.isEditing()).toBe(true);
			expect(lastPoseOverlay(harness.context)).toBeNull();

			expect(esc()).toBe(true);
			expect(harness.controller.getSelectedNodeId()).toBeNull();

			expect(esc()).toBe(true);
			expect(harness.controller.isEditing()).toBe(false);
			expect(harness.context.scene3dExitEdit).toHaveBeenCalledOnce();
		});
	});
});

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function createHarness(options: { rotation?: number } = {}): Harness {
	const controller = new Scene3DController();
	const element = makeElement(options.rotation ?? 0);
	const def = makeDef();
	const context = createMockToolContext({
		scene3dController: controller,
		getElement: vi.fn(() => element),
		scene3dGetDef: vi.fn(() => def),
		getViewport: vi.fn(() => ({
			viewport: testViewport,
			canvasWidth: testCanvasWidth,
			canvasHeight: testCanvasHeight,
		})),
	});
	return {
		tool: new Scene3DTool(context),
		context,
		controller,
		element,
		def,
	};
}

function makeElement(rotation = 0): Scene3DElement {
	return {
		id: "scene3d-el",
		type: "scene3d",
		opacity: 1,
		blendMode: "normal",
		transform: { x: 0, y: 0, rotation, scaleX: 1, scaleY: 1 },
		sceneId: "scene-1",
		camera: {
			projection: "perspective",
			position: [4, 3, 6],
			target: [0, 1, 0],
			fovDeg: 50,
		},
		x: 0,
		y: 0,
		width: 400,
		height: 300,
		displayMode: "lineart",
	};
}

function makeDef(): Scene3DDef {
	return {
		id: "scene-1",
		nodes: [
			{
				id: "node-box",
				kind: "primitive",
				shape: "box",
				transform: {
					position: [0, 0.5, 0],
					rotation: [0, 0, 0, 1],
					scale: [1, 1, 1],
				},
			},
		],
	};
}

function makeFigureNode(): Scene3DNode {
	return {
		id: "node-fig",
		kind: "figure",
		fileUid: "vrm-1",
		transform: {
			position: [0, 0, 0],
			rotation: [0, 0, 0, 1],
			scale: [1, 1, 1],
		},
		pose: { bones: {} },
	};
}

/** Simplified humanoid rest rig (subset of the VRM normalized bones). */
function makeTestRig(): IKRigData {
	return {
		bones: [
			{ name: "hips", parent: null, restPosition: [0, 1, 0] },
			{ name: "spine", parent: "hips", restPosition: [0, 0.2, 0] },
			{ name: "head", parent: "spine", restPosition: [0, 0.5, 0] },
			{ name: "leftUpperArm", parent: "spine", restPosition: [0.2, 0.35, 0] },
			{
				name: "leftLowerArm",
				parent: "leftUpperArm",
				restPosition: [0.25, 0, 0],
			},
			{ name: "leftHand", parent: "leftLowerArm", restPosition: [0.25, 0, 0] },
			{
				name: "rightUpperArm",
				parent: "spine",
				restPosition: [-0.2, 0.35, 0],
			},
			{
				name: "rightLowerArm",
				parent: "rightUpperArm",
				restPosition: [-0.25, 0, 0],
			},
			{
				name: "rightHand",
				parent: "rightLowerArm",
				restPosition: [-0.25, 0, 0],
			},
			{ name: "leftUpperLeg", parent: "hips", restPosition: [0.1, -0.05, 0] },
			{
				name: "leftLowerLeg",
				parent: "leftUpperLeg",
				restPosition: [0, -0.45, 0],
			},
			{ name: "leftFoot", parent: "leftLowerLeg", restPosition: [0, -0.45, 0] },
			{
				name: "rightUpperLeg",
				parent: "hips",
				restPosition: [-0.1, -0.05, 0],
			},
			{
				name: "rightLowerLeg",
				parent: "rightUpperLeg",
				restPosition: [0, -0.45, 0],
			},
			{
				name: "rightFoot",
				parent: "rightLowerLeg",
				restPosition: [0, -0.45, 0],
			},
		],
	};
}

function pointerDown(
	tool: Scene3DTool,
	x: number,
	y: number,
	overrides = {},
): void {
	tool.onPointerDown(
		ev(x, y, overrides),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
}

function pointerMove(
	tool: Scene3DTool,
	x: number,
	y: number,
	overrides = {},
): void {
	tool.onPointerMove(
		ev(x, y, overrides),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
}

function pointerUp(tool: Scene3DTool, x: number, y: number): void {
	tool.onPointerUp(ev(x, y), testViewport, testCanvasWidth, testCanvasHeight);
}

function lastGizmoOverlay(context: MockToolContext): UIOverlay | null {
	const calls = context.uiSetOverlay.mock.calls.filter(
		([key]) => key === GIZMO_KEY,
	);
	return (calls.at(-1)?.[1] as UIOverlay | null) ?? null;
}

function lastEditBoundsOverlay(context: MockToolContext): UIOverlay | null {
	const calls = context.uiSetOverlay.mock.calls.filter(
		([key]) => key === EDIT_BOUNDS_KEY,
	);
	return (calls.at(-1)?.[1] as UIOverlay | null) ?? null;
}

/** Mean canvas-world distance of the rotate-y ring's points from their centroid. */
function ringWorldRadius(overlay: UIOverlay): number {
	const ring = overlay.primitives.find(
		(p): p is Extract<UIPrimitive, { kind: "polyline" }> =>
			p.hitId === "rotate-y",
	)!;
	const cx = ring.points.reduce((sum, p) => sum + p.x, 0) / ring.points.length;
	const cy = ring.points.reduce((sum, p) => sum + p.y, 0) / ring.points.length;
	return (
		ring.points.reduce((sum, p) => sum + Math.hypot(p.x - cx, p.y - cy), 0) /
		ring.points.length
	);
}

function planeHandleOf(overlay: UIOverlay): { cx: number; cy: number } {
	const plane = overlay.primitives.find((p) => p.hitId === "plane") as Extract<
		UIPrimitive,
		{ kind: "rect" }
	>;
	return { cx: plane.cx, cy: plane.cy };
}

/**
 * With the node already selected, grab the X-axis arrow at its shaft midpoint
 * and drag by one arrow-vector along its direction. Returns the committed
 * node position from scene3dCommitNode.
 */
function dragAlongAxisXArrow(harness: Harness): Vec3 {
	const arrow = lastGizmoOverlay(harness.context)!.primitives.find(
		(p) => p.hitId === "axis-x",
	) as Extract<UIPrimitive, { kind: "arrow" }>;

	// Grab the shaft midpoint (clear of the plane handle at the origin).
	const grabWorld = {
		x: (arrow.x1 + arrow.x2) / 2,
		y: (arrow.y1 + arrow.y2) / 2,
	};
	const grabScreen = worldToScreenPoint(grabWorld);
	pointerDown(harness.tool, grabScreen.x, grabScreen.y);

	const dragScreen = worldToScreenPoint({
		x: grabWorld.x + (arrow.x2 - arrow.x1),
		y: grabWorld.y + (arrow.y2 - arrow.y1),
	});
	pointerMove(harness.tool, dragScreen.x, dragScreen.y);
	pointerUp(harness.tool, dragScreen.x, dragScreen.y);

	const [, , patch] = harness.context.scene3dCommitNode.mock.calls[0];
	return (patch as { transform: { position: Vec3 } }).transform.position;
}

/** Canvas world (zoom=1, canvas 800×600) → screen coordinates. */
function worldToScreenPoint(point: { x: number; y: number }): {
	x: number;
	y: number;
} {
	return {
		x: testCanvasWidth / 2 + point.x,
		y: testCanvasHeight / 2 - point.y,
	};
}

/** Rotate a canvas point CCW around the origin (element center at (0,0)). */
function rotatePoint(
	point: { x: number; y: number },
	angle: number,
): { x: number; y: number } {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return {
		x: point.x * cos - point.y * sin,
		y: point.x * sin + point.y * cos,
	};
}

function sub(a: Vec3, b: Vec3): Vec3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function distance(a: Vec3, b: Vec3): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

import type { Scene3DCamera } from "../schema";

/**
 * Enter-to-edit session state for the Scene3D tool (TextToolController
 * pattern). Owned by Paplico so the editing session survives tool instance
 * re-creation on tool switches; the tool reads and mutates it through
 * ToolContext.scene3dController.
 *
 * Mode ladder: object → pose. Escape climbs back down one step at
 * a time (pose → object → end edit).
 *
 * A session edits the scene either inside the element's own frame, through
 * the element's camera, or in the scene editor, which fills the canvas and
 * views the scene through a camera of its own.
 */
export class Scene3DController {
	/**
	 * Notified when the editing element changes (enter / switch / exit).
	 * Paplico uses it to re-render the document with isolation dimming.
	 */
	public onEditingChange: ((elementId: string | null) => void) | null = null;
	/**
	 * Notified when the selected node changes. Paplico mirrors it into the
	 * reactive store so React (node context actions) can follow.
	 */
	public onNodeSelectionChange: ((nodeId: string | null) => void) | null = null;
	/**
	 * Notified when the scene editor's camera changes, and with null when the
	 * editor closes. Paplico mirrors it into the reactive store so the
	 * renderer and React (camera controls) can follow.
	 */
	public onEditorCameraChange: ((camera: Scene3DCamera | null) => void) | null =
		null;

	private editingElementId: string | null = null;
	private selectedNodeId: string | null = null;
	private mode: "object" | "pose" = "object";
	/** Figure node being posed (pose mode only). */
	private poseNodeId: string | null = null;
	/** The scene editor's camera; null while the session edits inside the frame. */
	private editorCamera: Scene3DCamera | null = null;

	/** Start editing the scene inside the element's own frame. */
	public startEdit(elementId: string): void {
		const changed = this.editingElementId !== elementId;
		this.editingElementId = elementId;
		this.selectNode(null);
		this.mode = "object";
		this.poseNodeId = null;
		this.setEditorCamera(null);
		if (changed) this.onEditingChange?.(elementId);
	}

	/**
	 * Start editing the scene in the scene editor, which views it through
	 * `camera` from then on. The element's own camera is never written.
	 */
	public startEditor(elementId: string, camera: Scene3DCamera): void {
		this.startEdit(elementId);
		this.setEditorCamera(camera);
	}

	public endEdit(): void {
		const changed = this.editingElementId !== null;
		this.editingElementId = null;
		this.selectNode(null);
		this.mode = "object";
		this.poseNodeId = null;
		this.setEditorCamera(null);
		if (changed) this.onEditingChange?.(null);
	}

	public getEditorCamera(): Scene3DCamera | null {
		return this.editorCamera;
	}

	public setEditorCamera(camera: Scene3DCamera | null): void {
		if (this.editorCamera === camera) return;
		this.editorCamera = camera;
		this.onEditorCameraChange?.(camera);
	}

	public isEditing(): boolean {
		return this.editingElementId !== null;
	}

	public getEditingElementId(): string | null {
		return this.editingElementId;
	}

	public selectNode(nodeId: string | null): void {
		const changed = this.selectedNodeId !== nodeId;
		this.selectedNodeId = nodeId;
		if (changed) this.onNodeSelectionChange?.(nodeId);
	}

	public getSelectedNodeId(): string | null {
		return this.selectedNodeId;
	}

	public getMode(): "object" | "pose" {
		return this.mode;
	}

	public enterPoseMode(figureNodeId: string): void {
		this.mode = "pose";
		this.poseNodeId = figureNodeId;
	}

	public exitPoseMode(): void {
		this.mode = "object";
		this.poseNodeId = null;
	}

	public getPoseNodeId(): string | null {
		return this.poseNodeId;
	}
}

/**
 * Enter-to-edit session state for the Reference3D tool (TextToolController
 * pattern). Owned by Paplico so the editing session survives tool instance
 * re-creation on tool switches; the tool reads and mutates it through
 * ToolContext.reference3dController.
 *
 * Mode ladder: object → pose. Escape climbs back down one step at
 * a time (pose → object → end edit).
 */
export class Reference3DController {
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

	private editingElementId: string | null = null;
	private selectedNodeId: string | null = null;
	private mode: "object" | "pose" = "object";
	/** Figure node being posed (pose mode only). */
	private poseNodeId: string | null = null;

	public startEdit(elementId: string): void {
		const changed = this.editingElementId !== elementId;
		this.editingElementId = elementId;
		this.selectNode(null);
		this.mode = "object";
		this.poseNodeId = null;
		if (changed) this.onEditingChange?.(elementId);
	}

	public endEdit(): void {
		const changed = this.editingElementId !== null;
		this.editingElementId = null;
		this.selectNode(null);
		this.mode = "object";
		this.poseNodeId = null;
		if (changed) this.onEditingChange?.(null);
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

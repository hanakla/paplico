import { useDeferredValue, useMemo } from "react";
import { useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import { isReference3D } from "@/core/schema";
import { useSelectedElements } from "@/hooks/paplico/useSelectedElements";
import { useTranslation } from "@/locales";
import { uiState } from "@/stores/uiStore";
import { BlendOperations } from "./BlendOperations";
import {
	AlignmentControl,
	ElementControls,
	FontFamilyControl,
	FontSizeControl,
	WritingModeControl,
} from "./ElementControls";
import { EraserToolControls } from "./EraserToolControls";
import { EyedropperToolControls } from "./EyedropperToolControls";
import { PathBooleanOperations } from "./PathBooleanOperations";
import { PathEditToolControls } from "./PathEditToolControls";
import { PenToolControls } from "./PenToolControls";
import {
	Reference3DSceneField,
	Reference3DToolControls,
} from "./Reference3DToolControls";
import { RepeatControls } from "./RepeatControls";
import { SelectToolControls } from "./SelectToolControls";
import {
	TextCharTouchModeToggle,
	TextEditingControls,
} from "./TextEditingControls";
import { TransformControls } from "./TransformControls";

/**
 * Context Controls Panel
 * Displays context-sensitive controls based on the current selection
 */
export function ActionsPanel() {
	const t = useTranslation();
	const { uiState: store, tools } = usePaplico();
	const snap = useSnapshot(store);
	const uiSnap = useSnapshot(uiState);
	const toolSnap = useSnapshot(tools.state);

	const isTextEditing = uiSnap.textEditState.isEditing;
	const isGradientStopSelected =
		toolSnap.currentTool === "gradient" &&
		(toolSnap.gradientSelectedStopId != null ||
			toolSnap.gradientSelectedStopIndex != null);
	const isPenTool = toolSnap.currentTool === "pen";
	const isPathEditTool = toolSnap.currentTool === "path-edit";
	const isEraserTool = toolSnap.currentTool === "eraser";
	const isEyedropperTool = toolSnap.currentTool === "eyedropper";
	const isSelectTool = toolSnap.currentTool === "select";
	const isTextTool = toolSnap.currentTool === "text";
	const isCharTouchMode = isTextTool && toolSnap.textCharTouchMode;
	const isReference3DTool = toolSnap.currentTool === "reference3d";

	// Selection-derived inputs are deferred so the heavy control sections
	// mount outside the discrete selection event's sync render.
	const selectionCount = useDeferredValue(snap.selectedElementIds.length);
	const hasSelection = selectionCount >= 1;
	const hasMultipleSelection = selectionCount >= 2;

	// Get all selected elements
	const selectedElements = useDeferredValue(useSelectedElements(store));

	// Check if all selected elements share the same type
	const uniformType = useMemo(() => {
		if (selectedElements.length === 0) return null;
		const firstType = selectedElements[0].type;
		return selectedElements.every((el) => el.type === firstType)
			? firstType
			: null;
	}, [selectedElements]);

	const allSelectedArePaths = uniformType === "path";
	const showPathOperations = hasMultipleSelection && allSelectedArePaths;
	const showElementControls = hasSelection && uniformType && !isTextEditing;
	// Lone reference3d element selected: offer its scene picker without
	// requiring the reference3d tool's edit mode.
	const selectedReference3d =
		selectedElements.length === 1 && isReference3D(selectedElements[0])
			? selectedElements[0]
			: null;

	return (
		<div className="w-52 bg-background/80 backdrop-liquid rounded-xl shadow-lg flex flex-col overflow-hidden">
			<div className="px-3 py-1 border-b border-border">
				<span className="text-xs/none font-medium text-muted-foreground uppercase tracking-wide">
					{t("actionsPanel.actions")}
				</span>
			</div>
			<div className="flex-1 min-h-0 p-2 flex gap-1 items-center overflow-auto">
				{isGradientStopSelected ? null : isTextEditing ? (
					<TextEditingControls />
				) : isEraserTool ? (
					<EraserToolControls />
				) : isEyedropperTool ? (
					<EyedropperToolControls />
				) : isPenTool ? (
					<PenToolControls />
				) : isPathEditTool ? (
					<PathEditToolControls />
				) : isReference3DTool ? (
					<Reference3DToolControls />
				) : isSelectTool && !hasSelection ? (
					<SelectToolControls />
				) : isCharTouchMode ||
					(isTextTool && !hasSelection && !isTextEditing) ? (
					<div className="flex flex-col gap-3 w-full">
						<FontFamilyControl />
						<FontSizeControl />
						<div className="flex gap-2">
							<AlignmentControl />
							<WritingModeControl />
						</div>
						<TextCharTouchModeToggle />
					</div>
				) : showElementControls ? (
					<div className="flex flex-col gap-3 w-full">
						{isSelectTool && <SelectToolControls />}
						{selectedReference3d && (
							<Reference3DSceneField element={selectedReference3d} />
						)}
						<ElementControls elements={selectedElements} />
						<TransformControls />
						{showPathOperations && <PathBooleanOperations />}
						<BlendOperations />
						<RepeatControls />
					</div>
				) : (
					<EmptyState />
				)}
			</div>
		</div>
	);
}

function EmptyState() {
	const t = useTranslation();

	return (
		<span className="text-xs/none text-muted-foreground">
			{t("actionsPanel.selectObjectsToSeeActions")}
		</span>
	);
}

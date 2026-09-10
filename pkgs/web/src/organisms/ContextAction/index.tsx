import { Trash2 } from "lucide-react";
import { useDeferredValue, useEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import { FillStrokeSwatchPicker } from "@/components/FillStrokeSwatchPicker";
import { IconButton } from "@/components/IconButton";
import { Separator } from "@/components/Separator";
import { Tooltip } from "@/components/Tooltip";
import {
	usePaplico,
	usePaplicoCommands,
	usePaplicoMaybe,
	usePaplicoSelection,
	usePaplicoStore,
} from "@/contexts/PaplicoContext";
import { useTargetViewport } from "@/contexts/ViewIdContext";
import { localAppearances } from "@/core/document/appearancePresets";
import { getArtboardBounds } from "@/core/schema";
import { worldToScreen } from "@/core/utils/geometry/geometry";
import { useSelectedElements } from "@/hooks/paplico/useSelectedElements";
import { useTranslation } from "@/locales";
import { PathEditCutModeToggle } from "@/organisms/ActionsPanel/PathEditToolControls";
import { TextCharTouchModeToggle } from "@/organisms/ActionsPanel/TextEditingControls";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";
import { AdjustColorAction } from "./AdjustColorAction";
import { CharTouchAdjustControls } from "./CharTouchControls";
import { ContextActionsBar } from "./ContextActionsBar";
import { ElementActions } from "./ElementActions";
import { GradientStopActions } from "./GradientStopActions";
import { MoreActionsMenu } from "./MoreActionsMenu";
import { Reference3DNodeActions } from "./Reference3DNodeActions";
import { TextEditActions } from "./TextEditActions";

interface SelectionMenuOverlayProps {
	canvasWidth: number;
	canvasHeight: number;
}

export function ContextActionsOverlay({
	canvasWidth,
	canvasHeight,
}: SelectionMenuOverlayProps) {
	const paplico = usePaplicoMaybe();
	if (!paplico) return null;

	return (
		<ContextActionsOverlayInner
			canvasWidth={canvasWidth}
			canvasHeight={canvasHeight}
		/>
	);
}

function ContextActionsOverlayInner({
	canvasWidth,
	canvasHeight,
}: SelectionMenuOverlayProps) {
	const t = useTranslation();
	const paplico = usePaplico();
	const store = usePaplicoStore();
	const commands = usePaplicoCommands();
	const selection = usePaplicoSelection();
	const snap = useSnapshot(store);
	const uiSnap = useSnapshot(uiState);
	const viewport = useTargetViewport();

	const selectedIds = snap.selectedElementIds;
	const elementBounds = snap.selectionBounds;
	// Node selected inside an edited 3D scene: the bar anchors to the scene
	// element and shows node actions only.
	const reference3dNode =
		snap.reference3dEditingElementId != null &&
		snap.reference3dSelectedNodeId != null
			? snap.document.objects[snap.reference3dEditingElementId]
			: null;
	const reference3dNodeBounds =
		reference3dNode?.type === "reference3d"
			? {
					minX: reference3dNode.x - reference3dNode.width / 2,
					minY: reference3dNode.y - reference3dNode.height / 2,
					maxX: reference3dNode.x + reference3dNode.width / 2,
					maxY: reference3dNode.y + reference3dNode.height / 2,
				}
			: null;
	const selectedArtboardId = snap.selectedArtboardId;
	const selectedArtboard = selectedArtboardId
		? (snap.document.artboards.find((a) => a.id === selectedArtboardId) ?? null)
		: null;
	const artboardBounds = selectedArtboard
		? getArtboardBounds(selectedArtboard)
		: null;
	const isTextEditing = uiSnap.textEditState.isEditing;
	const isReference3DNodeContext = reference3dNodeBounds != null;

	// While a scene node is selected, the bar shows node actions only — the
	// general element actions are suppressed even if a selection lingers.
	const hasElementSelection =
		!isReference3DNodeContext &&
		selectedIds.length > 0 &&
		elementBounds != null;
	const hasArtboardSelection =
		!isReference3DNodeContext && selectedArtboardId && artboardBounds;
	const hasSingleSelection =
		!isReference3DNodeContext && selectedIds.length === 1;
	const selectedElements = useSelectedElements(store);
	const toolSnap = useSnapshot(paplico.tools.state);
	// Gradient tool with a single element selected: the stop-scoped actions
	// stay visible for the whole session.
	const isGradientToolContext =
		!isReference3DNodeContext &&
		!isTextEditing &&
		toolSnap.currentTool === "gradient" &&
		hasSingleSelection;
	// Cutting reaches any editable path, not only the selected one, so it needs
	// no selection of its own beyond what already keeps the bar on screen.
	const isPathEditToolContext =
		!isReference3DNodeContext &&
		!isTextEditing &&
		toolSnap.currentTool === "path-edit";
	const hasFillOrStrokeInSelection =
		!isReference3DNodeContext &&
		selectedElements.some((el) =>
			localAppearances(el.filters).some(
				(f) => f.processor === "fill" || f.processor === "stroke",
			),
		);
	const hasTextInSelection =
		!isReference3DNodeContext &&
		selectedElements.some((el) => el.type === "text");
	const meshWarpIdsInSelection = selectedElements
		.filter((el) => el.type === "mesh")
		.map((el) => el.id);
	// Only offered for a lone element that has none: with one already there,
	// the bar shows the button that opens it instead.
	const maskTargetId =
		selectedElements.length === 1 && !selectedElements[0].mask
			? selectedElements[0].id
			: null;

	const handleDelete = useEventCallback(() => {
		if (hasArtboardSelection) {
			commands.deleteArtboard(selectedArtboardId);
		} else {
			commands.deleteElements([...selectedIds]);
			selection.clear();
		}
	});

	useEffect(() => {
		const isContextActionsTarget = (target: EventTarget | null): boolean => {
			if (!(target instanceof Element)) return false;
			return (
				target.closest("[data-context-actions-root]") !== null ||
				target.closest("[data-context-actions-popover]") !== null
			);
		};

		const blockNativeWheelZoom = (event: WheelEvent) => {
			if (!event.ctrlKey) return;
			if (!isContextActionsTarget(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
		};

		const blockNativeGesture = (event: Event) => {
			if (!isContextActionsTarget(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
		};

		window.addEventListener("wheel", blockNativeWheelZoom, {
			capture: true,
			passive: false,
		});
		window.addEventListener("gesturestart", blockNativeGesture, {
			capture: true,
		});
		window.addEventListener("gesturechange", blockNativeGesture, {
			capture: true,
		});
		window.addEventListener("gestureend", blockNativeGesture, {
			capture: true,
		});
		return () => {
			window.removeEventListener("wheel", blockNativeWheelZoom, {
				capture: true,
			});
			window.removeEventListener("gesturestart", blockNativeGesture, {
				capture: true,
			});
			window.removeEventListener("gesturechange", blockNativeGesture, {
				capture: true,
			});
			window.removeEventListener("gestureend", blockNativeGesture, {
				capture: true,
			});
		};
	}, []);

	const bounds = reference3dNodeBounds
		? reference3dNodeBounds
		: hasArtboardSelection
			? artboardBounds
			: hasElementSelection
				? elementBounds
				: null;

	// Defer the bar's first mount so the discrete selection event's sync
	// render stays cheap; hiding (bounds gone) still takes effect instantly.
	const deferredShowBar = useDeferredValue(bounds != null);

	// While editing, anchor the bar where the edit began (the caret's region)
	// instead of the selection bounds — the selection pins to the chain head,
	// which sits elsewhere when editing a downstream flow region. The anchor
	// survives the edit → touch-type transition so toggling the mode from the
	// bar doesn't jump the bar itself.
	const charTouchMode = toolSnap.textCharTouchMode;
	const editAnchorRef = useRef<{ x: number; y: number } | null>(null);
	if (isTextEditing) {
		editAnchorRef.current ??= {
			x: uiSnap.textEditState.cursorX,
			y: uiSnap.textEditState.cursorY,
		};
	} else if (!charTouchMode) {
		editAnchorRef.current = null;
	}

	if (!bounds || !deferredShowBar) return null;

	const worldOffsetY = 40 / viewport.zoom;
	const editAnchor =
		isTextEditing || charTouchMode ? editAnchorRef.current : null;
	const barAnchor = worldToScreen(
		editAnchor ? editAnchor.x : (bounds.minX + bounds.maxX) / 2,
		(editAnchor ? editAnchor.y : bounds.maxY) + worldOffsetY,
		viewport,
		canvasWidth,
		canvasHeight,
	);

	// Touch-type mode: dedicated per-char adjustments only — the standard
	// element actions (cut/copy/paste etc.) don't apply to char selections
	if (charTouchMode) {
		return (
			<ContextActionsBar anchor={barAnchor}>
				<CharTouchAdjustControls />
				<TextCharTouchModeToggle />
			</ContextActionsBar>
		);
	}

	return (
		<ContextActionsBar anchor={barAnchor}>
			{isPathEditToolContext && (
				<>
					<PathEditCutModeToggle $size="md" />
					<Separator orientation="vertical" className="mx-0.5 h-5" />
				</>
			)}
			{isGradientToolContext && <GradientStopActions />}
			{!isTextEditing && hasElementSelection && hasFillOrStrokeInSelection && (
				<FillStrokeSwatchPicker
					className="h-9 w-9 flex-none"
					popoverSide="top"
					popoverSideOffset={12}
					popoverAlign="start"
					popoverPositionMethod="absolute"
					popoverContentWrapperProps={{
						"data-context-actions-popover": "",
					}}
				/>
			)}
			{isReference3DNodeContext && <Reference3DNodeActions />}
			{!isReference3DNodeContext && isTextEditing && <TextEditActions />}
			{!isReference3DNodeContext && !isTextEditing && (
				<ElementActions
					selectedIds={selectedIds}
					selectedElements={selectedElements}
					hasElementSelection={hasElementSelection}
				/>
			)}
			{!isTextEditing && hasElementSelection && <AdjustColorAction />}
			{!isTextEditing && hasElementSelection && (
				<MoreActionsMenu
					selectedIds={selectedIds}
					hasTextInSelection={hasTextInSelection}
					maskTargetId={maskTargetId}
					meshWarpIdsInSelection={meshWarpIdsInSelection}
				/>
			)}
			{!isReference3DNodeContext && !isTextEditing && (
				<Tooltip content={t("contextActions.delete")} side="bottom">
					<IconButton
						$size="md"
						$variant="ghost"
						className="text-danger"
						onClick={handleDelete}
					>
						<Trash2 size={18} />
					</IconButton>
				</Tooltip>
			)}
		</ContextActionsBar>
	);
}

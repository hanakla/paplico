import { proxy, useSnapshot } from "valtio";
import {
	defaultTextEditState,
	type TextEditState,
} from "../core/tools/TextToolController";

type ColorTarget = "stroke" | "fill";

interface UIState {
	/** ID of the last focused CanvasTarget */
	currentTargetId: string | null;
	contextActionsOffset: {
		x: number;
		y: number;
	};
	activeColorTarget: ColorTarget;
	/** テキスト編集状態 */
	textEditState: TextEditState;
	/** ブラシ設定パネルの開閉状態 */
	brushPanelOpen: boolean;
	/** Whether the brush designer panel is open */
	brushDesignerPanelOpen: boolean;
	/** Width of the brush designer panel docked next to the toolbar */
	brushDesignerPanelWidth: number;
	/** Filter index of the selected element's stroke appearance the brush
	 *  designer is editing; null = the element's first stroke appearance. */
	brushDesignerTargetFilterIndex: number | null;
	/** Width of the automation panel docked next to the toolbar */
	automationPanelWidth: number;
	/** Currently selected brush preset uid (built-in or persisted) */
	selectedBrushPresetUid: string | null;
	/** Which panel is open in mobile layout (null = all closed) */
	mobilePanelOpen: "context" | "layers" | "filters" | null;
	/** Whether soft proof (print simulation) display is enabled (UI-only, not synced) */
	softProofEnabled: boolean;
	/** Whether pixel preview (rasterization-DPI display) is enabled (UI-only, not synced) */
	pixelPreviewEnabled: boolean;
}

const BRUSH_DESIGNER_PANEL_DEFAULT_WIDTH = 480;
const AUTOMATION_PANEL_DEFAULT_WIDTH = 720;

// Resize bounds for the panels docked next to the toolbar. The layout around
// them reads the current width from this store, so the bounds live here too.
export const BRUSH_DESIGNER_PANEL_MIN_WIDTH = 360;
export const BRUSH_DESIGNER_PANEL_MAX_WIDTH = 960;
export const AUTOMATION_PANEL_MIN_WIDTH = 420;
export const AUTOMATION_PANEL_MAX_WIDTH = 960;

export const uiState = proxy<UIState>({
	currentTargetId: null,
	contextActionsOffset: { x: 0, y: 0 },
	activeColorTarget: "stroke",
	textEditState: { ...defaultTextEditState },
	brushPanelOpen: false,
	brushDesignerPanelOpen: false,
	brushDesignerPanelWidth: BRUSH_DESIGNER_PANEL_DEFAULT_WIDTH,
	brushDesignerTargetFilterIndex: null,
	automationPanelWidth: AUTOMATION_PANEL_DEFAULT_WIDTH,
	selectedBrushPresetUid: null,
	mobilePanelOpen: null,
	softProofEnabled: false,
	pixelPreviewEnabled: false,
});

export function toggleActiveColorTarget(): void {
	uiState.activeColorTarget =
		uiState.activeColorTarget === "stroke" ? "fill" : "stroke";
}

export function setActiveColorTarget(target: ColorTarget): void {
	uiState.activeColorTarget = target;
}

export function setCurrentTargetId(targetId: string | null): void {
	uiState.currentTargetId = targetId;
}

export function clearCurrentTargetId(targetId: string): void {
	if (uiState.currentTargetId !== targetId) return;
	uiState.currentTargetId = null;
}

export function useUIState() {
	return useSnapshot(uiState);
}

// --- Brush Panel Functions ---

export function toggleBrushPanel(): void {
	uiState.brushPanelOpen = !uiState.brushPanelOpen;
}

export function setBrushPanelOpen(open: boolean): void {
	uiState.brushPanelOpen = open;
}

export function setBrushDesignerPanelOpen(open: boolean): void {
	uiState.brushDesignerPanelOpen = open;
	// A closed designer must not keep editing an appearance; the target is
	// meaningful only while the panel is open.
	if (!open) uiState.brushDesignerTargetFilterIndex = null;
}

export function setBrushDesignerTargetFilterIndex(index: number | null): void {
	uiState.brushDesignerTargetFilterIndex = index;
}

export function setBrushDesignerPanelWidth(width: number): void {
	uiState.brushDesignerPanelWidth = width;
}

export function setSelectedBrushPresetUid(presetUid: string | null): void {
	uiState.selectedBrushPresetUid = presetUid;
}

export function setMobilePanelOpen(
	panel: "context" | "layers" | "filters" | null,
): void {
	uiState.mobilePanelOpen = panel;
}

export function setSoftProofEnabled(enabled: boolean): void {
	uiState.softProofEnabled = enabled;
}

export function setPixelPreviewEnabled(enabled: boolean): void {
	uiState.pixelPreviewEnabled = enabled;
}

export function setAutomationPanelWidth(width: number): void {
	uiState.automationPanelWidth = width;
}

import { useEffect, useMemo, useState } from "react";
import { useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import {
	type AnyArtObject,
	type FillColor,
	isSolidColor,
	type StrokeColor,
	type StrokeGradientMode,
} from "@/core/schema";
import { getFirstFill, getFirstStroke } from "@/core/utils/elementQuery";
import { useSelectedElements } from "@/hooks/paplico/useSelectedElements";
import { useEventCallback } from "@/utils/hooks";
import { deepClone } from "@/utils/lang";

interface ActiveColors {
	currentFill: FillColor | null;
	currentStrokeFill: FillColor | null;
	currentStrokeGradientMode: StrokeGradientMode;
	hasMixedFillColor: boolean;
	hasMixedStrokeColor: boolean;
	selectedElements: readonly AnyArtObject[];
	handleGradientFillChange: (fill: FillColor | null) => void;
	handleStrokeGradientChange: (fill: FillColor | null) => void;
	handleStrokeGradientModeChange: (mode: StrokeGradientMode) => void;
}

/**
 * Centralizes fill/stroke color reading and writing for the active selection.
 *
 * **Reading (get) flow:**
 * 1. Resolve selected elements from `uiState.selectedElementIds`.
 * 2. Extract stroke/fill appearances from each element's `filters` array.
 * 3. Detect mixed colors across selection → `hasMixedStrokeColor` / `hasMixedFillColor`.
 * 4. When all selected elements share the same color, sync it to `uiStore` picked colors.
 * 5. Derive `currentFill`, `currentStrokeFill`, and `currentStrokeGradientMode`
 *    from selection (or fall back to the tool's current color when nothing is selected).
 *
 * **Writing (set) flow:**
 * - `handleGradientFillChange`: Updates tool fill color + uiStore picked color,
 *   then applies to selected elements via `commands.updateSelectedElementsFill`.
 * - `handleStrokeGradientChange`: Converts `FillColor` → `StrokeColor`
 *   (solid passthrough, linear → stroke-gradient with current mode),
 *   then applies via `commands.updateSelectedElementsStrokeColor`.
 * - `handleStrokeGradientModeChange`: Updates stroke-gradient mode on
 *   the first selected element's existing stroke-gradient color.
 */
export function useActiveColors(): ActiveColors {
	const paplico = usePaplico();
	const tools = paplico.tools;
	const store = paplico.uiState;

	const snap = useSnapshot(tools.state);

	const [hasMixedStrokeColor, setHasMixedStrokeColor] = useState(false);
	const [hasMixedFillColor, setHasMixedFillColor] = useState(false);

	// Resolve selected elements reactively (via subscribe, not useSnapshot tracking)
	const selectedElements = useSelectedElements(store);

	// Detect mixed colors and sync to uiStore on selection change
	useEffect(() => {
		if (selectedElements.length === 0) {
			setHasMixedStrokeColor(false);
			setHasMixedFillColor(false);
			return;
		}

		const strokeColors: Array<{
			r: number;
			g: number;
			b: number;
			a: number;
		} | null> = [];
		const fillColors: Array<{
			r: number;
			g: number;
			b: number;
			a: number;
		} | null> = [];

		for (const element of selectedElements) {
			const strokeApp = getFirstStroke(element.filters);
			const color = strokeApp?.paramData.params.strokeColor;
			if (color === undefined) {
				strokeColors.push(null);
			} else if (color.type === "solid") {
				const rgb = color.color;
				if (rgb.type === "rgb") {
					strokeColors.push({ r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a });
				}
			}

			const fillApp = getFirstFill(element.filters);
			const fill = fillApp?.paramData.params.fill;
			if (fill === undefined) {
				fillColors.push(null);
			} else if (fill.type === "solid") {
				const rgb = fill.color;
				if (rgb.type === "rgb") {
					fillColors.push({ r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a });
				}
			}
		}

		// Check stroke color uniformity
		if (strokeColors.length > 0) {
			const firstStroke = strokeColors[0];
			const allSameStroke = strokeColors.every((c) => {
				if (c === null && firstStroke === null) return true;
				if (c === null || firstStroke === null) return false;
				return (
					c.r === firstStroke.r &&
					c.g === firstStroke.g &&
					c.b === firstStroke.b &&
					c.a === firstStroke.a
				);
			});
			setHasMixedStrokeColor(!allSameStroke);
		} else {
			setHasMixedStrokeColor(false);
		}

		// Check fill color uniformity
		if (fillColors.length > 0) {
			const firstFill = fillColors[0];
			const allSameFill = fillColors.every((c) => {
				if (c === null && firstFill === null) return true;
				if (c === null || firstFill === null) return false;
				return (
					c.r === firstFill.r &&
					c.g === firstFill.g &&
					c.b === firstFill.b &&
					c.a === firstFill.a
				);
			});
			setHasMixedFillColor(!allSameFill);
		} else {
			setHasMixedFillColor(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedElements]);

	// Build fill color for GradientPicker display
	// biome-ignore lint/correctness/useExhaustiveDependencies: selectedElements and snap.fillAppearance are reactivity triggers for paplico.getActiveFillAppearance()
	const currentFill = useMemo((): FillColor | null => {
		if (hasMixedFillColor) return null;
		const fillApp = paplico.getActiveFillAppearance();
		const fill = fillApp?.paramData.params.fill ?? null;
		return fill ? deepClone(fill) : null;
	}, [selectedElements, snap.fillAppearance, hasMixedFillColor, paplico]);

	// Build stroke color as FillColor for GradientPicker display
	// biome-ignore lint/correctness/useExhaustiveDependencies: selectedElements and snap.strokeAppearance are reactivity triggers for paplico.getActiveStrokeAppearance()
	const currentStrokeFill = useMemo((): FillColor | null => {
		if (hasMixedStrokeColor) return null;
		const sc =
			paplico.getActiveStrokeAppearance()?.paramData.params.strokeColor;
		if (!sc) return null;
		if (sc.type === "solid") return deepClone(sc);
		if (sc.type === "stroke-gradient") return deepClone(sc.gradient);
		return null;
	}, [selectedElements, snap.strokeAppearance, hasMixedStrokeColor, paplico]);

	// Resolve current stroke gradient mode
	const currentStrokeGradientMode = useMemo((): StrokeGradientMode => {
		if (selectedElements.length === 0) return "within";
		const strokeApp = getFirstStroke(selectedElements[0]?.filters);
		const sc = strokeApp?.paramData.params.strokeColor as
			| StrokeColor
			| undefined;
		if (sc?.type === "stroke-gradient") return sc.mode;
		return "within";
	}, [selectedElements]);

	const commands = paplico.commands;

	const handleGradientFillChange = useEventCallback(
		(fill: FillColor | null) => {
			tools.setFillColor(fill);

			if (store.selectedElementIds.length === 0) return;

			commands.updateSelectedElementsFill(fill);
		},
	);

	const handleStrokeGradientChange = useEventCallback(
		(fill: FillColor | null) => {
			let strokeColor: StrokeColor | null = null;

			if (fill) {
				if (isSolidColor(fill)) {
					strokeColor = fill;
				} else if (fill.type === "linear") {
					strokeColor = {
						type: "stroke-gradient",
						gradient: fill,
						mode: currentStrokeGradientMode,
					};
				}
			}

			tools.setStrokeColor(strokeColor);

			if (store.selectedElementIds.length > 0) {
				commands.updateSelectedElementsStrokeColor(strokeColor);
			}
		},
	);

	const handleStrokeGradientModeChange = useEventCallback(
		(mode: StrokeGradientMode) => {
			if (selectedElements.length === 0) return;
			const strokeApp = getFirstStroke(selectedElements[0]?.filters);
			const sc = strokeApp?.paramData.params.strokeColor as
				| StrokeColor
				| undefined;
			if (sc?.type !== "stroke-gradient") return;

			commands.updateSelectedElementsStrokeColor({
				...sc,
				mode,
			});
		},
	);

	return {
		currentFill,
		currentStrokeFill,
		currentStrokeGradientMode,
		hasMixedFillColor,
		hasMixedStrokeColor,
		selectedElements,
		handleGradientFillChange,
		handleStrokeGradientChange,
		handleStrokeGradientModeChange,
	};
}

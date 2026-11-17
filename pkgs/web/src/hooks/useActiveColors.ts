import {
	type AnyArtObject,
	type FillColor,
	isSolidColor,
	type StrokeColor,
	type StrokeGradientMode,
} from "@paplico/core/schema";
import { getFirstFill, getFirstStroke } from "@paplico/core/utils";
import { isEqual } from "es-toolkit";
import { useMemo } from "react";
import { useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
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
 * 4. Derive `currentFill`, `currentStrokeFill`, and `currentStrokeGradientMode`
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

	const selection = useSnapshot(store, { sync: true });
	const selectedIds = selection.selectedElementIds;
	// The engine stores this record as a Valtio ref, so its values are not snapshots.
	const objects = selection.document.objects as typeof store.document.objects;
	const selectedElements = useMemo(
		() => selectedIds.flatMap((id) => (objects[id] ? [objects[id]] : [])),
		[selectedIds, objects],
	);
	const {
		currentFill,
		currentStrokeFill,
		currentStrokeGradientMode,
		hasMixedFillColor,
		hasMixedStrokeColor,
	} = useMemo(() => {
		const [first, ...others] = selectedElements;
		const getFill = (element: AnyArtObject) =>
			getFirstFill(element.filters)?.paramData.params.fill;
		const getStroke = (element: AnyArtObject) =>
			getFirstStroke(element.filters)?.paramData.params.strokeColor;
		const fill = first
			? getFill(first)
			: snap.fillAppearance?.paramData.params.fill;
		const stroke = first
			? getStroke(first)
			: snap.strokeAppearance?.paramData.params.strokeColor;
		const hasMixedFillColor = others.some(
			(element) => !isEqual(fill, getFill(element)),
		);
		const hasMixedStrokeColor = others.some(
			(element) => !isEqual(stroke, getStroke(element)),
		);
		return {
			currentFill:
				fill && !hasMixedFillColor ? (deepClone(fill) as FillColor) : null,
			currentStrokeFill:
				!hasMixedStrokeColor &&
				(stroke?.type === "solid" || stroke?.type === "stroke-gradient")
					? (deepClone(
							stroke.type === "solid" ? stroke : stroke.gradient,
						) as FillColor)
					: null,
			currentStrokeGradientMode:
				first && !hasMixedStrokeColor && stroke?.type === "stroke-gradient"
					? stroke.mode
					: ("within" as const),
			hasMixedFillColor,
			hasMixedStrokeColor,
		};
	}, [selectedElements, snap.fillAppearance, snap.strokeAppearance]);

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

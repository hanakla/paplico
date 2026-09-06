import { useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { Color, FillColor, FilterEntry } from "@/core/schema";
import { getFirstFill } from "@/core/utils/elementQuery";
import { useEventCallback } from "@/utils/hooks";

/**
 * Reads and writes the color of the gradient stop currently selected by the
 * gradient tool (free stop / mesh vertex / linear·radial stop index) on the
 * single selected element. `stopColor` is null when no applicable stop is
 * selected.
 */
export function useGradientStopColor(): {
	fill: FillColor | undefined;
	stopColor: Color | null;
	setStopColor: (color: Color) => void;
} {
	const { uiState: store, commands, tools } = usePaplico();
	const snap = useSnapshot(store);
	const toolSnap = useSnapshot(tools.state);

	const freeStopId = toolSnap.gradientSelectedStopId;
	const stopIndex = toolSnap.gradientSelectedStopIndex;
	// Mesh vertex selection is encoded in gradientSelectedStopId as
	// "mesh-vertex:<index>" (same convention as GradientTool.updateUI).
	const meshVertexIndex = freeStopId?.startsWith("mesh-vertex:")
		? Number.parseInt(freeStopId.split(":")[1], 10)
		: null;
	const layerId = snap.currentLayerId;
	const elementId = snap.selectedElementIds[0];
	const element = elementId ? snap.document.objects[elementId] : null;
	const fillApp = getFirstFill(element?.filters as FilterEntry[] | undefined);
	const fill = fillApp?.paramData.params.fill;

	let stopColor: Color | null = null;
	if (fill?.type === "free" && freeStopId != null) {
		stopColor = fill.stops.find((s) => s.id === freeStopId)?.color ?? null;
	} else if (
		(fill?.type === "linear" || fill?.type === "radial") &&
		stopIndex != null
	) {
		stopColor = fill.stops[stopIndex]?.color ?? null;
	} else if (
		fill?.type === "mesh" &&
		meshVertexIndex != null &&
		Number.isFinite(meshVertexIndex)
	) {
		stopColor = fill.vertices[meshVertexIndex]?.color ?? null;
	}

	const setStopColor = useEventCallback((color: Color) => {
		if (!layerId || !elementId || !fill) return;

		let updatedFill: FillColor;
		if (fill.type === "free" && freeStopId != null) {
			const newStops = fill.stops.map((s) =>
				s.id === freeStopId ? { ...s, color } : s,
			);
			updatedFill = { ...fill, stops: newStops } satisfies FillColor;
		} else if (
			(fill.type === "linear" || fill.type === "radial") &&
			stopIndex != null
		) {
			const newStops = fill.stops.map((s, i) =>
				i === stopIndex ? { ...s, color } : s,
			);
			updatedFill = { ...fill, stops: newStops } satisfies FillColor;
		} else if (
			fill.type === "mesh" &&
			meshVertexIndex != null &&
			Number.isFinite(meshVertexIndex)
		) {
			// Assigning an explicit color promotes the vertex from `derived`
			// to `explicit`. The position/colorSource pointers are cleared so
			// later topology edits don't overwrite the user's choice.
			const newVertices = fill.vertices.map((v, i) =>
				i === meshVertexIndex
					? {
							...v,
							color,
							colorMode: "explicit" as const,
							colorSource: undefined,
							positionSource: undefined,
							meshSource: undefined,
						}
					: v,
			);
			updatedFill = { ...fill, vertices: newVertices } satisfies FillColor;
		} else {
			return;
		}

		commands.updateSelectedElementsFill(updatedFill);
	});

	return { fill, stopColor, setStopColor };
}

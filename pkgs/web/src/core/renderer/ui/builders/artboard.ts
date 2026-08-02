import { type Artboard, getArtboardBounds } from "../../../schema";
import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { ArtboardSelectionUIData } from "../types";
import { rectGeom } from "./shared";

/**
 * Artboard edit mode: outline for every artboard, plus highlight and resize
 * handles for the selected artboard (or creation preview).
 */
export function buildArtboardOverlay(
	artboards: Artboard[],
	selection: ArtboardSelectionUIData | null | undefined,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const sw = theme.strokeWidth.default;

	for (const artboard of artboards) {
		const bounds = getArtboardBounds(artboard);
		prims.push({
			kind: "rect",
			...rectGeom(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY),
			stroke: { color: theme.colors.artboardOutline, width: sw },
		});
	}

	if (selection) {
		prims.push({
			kind: "rect",
			...rectGeom(
				selection.bounds.minX,
				selection.bounds.minY,
				selection.bounds.maxX,
				selection.bounds.maxY,
			),
			stroke: { color: theme.colors.artboardSelected, width: sw },
		});

		const sizePx = theme.handleSize.artboard;
		for (const handle of selection.handles) {
			prims.push({
				kind: "rect",
				cx: handle.x,
				cy: handle.y,
				width: { screen: sizePx },
				height: { screen: sizePx },
				fill: { color: theme.colors.white },
				stroke: { color: theme.colors.artboardSelected, width: sw },
			});
		}
	}

	return prims;
}

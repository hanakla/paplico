import { type Artboard, getArtboardBounds } from "../../../schema";
import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { ArtboardSelectionUIData } from "../types";
import { rectGeom } from "./shared";

/**
 * Boundary outline for every artboard, plus highlight and resize handles for
 * the selected artboard (or creation preview).
 */
export function buildArtboardOverlay(
	artboards: Artboard[],
	selection: ArtboardSelectionUIData | null | undefined,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];

	for (const artboard of artboards) {
		const { minX, minY, maxX, maxY } = getArtboardBounds(artboard);
		// A closed polyline joins its corners; a rect stroke is four butt-capped
		// lines that leave each outer corner pixel unpainted.
		prims.push({
			kind: "polyline",
			points: [
				{ x: minX, y: minY },
				{ x: maxX, y: minY },
				{ x: maxX, y: maxY },
				{ x: minX, y: maxY },
			],
			closed: true,
			stroke: {
				color: theme.colors.artboardOutline,
				width: theme.strokeWidth.artboardOutline,
			},
		});
	}

	if (selection) {
		const sw = theme.strokeWidth.default;
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

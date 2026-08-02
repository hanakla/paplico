import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { FreeTransformUIData } from "../types";

/**
 * Free-transform (perspective warp) overlay: the warped quad frame through the
 * four dragged corners, plus a square handle at each corner.
 */
export function buildPerspectiveWarpOverlay(
	data: FreeTransformUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const sw = theme.strokeWidth.default;
	const size = theme.handleSize.selection;

	if (data.corners.length >= 3) {
		prims.push({
			kind: "polyline",
			points: data.corners.map((c) => ({ x: c.x, y: c.y })),
			closed: true,
			stroke: { color: theme.colors.selectionBounds, width: sw },
		});
	}

	// Edge-midpoint handles: dragging one moves both corners of its edge.
	for (let i = 0; i < 4 && data.corners.length === 4; i++) {
		const a = data.corners[i];
		const b = data.corners[(i + 1) % 4];
		prims.push({
			kind: "rect",
			cx: (a.x + b.x) / 2,
			cy: (a.y + b.y) / 2,
			width: { screen: size },
			height: { screen: size },
			fill: { color: theme.colors.white },
			stroke: { color: theme.colors.selectionBounds, width: sw },
		});
	}

	for (let i = 0; i < data.corners.length; i++) {
		const c = data.corners[i];
		const active = data.activeCorners?.includes(i) ?? false;
		const selected = data.selectedCorners?.includes(i) ?? false;
		if (selected) {
			// Selection ring around the handle (mesh-deform convention).
			prims.push({
				kind: "rect",
				cx: c.x,
				cy: c.y,
				width: { screen: size + theme.handleSize.selectionRingOffset * 2 + 2 },
				height: { screen: size + theme.handleSize.selectionRingOffset * 2 + 2 },
				stroke: { color: theme.colors.selectionBounds, width: sw },
			});
		}
		prims.push({
			kind: "rect",
			cx: c.x,
			cy: c.y,
			width: { screen: size },
			height: { screen: size },
			fill: {
				color: active ? theme.colors.selectionBounds : theme.colors.white,
			},
			stroke: { color: theme.colors.selectionBounds, width: sw },
		});
	}

	return prims;
}

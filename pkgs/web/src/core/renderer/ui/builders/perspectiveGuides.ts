import type { PerspectiveGuideData } from "../../../reference3d/perspective/vanishingPoints";
import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";

/**
 * Half-extent of the horizon line in world units — long enough to cross any
 * practical viewport at any zoom.
 */
const HORIZON_HALF_EXTENT = 100_000;

/** Perspective ruler: horizon line + finite vanishing point markers. */
export function buildPerspectiveGuideOverlay(
	data: PerspectiveGuideData,
	theme: UITheme,
): UIPrimitive[] {
	const primitives: UIPrimitive[] = [];

	if (data.horizon) {
		const { point, direction } = data.horizon;
		primitives.push({
			kind: "line",
			x1: point.x - direction.x * HORIZON_HALF_EXTENT,
			y1: point.y - direction.y * HORIZON_HALF_EXTENT,
			x2: point.x + direction.x * HORIZON_HALF_EXTENT,
			y2: point.y + direction.y * HORIZON_HALF_EXTENT,
			stroke: {
				color: theme.colors.perspectiveHorizon,
				width: theme.strokeWidth.default,
			},
		});
	}

	for (const axis of data.axes) {
		if (axis.kind !== "finite") continue;
		primitives.push({
			kind: "circle",
			cx: axis.point.x,
			cy: axis.point.y,
			radius: { screen: 4 },
			fill: { color: theme.colors.perspectiveVp },
			stroke: { color: theme.colors.white, width: 1 },
			zIndex: 1,
		});
	}

	return primitives;
}

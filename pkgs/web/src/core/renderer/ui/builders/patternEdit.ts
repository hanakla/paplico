import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { PatternEditUIData } from "../types";

/**
 * Pattern-edit tile rectangle centered at the working def origin. Purely
 * informational — tools continue to operate in world space as normal.
 * Reuses the mesh-bounds color — same role (informational frame around the
 * active edit area).
 */
export function buildPatternEditOverlay(
	data: PatternEditUIData,
	theme: UITheme,
): UIPrimitive[] {
	return [
		{
			kind: "rect",
			cx: data.centerX,
			cy: data.centerY,
			width: data.tileWidth,
			height: data.tileHeight,
			stroke: {
				color: theme.colors.meshBounds,
				width: theme.strokeWidth.default,
			},
		},
	];
}

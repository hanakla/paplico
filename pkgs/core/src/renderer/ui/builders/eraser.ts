import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { EraserToolUIData } from "../types";

/** Eraser cursor: black outline ring and eraser radius. */
export function buildEraserOverlay(
	data: EraserToolUIData,
	theme: UITheme,
): UIPrimitive[] {
	const sw = theme.strokeWidth.default;
	return [
		// Black outline behind the outer circle (0.5px screen outset)
		{
			kind: "circle",
			cx: data.worldX,
			cy: data.worldY,
			radius: { world: data.radius, screen: 0.5 },
			stroke: { color: theme.colors.eraserCursorOutline, width: sw },
		},
		// Outer circle (eraser visual radius)
		{
			kind: "circle",
			cx: data.worldX,
			cy: data.worldY,
			radius: data.radius,
			stroke: { color: data.color, width: sw },
		},
	];
}

import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { ToolCursorUIData } from "../types";

/** Tool cursor: brush circle plus optional picked-color preview stack. */
export function buildToolCursorOverlay(
	data: ToolCursorUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];

	if (data.pickedColor) {
		// Preview anchor: cursor position raised by the world-space cursor
		// radius, then by a screen-fixed stack of fill 24px + outline 2px +
		// shadow 1px + gap 4px.
		const cx = data.worldX;
		const cy = data.worldY + data.radius;
		const screenOffset = { x: 0, y: 24 + 2 + 1 + 4 };

		// 1. Shadow (gray filled circle, backmost)
		prims.push({
			kind: "circle",
			cx,
			cy,
			screenOffset,
			radius: { screen: 24 + 2 + 1 },
			fill: { color: theme.colors.colorPickerPreviewShadow },
		});
		// 2. White outline (covers shadow interior)
		prims.push({
			kind: "circle",
			cx,
			cy,
			screenOffset,
			radius: { screen: 24 + 2 },
			fill: { color: theme.colors.colorPickerPreviewOutline },
		});
		// 3. Picked color (topmost)
		prims.push({
			kind: "circle",
			cx,
			cy,
			screenOffset,
			radius: { screen: 24 },
			fill: { color: data.pickedColor },
		});
	}

	// Brush cursor circle (skip when radius is 0, e.g. during color pick)
	if (data.radius > 0) {
		prims.push({
			kind: "circle",
			cx: data.worldX,
			cy: data.worldY,
			radius: data.radius,
			stroke: { color: data.color, width: theme.strokeWidth.default },
		});
	}

	return prims;
}

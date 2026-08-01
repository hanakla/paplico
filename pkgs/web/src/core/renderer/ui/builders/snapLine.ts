import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { SnapLineUIData } from "../types";

/** Alignment snap guide lines. */
export function buildSnapLineOverlay(
	data: SnapLineUIData,
	theme: UITheme,
): UIPrimitive[] {
	const sw = theme.strokeWidth.default;
	return data.lines.map((line) =>
		line.axis === "vertical"
			? {
					kind: "line",
					x1: line.position,
					y1: line.extentMin,
					x2: line.position,
					y2: line.extentMax,
					stroke: { color: theme.colors.snapLine, width: sw },
				}
			: {
					kind: "line",
					x1: line.extentMin,
					y1: line.position,
					x2: line.extentMax,
					y2: line.position,
					stroke: { color: theme.colors.snapLine, width: sw },
				},
	);
}

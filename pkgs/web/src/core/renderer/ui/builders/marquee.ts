import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { MarqueeSelectionUIData } from "../types";
import { rectGeom } from "./shared";

/** Marquee selection: lasso polygon or start/end rectangle, fill + outline. */
export function buildMarqueeOverlay(
	data: MarqueeSelectionUIData,
	theme: UITheme,
): UIPrimitive[] {
	const sw = theme.strokeWidth.default;

	if (data.lassoPath && data.lassoPath.length >= 2) {
		return [
			{
				kind: "polyline",
				points: data.lassoPath,
				closed: true,
				...(data.lassoPath.length >= 3
					? { fill: { color: theme.colors.marqueeFill } }
					: {}),
				stroke: { color: theme.colors.marqueeOutline, width: sw },
			},
		];
	}

	// Rectangle marquee
	const minX = Math.min(data.startX, data.endX);
	const maxX = Math.max(data.startX, data.endX);
	const minY = Math.min(data.startY, data.endY);
	const maxY = Math.max(data.startY, data.endY);
	return [
		{
			kind: "rect",
			...rectGeom(minX, minY, maxX, maxY),
			fill: { color: theme.colors.marqueeFill },
			stroke: { color: theme.colors.marqueeOutline, width: sw },
		},
	];
}

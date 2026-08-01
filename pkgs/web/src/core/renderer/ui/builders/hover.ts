import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { HoverUIData } from "../types";
import { rectGeom } from "./shared";

/** Hover highlight: path outlines when available, otherwise bounds rect. */
export function buildHoverOverlay(
	data: HoverUIData,
	theme: UITheme,
): UIPrimitive[] {
	if (data.pathSegments) {
		return data.pathSegments.map((segments) => ({
			kind: "bezierPath",
			segments,
			stroke: { color: theme.colors.hover, width: theme.strokeWidth.path },
		}));
	}

	if (data.bounds) {
		return [
			{
				kind: "rect",
				...rectGeom(
					data.bounds.minX,
					data.bounds.minY,
					data.bounds.maxX,
					data.bounds.maxY,
				),
				stroke: { color: theme.colors.hover, width: theme.strokeWidth.default },
			},
		];
	}

	return [];
}

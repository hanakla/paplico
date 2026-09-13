import type { CanvasObstacleRect } from "@/stores/uiStore";

type ClampBarPositionInput = {
	/** Anchor in pane-local coordinates, before the user's drag offset. */
	anchor: { x: number; y: number };
	offset: { x: number; y: number };
	barSize: { width: number; height: number };
	/** Client-space rect of the pane the bar is positioned within. */
	paneRect: CanvasObstacleRect;
	/** Client-space rects of the floating UI the bar must stay clear of. */
	obstacles: readonly CanvasObstacleRect[];
};

/** Gap kept between the bar and both the pane edges and the obstacles. */
const SAFE_MARGIN = 8;

/**
 * Places the bar so it stays inside the pane and clear of the floating UI over
 * it. The bar draws with `translate(-50%, -100%)`, so the returned point is the
 * bottom center of its box.
 */
export function clampBarPosition({
	anchor,
	offset,
	barSize,
	paneRect,
	obstacles,
}: ClampBarPositionInput): { left: number; top: number } {
	const safe = safeArea(paneRect, obstacles);
	const halfWidth = barSize.width / 2;

	return {
		left: clampSpan(
			anchor.x + offset.x,
			safe.left + halfWidth,
			safe.right - halfWidth,
		),
		top: clampSpan(anchor.y + offset.y, safe.top + barSize.height, safe.bottom),
	};
}

/**
 * The pane, shrunk away from every obstacle overlapping it. Each obstacle takes
 * the single edge that gives way the least, which pushes the top edge down for
 * the menu bar and a side edge inward for the panels without telling the kinds
 * of UI apart.
 */
function safeArea(
	paneRect: CanvasObstacleRect,
	obstacles: readonly CanvasObstacleRect[],
): CanvasObstacleRect {
	const area = {
		left: SAFE_MARGIN,
		top: SAFE_MARGIN,
		right: paneRect.right - paneRect.left - SAFE_MARGIN,
		bottom: paneRect.bottom - paneRect.top - SAFE_MARGIN,
	};

	for (const obstacle of obstacles) {
		const local = {
			left: obstacle.left - paneRect.left - SAFE_MARGIN,
			top: obstacle.top - paneRect.top - SAFE_MARGIN,
			right: obstacle.right - paneRect.left + SAFE_MARGIN,
			bottom: obstacle.bottom - paneRect.top + SAFE_MARGIN,
		};

		if (
			local.right <= area.left ||
			local.left >= area.right ||
			local.bottom <= area.top ||
			local.top >= area.bottom
		) {
			continue;
		}

		const pushLeft = local.right - area.left;
		const pushRight = area.right - local.left;
		const pushTop = local.bottom - area.top;
		const pushBottom = area.bottom - local.top;
		const least = Math.min(pushLeft, pushRight, pushTop, pushBottom);

		if (least === pushLeft) area.left = local.right;
		else if (least === pushRight) area.right = local.left;
		else if (least === pushTop) area.top = local.bottom;
		else area.bottom = local.top;
	}

	return area;
}

/** Clamps into a span, centering instead when the span is inverted. */
function clampSpan(value: number, min: number, max: number): number {
	if (min > max) return (min + max) / 2;
	return Math.min(Math.max(value, min), max);
}

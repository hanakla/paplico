import type { BoundingBox } from "../../../schema";
import type { RectPrimitive, UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";

/** Screen-space gap between the selection edge and a shear bar. */
const BAR_OFFSET_SCREEN = 14;
/** Screen-space bar thickness (corner radius = half → capsule shape). */
const BAR_THICKNESS_SCREEN = 8;
/** Bar length as a fraction of the selection edge. */
const BAR_LENGTH_RATIO = 0.6;

/**
 * Skew-tool gizmo: two capsule-shaped bars just outside the selection box.
 * The horizontal bar above the TOP edge drags left/right for skewX; the
 * vertical bar past the LEFT edge drags up/down for skewY. `offset` slides a
 * bar along its axis during a drag so it follows the pointer.
 */
export function buildSkewBarsOverlay(
	bounds: BoundingBox,
	zoom: number,
	offset: { x: number; y: number },
	theme: UITheme,
): UIPrimitive[] {
	const z = Math.max(zoom, 1e-3);
	const gap = BAR_OFFSET_SCREEN / z;
	const midX = (bounds.minX + bounds.maxX) / 2;
	const midY = (bounds.minY + bounds.maxY) / 2;

	const capsule = (
		cx: number,
		cy: number,
		axis: "horizontal" | "vertical",
		lengthWorld: number,
		hitId: string,
	): RectPrimitive => ({
		kind: "rect",
		cx,
		cy,
		width:
			axis === "horizontal" ? lengthWorld : { screen: BAR_THICKNESS_SCREEN },
		height:
			axis === "horizontal" ? { screen: BAR_THICKNESS_SCREEN } : lengthWorld,
		cornerRadius: { screen: BAR_THICKNESS_SCREEN / 2 },
		fill: { color: theme.colors.white },
		stroke: { color: theme.colors.selectionBounds, width: 1.5 },
		hitId,
	});

	return [
		// Horizontal skewX bar above the top edge (world Y-up: top = maxY).
		capsule(
			midX + offset.x,
			bounds.maxY + gap,
			"horizontal",
			bounds.width * BAR_LENGTH_RATIO,
			"skew-x",
		),
		// Vertical skewY bar past the left edge.
		capsule(
			bounds.minX - gap,
			midY + offset.y,
			"vertical",
			bounds.height * BAR_LENGTH_RATIO,
			"skew-y",
		),
	];
}

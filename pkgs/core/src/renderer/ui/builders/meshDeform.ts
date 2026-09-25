import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { MeshDeformUIData } from "../types";
import { rectGeom } from "./shared";

/**
 * Mesh deform overlay: original bounds, mesh edges, control handles,
 * lasso path and long-press ring.
 */
export function buildMeshDeformOverlay(
	data: MeshDeformUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const sw = theme.strokeWidth.default;
	const radiusPx = theme.handleSize.meshDeformRadius;

	// 1. Original bounds outline (faded gray)
	prims.push({
		kind: "rect",
		...rectGeom(
			data.originalBounds.minX,
			data.originalBounds.minY,
			data.originalBounds.maxX,
			data.originalBounds.maxY,
		),
		stroke: { color: theme.colors.meshBounds, width: sw },
	});

	// 2. Mesh edges
	for (const edge of data.edges) {
		prims.push({
			kind: "line",
			x1: edge.x1,
			y1: edge.y1,
			x2: edge.x2,
			y2: edge.y2,
			stroke: { color: theme.colors.meshEdge, width: sw },
		});
	}

	// 3. Control handles (all fills → all outlines, rings in handle order)
	const fills: UIPrimitive[] = [];
	const outlines: UIPrimitive[] = [];

	for (const handle of data.handles) {
		// Selection ring
		if (handle.selected) {
			outlines.push({
				kind: "circle",
				cx: handle.currentX,
				cy: handle.currentY,
				radius: { screen: radiusPx + theme.handleSize.selectionRingOffset },
				stroke: { color: theme.colors.meshHandleRing, width: sw },
			});
		}

		// Filled circle (white, or warm yellow if selected).
		// hitPadding pins the effective hit radius to hitTolerancePx (8px),
		// matching the historical center-distance test in MeshDeformTool.
		fills.push({
			kind: "circle",
			cx: handle.currentX,
			cy: handle.currentY,
			radius: { screen: radiusPx },
			hitId: handle.id,
			hitPadding: { screen: theme.hitTolerancePx - radiusPx },
			fill: {
				color: handle.selected
					? theme.colors.meshHandleFillSelected
					: theme.colors.meshHandleFill,
			},
		});

		// Outline circle (blue)
		outlines.push({
			kind: "circle",
			cx: handle.currentX,
			cy: handle.currentY,
			radius: { screen: radiusPx },
			stroke: { color: theme.colors.meshHandleOutline, width: sw },
		});
	}

	prims.push(...fills, ...outlines);

	// 4. Lasso selection path (stroke only, closed)
	if (data.lassoPath && data.lassoPath.length >= 2) {
		prims.push({
			kind: "polyline",
			points: data.lassoPath,
			closed: true,
			stroke: { color: theme.colors.meshLasso, width: sw },
		});
	}

	// 5. Long press ring
	if (data.longPressRing) {
		prims.push({
			kind: "circle",
			cx: data.longPressRing.worldX,
			cy: data.longPressRing.worldY,
			radius: { screen: radiusPx * 1.8 },
			stroke: { color: theme.colors.meshLongPressRing, width: sw },
		});
	}

	return prims;
}

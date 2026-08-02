import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { SelectionUIData } from "../types";
import { rectGeom } from "./shared";

/** Selection overlay: path outlines, bounding box, resize + rotation handles. */
export function buildSelectionOverlay(
	data: SelectionUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const sw = theme.strokeWidth.default;

	// Path outlines for selected paths (each path rendered separately to
	// avoid connecting different paths)
	if (data.pathSegments && data.pathSegments.length > 0) {
		for (const pathSegs of data.pathSegments) {
			prims.push({
				kind: "bezierPath",
				segments: pathSegs,
				stroke: {
					color: theme.colors.selectionPath,
					width: theme.strokeWidth.path,
				},
			});
		}
	}

	// Key object outline (alignment reference) in a distinct color, drawn
	// slightly thicker so it reads as the reference within the selection.
	if (data.keyObjectSegments && data.keyObjectSegments.length > 0) {
		for (const pathSegs of data.keyObjectSegments) {
			prims.push({
				kind: "bezierPath",
				segments: pathSegs,
				stroke: {
					color: theme.colors.selectionKeyPath,
					width: theme.strokeWidth.path + 1,
				},
			});
		}
	}

	// Bounding box
	prims.push({
		kind: "rect",
		...rectGeom(
			data.bounds.minX,
			data.bounds.minY,
			data.bounds.maxX,
			data.bounds.maxY,
		),
		// Dashed bounds draw white: the mesh cage boundary outline coincides with
		// the BBox on an undeformed cage, so a same-colored dash would read as one
		// solid line — white dashes stay visible on top of it.
		stroke: {
			color: data.boundsDashed
				? theme.colors.white
				: theme.colors.selectionBounds,
			width: sw,
			dash: data.boundsDashed ? theme.dash.selectionBounds : undefined,
		},
	});

	// Resize handles (white fill + blue outline)
	const sizePx = theme.handleSize.selection;
	for (const handle of data.handles) {
		prims.push({
			kind: "rect",
			cx: handle.x,
			cy: handle.y,
			width: { screen: sizePx },
			height: { screen: sizePx },
			fill: { color: theme.colors.white },
			stroke: { color: theme.colors.selectionBounds, width: sw },
		});
	}

	// Rotation handle (circle above "n" handle with connecting stem line)
	if (data.rotationHandle) {
		const rh = data.rotationHandle;
		const nHandle = data.handles.find((h) => h.position === "n");
		if (nHandle) {
			prims.push({
				kind: "line",
				x1: nHandle.x,
				y1: nHandle.y,
				x2: rh.x,
				y2: rh.y,
				stroke: { color: theme.colors.selectionBounds, width: sw },
			});
		}
		prims.push({
			kind: "circle",
			cx: rh.x,
			cy: rh.y,
			radius: { screen: sizePx / 2 },
			fill: { color: theme.colors.white },
			stroke: { color: theme.colors.selectionBounds, width: sw },
		});
	}

	return prims;
}

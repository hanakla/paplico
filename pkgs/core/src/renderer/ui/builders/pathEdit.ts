import type { UIPrimitive } from "../primitives";
import type { RGBA, UITheme } from "../theme";
import type { ControlPointHandle, PathEditUIData } from "../types";
import { rectGeom } from "./shared";

/**
 * Path edit overlay: path outlines, handle stem lines, control-point handles
 * (circles / rects / diamonds), long-press ring and lasso.
 *
 * Painter's-order note: handle shapes are grouped by category (all stem +
 * diamond-outline lines → circle fills → circle outlines → rect fills → rect
 * outlines → diamond fills) across ALL paths, matching the historical
 * per-category batch draws.
 */
export function buildPathEditOverlay(
	data: PathEditUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const sw = theme.strokeWidth.default;
	const sizePx = theme.handleSize.pathEdit;
	const radiusPx = sizePx / 2;

	const lines: UIPrimitive[] = [];
	const circleFills: UIPrimitive[] = [];
	const circleStrokes: UIPrimitive[] = [];
	const rectFills: UIPrimitive[] = [];
	const rectStrokes: UIPrimitive[] = [];
	const diamondFills: UIPrimitive[] = [];
	const boundsRects: UIPrimitive[] = [];
	const hitProxies: UIPrimitive[] = [];

	// Non-editable context outlines (e.g. a blend's key/spine outlines).
	for (const outline of data.additionalOutlines ?? []) {
		prims.push({
			kind: "bezierPath",
			segments: outline,
			stroke: {
				color: theme.colors.selectionPath,
				width: theme.strokeWidth.path,
			},
		});
	}

	for (const pathData of data.paths) {
		const segmentGroups = getSegmentGroups(pathData.controlPoints);
		const sortedSegmentIndices = [...segmentGroups.keys()].sort(
			(a, b) => a - b,
		);

		// Bezier curve path per path (paths stay separate to avoid cross-path connections)
		if (pathData.segments && pathData.segments.length > 0) {
			prims.push({
				kind: "bezierPath",
				segments: pathData.segments,
				stroke: {
					color: theme.colors.selectionPath,
					width: theme.strokeWidth.path,
				},
			});
		}

		// Handle stem lines (anchor→cp1, cp2→end)
		for (const segmentIndex of sortedSegmentIndices) {
			const group = segmentGroups.get(segmentIndex);
			if (!group) continue;

			if (group.cp1) {
				// For segment 0, anchor is group.start (or last segment's end for
				// closed paths); for i>0, anchor is previous segment's end
				const lastIdx = sortedSegmentIndices.at(-1)!;
				const anchor =
					group.start ??
					segmentGroups.get(segmentIndex - 1)?.end ??
					segmentGroups.get(lastIdx)?.end;
				if (anchor) {
					lines.push({
						kind: "line",
						x1: anchor.worldX,
						y1: anchor.worldY,
						x2: group.cp1.worldX,
						y2: group.cp1.worldY,
						stroke: { color: theme.colors.pathHandleLine, width: sw },
					});
				}
			}
			if (group.cp2 && group.end) {
				lines.push({
					kind: "line",
					x1: group.cp2.worldX,
					y1: group.cp2.worldY,
					x2: group.end.worldX,
					y2: group.end.worldY,
					stroke: { color: theme.colors.pathHandleLine, width: sw },
				});
			}
		}

		// Control point handles
		for (const handle of pathData.controlPoints) {
			// Hit-test proxy: the historical PathEditTool hit test used a pure
			// center-distance check with an 8px screen radius for every handle
			// shape; zIndex mirrors its corner > anchor > control priority.
			hitProxies.push({
				kind: "circle",
				cx: handle.worldX,
				cy: handle.worldY,
				radius: { screen: theme.hitTolerancePx },
				hitPadding: 0,
				hitId: `${handle.pathId}:${handle.segmentIndex}:${handle.pointType}`,
				hitOnly: true,
				zIndex: handleHitZ(handle.type),
			});
			if (handle.type === "corner-superellipse-k") {
				const fillColor: RGBA = handle.selected
					? theme.colors.pathSuperellipseFillSelected
					: theme.colors.pathSuperellipseFill;
				const outlineColor: RGBA = handle.selected
					? theme.colors.pathSuperellipseOutlineSelected
					: theme.colors.pathSuperellipseOutline;
				// Outline lines batch with the stem lines; fill draws last.
				lines.push({
					kind: "diamond",
					cx: handle.worldX,
					cy: handle.worldY,
					halfSize: { screen: radiusPx },
					stroke: { color: outlineColor, width: sw },
				});
				diamondFills.push({
					kind: "diamond",
					cx: handle.worldX,
					cy: handle.worldY,
					halfSize: { screen: radiusPx },
					fill: { color: fillColor },
				});
			} else if (handle.type === "corner-radius") {
				circleFills.push({
					kind: "circle",
					cx: handle.worldX,
					cy: handle.worldY,
					radius: { screen: radiusPx },
					fill: {
						color: handle.selected
							? theme.colors.pathCornerRadiusFillSelected
							: theme.colors.pathCornerRadiusFill,
					},
				});
				circleStrokes.push({
					kind: "circle",
					cx: handle.worldX,
					cy: handle.worldY,
					radius: { screen: radiusPx },
					stroke: {
						color: handle.selected
							? theme.colors.pathCornerRadiusOutlineSelected
							: theme.colors.pathCornerRadiusOutline,
						width: sw,
					},
				});
			} else if (handle.type === "control") {
				circleFills.push({
					kind: "circle",
					cx: handle.worldX,
					cy: handle.worldY,
					radius: { screen: radiusPx },
					fill: {
						color: handle.selected
							? theme.colors.pathControlFillSelected
							: theme.colors.pathControlFill,
					},
				});
				circleStrokes.push({
					kind: "circle",
					cx: handle.worldX,
					cy: handle.worldY,
					radius: { screen: radiusPx },
					stroke: {
						color: handle.selected
							? theme.colors.pathControlOutlineSelected
							: theme.colors.pathControlOutline,
						width: sw,
					},
				});
			} else {
				rectFills.push({
					kind: "rect",
					cx: handle.worldX,
					cy: handle.worldY,
					width: { screen: sizePx },
					height: { screen: sizePx },
					fill: {
						color: handle.selected
							? theme.colors.pathAnchorFillSelected
							: theme.colors.pathAnchorFill,
					},
				});
				rectStrokes.push({
					kind: "rect",
					cx: handle.worldX,
					cy: handle.worldY,
					width: { screen: sizePx },
					height: { screen: sizePx },
					stroke: {
						color: handle.selected
							? theme.colors.pathAnchorOutlineSelected
							: theme.colors.pathAnchorOutline,
						width: sw,
					},
				});
			}
		}
	}

	// Mesh warp cages: edge curves behind the handle shapes, handles batched
	// into the same category groups as path handles.
	for (const cage of data.meshCages ?? []) {
		// Same dashed bounding box the select tool shows for a mesh warp
		// container, so the container reads the same in both tools. White and
		// drawn after the edge curves, because it coincides with the cage
		// boundary on an undeformed cage — underneath, the solid boundary would
		// paint over every dash.
		boundsRects.push({
			kind: "rect",
			...rectGeom(
				cage.bounds.minX,
				cage.bounds.minY,
				cage.bounds.maxX,
				cage.bounds.maxY,
			),
			stroke: {
				color: theme.colors.white,
				width: sw,
				dash: theme.dash.selectionBounds,
			},
		});
		for (const edge of cage.edges) {
			prims.push({
				kind: "bezierPath",
				segments: [edge],
				stroke: {
					color: theme.colors.selectionPath,
					width: theme.strokeWidth.path,
				},
			});
		}
		for (const handle of cage.handles) {
			hitProxies.push({
				kind: "circle",
				cx: handle.worldX,
				cy: handle.worldY,
				radius: { screen: theme.hitTolerancePx },
				hitPadding: 0,
				hitId: handle.id,
				hitOnly: true,
				zIndex: handle.handleType === "mesh-cp" ? 2 : 1,
			});
			if (handle.handleType === "mesh-cp") {
				if (
					handle.stemWorldX !== undefined &&
					handle.stemWorldY !== undefined
				) {
					lines.push({
						kind: "line",
						x1: handle.stemWorldX,
						y1: handle.stemWorldY,
						x2: handle.worldX,
						y2: handle.worldY,
						stroke: { color: theme.colors.pathHandleLine, width: sw },
					});
				}
				circleFills.push({
					kind: "circle",
					cx: handle.worldX,
					cy: handle.worldY,
					radius: { screen: radiusPx },
					fill: {
						color: handle.selected
							? theme.colors.pathControlFillSelected
							: theme.colors.pathControlFill,
					},
				});
				circleStrokes.push({
					kind: "circle",
					cx: handle.worldX,
					cy: handle.worldY,
					radius: { screen: radiusPx },
					stroke: {
						color: handle.selected
							? theme.colors.pathControlOutlineSelected
							: theme.colors.pathControlOutline,
						width: sw,
					},
				});
			} else {
				const fillColor: RGBA = handle.selected
					? theme.colors.pathAnchorFillSelected
					: theme.colors.pathAnchorFill;
				const outlineColor: RGBA = handle.selected
					? theme.colors.pathAnchorOutlineSelected
					: theme.colors.pathAnchorOutline;
				if (handle.isDerived) {
					// A derived vertex rides its edge instead of standing on its own.
					// The diamond silhouette tells the two apart at a glance, where a
					// size or line-style difference on a 10px marker does not.
					// Outline batches with the stem lines; fill draws last.
					lines.push({
						kind: "diamond",
						cx: handle.worldX,
						cy: handle.worldY,
						halfSize: { screen: radiusPx },
						stroke: { color: outlineColor, width: sw },
					});
					diamondFills.push({
						kind: "diamond",
						cx: handle.worldX,
						cy: handle.worldY,
						halfSize: { screen: radiusPx },
						fill: { color: fillColor },
					});
					continue;
				}
				rectFills.push({
					kind: "rect",
					cx: handle.worldX,
					cy: handle.worldY,
					width: { screen: sizePx },
					height: { screen: sizePx },
					fill: { color: fillColor },
				});
				rectStrokes.push({
					kind: "rect",
					cx: handle.worldX,
					cy: handle.worldY,
					width: { screen: sizePx },
					height: { screen: sizePx },
					stroke: { color: outlineColor, width: sw },
				});
			}
		}
	}

	prims.push(
		...boundsRects,
		...lines,
		...circleFills,
		...circleStrokes,
		...rectFills,
		...rectStrokes,
		...diamondFills,
		...hitProxies,
	);

	// Long-press indicator ring
	if (data.longPressRing) {
		prims.push({
			kind: "circle",
			cx: data.longPressRing.worldX,
			cy: data.longPressRing.worldY,
			radius: { screen: sizePx * 0.9 },
			stroke: { color: theme.colors.pathLongPressRing, width: sw },
		});
	}

	// Lasso selection path
	if (data.lassoPath && data.lassoPath.length >= 2) {
		prims.push({
			kind: "polyline",
			points: data.lassoPath,
			closed: true,
			...(data.lassoPath.length >= 3
				? { fill: { color: theme.colors.pathEditLassoFill } }
				: {}),
			stroke: { color: theme.colors.pathEditLassoStroke, width: sw },
		});
	}

	return prims;
}

/** Hit priority as a z offset: corner > anchor > control (PathEditTool order). */
function handleHitZ(type: ControlPointHandle["type"]): number {
	if (type === "corner-radius" || type === "corner-superellipse-k") return 2;
	if (type === "anchor") return 1;
	return 0;
}

type SegmentGroup = Partial<
	Record<ControlPointHandle["pointType"], ControlPointHandle>
>;

function getSegmentGroups(
	controlPoints: ControlPointHandle[],
): Map<number, SegmentGroup> {
	const segmentGroups = new Map<number, SegmentGroup>();
	for (const handle of controlPoints) {
		const group = segmentGroups.get(handle.segmentIndex) ?? {};
		group[handle.pointType] = handle;
		segmentGroups.set(handle.segmentIndex, group);
	}
	return segmentGroups;
}

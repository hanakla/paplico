import type { UIPrimitive } from "../primitives";
import type { RGBA, UITheme } from "../theme";
import type { StrokeWidthEditUIData } from "../types";

/**
 * Stroke-width edit overlay: path outline, width envelope, cross lines and
 * per-side width handles.
 */
export function buildStrokeWidthEditOverlay(
	data: StrokeWidthEditUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const sw = theme.strokeWidth.default;
	const radiusPx = theme.handleSize.strokeWidthEditRadius;

	// 1. Path outline (blue)
	prims.push({
		kind: "bezierPath",
		segments: data.pathSegments,
		stroke: {
			color: theme.colors.selectionPath,
			width: theme.strokeWidth.path,
		},
	});

	// 2. Width profile envelope (alternating: even = side1, odd = side2)
	for (let i = 0; i < data.envelopeLines.length; i++) {
		const line = data.envelopeLines[i];
		prims.push({
			kind: "line",
			x1: line.x1,
			y1: line.y1,
			x2: line.x2,
			y2: line.y2,
			stroke: {
				color:
					i % 2 === 0
						? theme.colors.strokeWidthEnvelopeSide1
						: theme.colors.strokeWidthEnvelopeSide2,
				width: sw,
			},
		});
	}

	// 3. Cross lines (gray, connecting side1 and side2 handles through the path center)
	for (const line of data.crossLines) {
		prims.push({
			kind: "line",
			x1: line.x1,
			y1: line.y1,
			x2: line.x2,
			y2: line.y2,
			stroke: { color: theme.colors.pathHandleLine, width: sw },
		});
	}

	// 4. Side handles (all fills → all outlines, rings in handle order)
	const fills: UIPrimitive[] = [];
	const outlines: UIPrimitive[] = [];

	for (const handle of data.handles) {
		// side1 = green, side2 = blue
		const fillColor: RGBA =
			handle.side === "side1"
				? theme.colors.strokeWidthHandleSide1
				: theme.colors.strokeWidthHandleSide2;

		if (handle.selected) {
			outlines.push({
				kind: "circle",
				cx: handle.worldX,
				cy: handle.worldY,
				radius: { screen: radiusPx + theme.handleSize.selectionRingOffset },
				stroke: { color: theme.colors.strokeWidthSelectionRing, width: sw },
			});
		}

		// hitPadding pins the effective hit radius to hitTolerancePx (8px),
		// matching the historical center-distance test in StrokeWidthEditTool.
		fills.push({
			kind: "circle",
			cx: handle.worldX,
			cy: handle.worldY,
			radius: { screen: radiusPx },
			hitId: `${handle.pointIndex}:${handle.side}`,
			hitPadding: { screen: theme.hitTolerancePx - radiusPx },
			fill: { color: fillColor },
		});

		outlines.push({
			kind: "circle",
			cx: handle.worldX,
			cy: handle.worldY,
			radius: { screen: radiusPx },
			stroke: { color: theme.colors.white, width: sw },
		});
	}

	prims.push(...fills, ...outlines);

	// 5. Point handles, sitting on the path between their two side handles.
	// They take no hit padding, so their 4px disc wins the middle while the
	// side handles keep the 8px ring around it — on a thin stroke the three
	// otherwise sit on top of each other.
	for (const handle of data.centerHandles) {
		if (handle.selected) {
			prims.push({
				kind: "circle",
				cx: handle.worldX,
				cy: handle.worldY,
				radius: { screen: radiusPx + theme.handleSize.selectionRingOffset },
				stroke: { color: theme.colors.strokeWidthSelectionRing, width: sw },
			});
		}

		prims.push({
			kind: "circle",
			cx: handle.worldX,
			cy: handle.worldY,
			radius: { screen: radiusPx },
			// The endpoints anchor the profile to the ends of the path.
			...(handle.fixed
				? {}
				: {
						hitId: `${handle.pointIndex}:center`,
						hitPadding: { screen: 0 },
					}),
			fill: { color: theme.colors.white },
			stroke: { color: theme.colors.selectionPath, width: sw },
		});
	}

	return prims;
}

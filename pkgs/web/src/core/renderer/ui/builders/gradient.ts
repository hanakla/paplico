import type { UIPrimitive } from "../primitives";
import type { RGBA, UITheme } from "../theme";
import type { GradientEditUIData } from "../types";

/**
 * Gradient edit overlay: mesh bezier edges, radius circles/ellipses,
 * connection lines and stop/vertex handles.
 *
 * Each handle's fill and outline share one circle primitive so both use the
 * same closed-path fill/stroke lowering path.
 */
export function buildGradientOverlay(
	data: GradientEditUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const sw = theme.strokeWidth.default;
	const handlePx = theme.handleSize.gradient;

	// Cubic bezier edges (mesh gradient), beneath handles
	if (data.bezierEdges && data.bezierEdges.length > 0) {
		const normalEdges: BezierSeg[] = [];
		const highlightedEdges: BezierSeg[] = [];
		for (const edge of data.bezierEdges) {
			const seg = {
				start: edge.start,
				cp1: edge.cp1,
				cp2: edge.cp2,
				end: edge.end,
			};
			if (edge.highlighted) highlightedEdges.push(seg);
			else normalEdges.push(seg);
		}
		if (normalEdges.length > 0) {
			prims.push({
				kind: "bezierPath",
				segments: normalEdges,
				stroke: {
					color: theme.colors.gradientLine,
					width: theme.strokeWidth.path,
				},
			});
		}
		if (highlightedEdges.length > 0) {
			prims.push({
				kind: "bezierPath",
				segments: highlightedEdges,
				stroke: {
					color: theme.colors.gradientFreeCp,
					width: theme.strokeWidth.path,
				},
			});
		}
	}

	// Radial gradient radius circles
	for (const circle of data.circles) {
		prims.push({
			kind: "circle",
			cx: circle.cx,
			cy: circle.cy,
			radius: circle.radius,
			stroke: { color: circle.color, width: sw },
		});
	}

	// Elliptical radial gradient outlines
	for (const ellipse of data.ellipses) {
		prims.push({
			kind: "arc",
			cx: ellipse.centerX,
			cy: ellipse.centerY,
			radiusX: ellipse.radiusX,
			radiusY: ellipse.radiusY,
			rotation: ellipse.rotation,
			startAngle: 0,
			endAngle: Math.PI * 2,
			stroke: { color: ellipse.color, width: ellipse.width ?? sw },
		});
	}

	// Connections between handles
	for (const line of data.lines) {
		const width = line.width ?? sw;
		if (line.outlined) {
			prims.push({
				kind: "line",
				x1: line.x1,
				y1: line.y1,
				x2: line.x2,
				y2: line.y2,
				stroke: {
					color: theme.colors.gradientStopConnection,
					width: width + sw * 2,
				},
			});
		}
		prims.push({
			kind: "line",
			x1: line.x1,
			y1: line.y1,
			x2: line.x2,
			y2: line.y2,
			stroke: { color: line.color, width },
		});
	}

	// Handles
	const selectionRings: UIPrimitive[] = [];
	const outerRings: UIPrimitive[] = [];
	const handleCircles: UIPrimitive[] = [];

	for (const handle of data.handles) {
		const isMidpointHandle =
			handle.handleType === "linear-midpoint" ||
			handle.handleType === "radial-midpoint";
		const isCp =
			handle.handleType === "free-cp" || handle.handleType === "mesh-cp";
		const isDerived = handle.isDerived === true;
		// A ColorStop (CS): linear-stop, radial-stop, free-stop, and an
		// explicit (non-derived) mesh vertex all carry a color the same way,
		// so they render with the same larger size and thicker outline.
		// Non-CS controls (start/end/center/radius/rotation) stay at the
		// smaller default size — they shouldn't be visually mistaken for a
		// ColorStop.
		const isStopHandle =
			handle.handleType === "linear-stop" ||
			handle.handleType === "radial-stop" ||
			handle.handleType === "free-stop" ||
			(handle.handleType === "mesh-vertex" && !isDerived);
		// Midpoint handles fall through to the same default tier as
		// start/end/center/radius/rotation (handlePx/2 = 5px): bigger than
		// the 4px axis line, smaller than a stop's 6px handle.
		const radiusPx = isCp
			? handlePx / 3
			: isDerived
				? handlePx / 3
				: isStopHandle
					? handlePx * 0.6
					: handlePx / 2;

		// Selection ring
		if (handle.selected) {
			selectionRings.push({
				kind: "circle",
				cx: handle.worldX,
				cy: handle.worldY,
				radius: { screen: radiusPx + handlePx / 4 },
				stroke: { color: theme.colors.gradientSelectionRing, width: sw },
			});
		}

		const outlineColor: RGBA =
			handle.handleType === "linear-start" ||
			handle.handleType === "radial-center"
				? theme.colors.gradientOutlineStart // Blue
				: handle.handleType === "linear-end"
					? theme.colors.gradientOutlineEnd // Red
					: handle.handleType === "linear-midpoint" ||
							handle.handleType === "radial-midpoint"
						? theme.colors.gradientStopConnection // Gray
						: theme.colors.gradientOutlineDefault; // White

		// Outer gray ring, just outside the handle's own white/colored outline.
		// Midpoint handles already outline in this same gray, so a second ring
		// would just double a already-gray edge into two faint concentric lines.
		if (!isMidpointHandle) {
			outerRings.push({
				kind: "circle",
				cx: handle.worldX,
				cy: handle.worldY,
				radius: { screen: radiusPx + sw },
				stroke: { color: theme.colors.gradientStopConnection, width: sw },
			});
		}

		// hitPadding pins the effective hit radius to handlePx (10px), matching
		// GradientTool's center-distance tolerance regardless of drawn radius.
		handleCircles.push({
			kind: "circle",
			cx: handle.worldX,
			cy: handle.worldY,
			radius: { screen: radiusPx },
			hitId: handle.id,
			hitPadding: { screen: handlePx - radiusPx },
			fill: { color: handle.color },
			stroke: {
				color: outlineColor,
				width: isStopHandle ? theme.strokeWidth.meshVertexOutline : sw,
			},
		});
	}

	prims.push(...selectionRings, ...outerRings, ...handleCircles);
	return prims;
}

type BezierSeg = {
	start?: { x: number; y: number };
	cp1: { x: number; y: number };
	cp2: { x: number; y: number };
	end: { x: number; y: number };
};

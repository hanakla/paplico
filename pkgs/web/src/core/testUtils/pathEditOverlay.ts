import type {
	CirclePrimitive,
	UIOverlay,
	UIPrimitive,
} from "../renderer/ui/primitives";
import { UI_THEME } from "../renderer/ui/theme";
import type { ControlPointHandle } from "../renderer/ui/types";
import type { MockToolContext } from "./mockToolContext";
import {
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "./pointerEvent";

/**
 * Test-side reconstruction of path-edit overlay content: control-point info is
 * restored from the hit-proxy circles (hitId = "pathId:segmentIndex:pointType")
 * and selection state from the selected-variant fill colors.
 */

export interface RestoredControlPoint {
	type: ControlPointHandle["type"];
	pathId: string;
	segmentIndex: number;
	pointType: string;
	worldX: number;
	worldY: number;
	screenX: number;
	screenY: number;
	selected: boolean;
}

/**
 * Last overlay pushed to `key`. Returns undefined when the key was never set
 * (since the last mockClear), null when it was explicitly cleared.
 */
export function lastOverlayCall(
	ctx: MockToolContext,
	key: string,
): UIOverlay | null | undefined {
	const call = ctx.uiSetOverlay.mock.calls.filter(([k]) => k === key).at(-1);
	return call ? call[1] : undefined;
}

/** Control points restored from the last overlay pushed to `key`. */
export function getControlPoints(
	ctx: MockToolContext,
	key: string,
): RestoredControlPoint[] {
	const overlay = lastOverlayCall(ctx, key);
	if (!overlay) return [];
	const prims = overlay.primitives;
	return prims
		.filter(
			(p): p is CirclePrimitive & { hitId: string } =>
				p.kind === "circle" && p.hitOnly === true && p.hitId != null,
		)
		.map((p) => {
			const [pathId, segmentIndexStr, pointType] = p.hitId.split(":");
			return {
				type: typeOfPointType(pointType),
				pathId,
				segmentIndex: Number(segmentIndexStr),
				pointType,
				worldX: p.cx,
				worldY: p.cy,
				// world → screen for the test coordinate system (Y flip)
				screenX:
					(p.cx - testViewport.x) * testViewport.zoom + testCanvasWidth / 2,
				screenY:
					-(p.cy - testViewport.y) * testViewport.zoom + testCanvasHeight / 2,
				selected: isSelectedAt(prims, p.cx, p.cy, pointType),
			};
		});
}

function typeOfPointType(pointType: string): ControlPointHandle["type"] {
	if (pointType === "corner-radius") return "corner-radius";
	if (pointType === "corner-superellipse-k") return "corner-superellipse-k";
	if (pointType === "cp1" || pointType === "cp2") return "control";
	return "anchor";
}

/** Selection is encoded as the selected-variant fill color of the drawn shape. */
function isSelectedAt(
	prims: readonly UIPrimitive[],
	cx: number,
	cy: number,
	pointType: string,
): boolean {
	if (pointType === "corner-radius") {
		return prims.some(
			(q) =>
				q.kind === "circle" &&
				!q.hitOnly &&
				q.cx === cx &&
				q.cy === cy &&
				q.fill?.color === UI_THEME.colors.pathCornerRadiusFillSelected,
		);
	}
	if (pointType === "corner-superellipse-k") {
		return prims.some(
			(q) =>
				q.kind === "diamond" &&
				q.cx === cx &&
				q.cy === cy &&
				q.fill?.color === UI_THEME.colors.pathSuperellipseFillSelected,
		);
	}
	if (pointType === "cp1" || pointType === "cp2") {
		return prims.some(
			(q) =>
				q.kind === "circle" &&
				!q.hitOnly &&
				q.cx === cx &&
				q.cy === cy &&
				q.fill?.color === UI_THEME.colors.pathControlFillSelected,
		);
	}
	return prims.some(
		(q) =>
			q.kind === "rect" &&
			q.cx === cx &&
			q.cy === cy &&
			q.fill?.color === UI_THEME.colors.pathAnchorFillSelected,
	);
}

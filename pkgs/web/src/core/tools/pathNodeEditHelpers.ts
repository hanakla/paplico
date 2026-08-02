/**
 * Shared node-editing helpers for PathTool (creation) and PathEditTool (editing).
 *
 * Holds the anchor/segment conversion primitives plus pure functions for
 * hit-testing anchors, deleting anchors, building control-point handles, and
 * the alt-anchor tangent CP creation math. Both tools depend on this module so
 * that neither needs to import the other (avoids an import cycle).
 */

import type { ControlPointHandle } from "../renderer/ui/types";
import type {
	BezierPoint,
	CubicBezierSegment,
	ElementTransform,
	Path,
	Viewport,
} from "../schema";
import { worldToScreen } from "../utils/geometry/geometry";
import {
	getStartAnchor,
	getWorldSegments,
	resolveSegment,
	splitSegmentAtIndex,
} from "../utils/geometry/segmentOps";

// --- Types ---

export type AnchorNode = {
	position: { x: number; y: number };
	/** Out-handle (control point toward next segment). null = straight line */
	handleOut: { x: number; y: number } | null;
	/** In-handle (control point from previous segment). null = straight line */
	handleIn: { x: number; y: number } | null;
};

// --- Anchor <-> segment conversion primitives ---

export function buildSegments(
	anchors: AnchorNode[],
	closed: boolean,
): CubicBezierSegment[] {
	const segments: CubicBezierSegment[] = [];
	const count = closed ? anchors.length : anchors.length - 1;

	for (let i = 0; i < count; i++) {
		const from = anchors[i];
		const to = anchors[(i + 1) % anchors.length];
		const startAnchor = from.position;

		segments.push({
			start: i === 0 ? { x: from.position.x, y: from.position.y } : undefined,
			cp1: from.handleOut
				? {
						x: from.handleOut.x - startAnchor.x,
						y: from.handleOut.y - startAnchor.y,
					}
				: { x: 0, y: 0 },
			cp2: to.handleIn
				? { x: to.handleIn.x - to.position.x, y: to.handleIn.y - to.position.y }
				: { x: 0, y: 0 },
			end: { x: to.position.x, y: to.position.y },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
			isClosed: (closed && i === count - 1) || undefined,
		});
	}

	return segments;
}

export function anchorsFromSegments(
	segments: CubicBezierSegment[],
	fallbackFirstAnchor: AnchorNode | null,
): AnchorNode[] {
	if (segments.length === 0) {
		return fallbackFirstAnchor ? [cloneAnchor(fallbackFirstAnchor)] : [];
	}

	const firstResolved = resolveSegment(segments[0], undefined);
	const firstStart = firstResolved.start ?? firstResolved.end;
	if (isSamePoint(firstStart, firstResolved.end)) {
		return [
			{
				position: { x: firstStart.x, y: firstStart.y },
				handleOut: toHandleOrNull(firstStart, firstResolved.cp1),
				handleIn: toHandleOrNull(firstResolved.end, firstResolved.cp2),
			},
		];
	}

	const anchors: AnchorNode[] = [];

	for (let i = 0; i < segments.length; i++) {
		const resolved = resolveSegment(
			segments[i],
			i > 0 ? segments[i - 1].end : undefined,
		);
		const start = resolved.start ?? resolved.end;

		const startAnchor =
			anchors[i] ??
			({
				position: { x: start.x, y: start.y },
				handleOut: null,
				handleIn: null,
			} satisfies AnchorNode);
		startAnchor.position = { x: start.x, y: start.y };
		startAnchor.handleOut = toHandleOrNull(start, resolved.cp1);
		anchors[i] = startAnchor;

		const endHandleIn = toHandleOrNull(resolved.end, resolved.cp2);
		const isLastClosedSegment =
			i === segments.length - 1 && segments[i].isClosed === true;
		if (isLastClosedSegment) {
			anchors[0].handleIn = endHandleIn;
			continue;
		}

		anchors[i + 1] = {
			position: { x: resolved.end.x, y: resolved.end.y },
			handleOut: null,
			handleIn: endHandleIn,
		};
	}

	return anchors;
}

export function cloneAnchor(anchor: AnchorNode): AnchorNode {
	return {
		position: { x: anchor.position.x, y: anchor.position.y },
		handleOut: anchor.handleOut
			? { x: anchor.handleOut.x, y: anchor.handleOut.y }
			: null,
		handleIn: anchor.handleIn
			? { x: anchor.handleIn.x, y: anchor.handleIn.y }
			: null,
	};
}

// --- Node editing helpers ---

/**
 * Map a path-edit handle (segmentIndex + start/end) to an anchor index in the
 * array produced by `anchorsFromSegments`. The very first anchor is the start
 * of segment 0; every other anchor is the end of its segment.
 */
function anchorIndexFromHandle(
	segmentIndex: number,
	pointType: "start" | "end",
): number {
	return pointType === "start" && segmentIndex === 0 ? 0 : segmentIndex + 1;
}

/**
 * Remove the anchor identified by a path-edit handle (segmentIndex + start/end)
 * from a path. Returns the rebuilt segments, "erase" when fewer than 2 anchors
 * remain (the element should be deleted), or null for an invalid index.
 */
export function deleteAnchorFromPath(
	path: Path,
	segmentIndex: number,
	pointType: "start" | "end",
): CubicBezierSegment[] | "erase" | null {
	return deleteAnchorsFromPath(path, [{ segmentIndex, pointType }]);
}

/**
 * Remove several anchors (identified by path-edit handles) at once, rejoining
 * the surviving neighbors — the multi-anchor form of deleteAnchorFromPath.
 * Returns the rebuilt segments, "erase" when fewer than 2 anchors remain, or
 * null when no handle maps to a valid anchor.
 */
export function deleteAnchorsFromPath(
	path: Path,
	handles: ReadonlyArray<{
		segmentIndex: number;
		pointType: "start" | "end";
	}>,
): CubicBezierSegment[] | "erase" | null {
	const isClosed = path.segments.at(-1)?.isClosed === true;
	const anchors = anchorsFromSegments(path.segments, null);
	const deleted = collectAnchorIndices(handles, anchors.length, isClosed);
	if (deleted.size === 0) return null;

	const survivors = anchors.filter((_, index) => !deleted.has(index));
	if (survivors.length < 2) return "erase";

	return buildSegments(survivors, isClosed);
}

/**
 * Remove several anchors WITHOUT rejoining: every segment touching a deleted
 * anchor disappears, and each surviving run of consecutive anchors becomes its
 * own open segment list (a closed ring is cut at the deleted anchors).
 * Runs with fewer than 2 anchors are dropped. Returns the runs, "erase" when
 * nothing drawable remains, or null when no handle maps to a valid anchor.
 */
export function breakDeleteAnchorsFromPath(
	path: Path,
	handles: ReadonlyArray<{
		segmentIndex: number;
		pointType: "start" | "end";
	}>,
): CubicBezierSegment[][] | "erase" | null {
	const isClosed = path.segments.at(-1)?.isClosed === true;
	const anchors = anchorsFromSegments(path.segments, null);
	const deleted = collectAnchorIndices(handles, anchors.length, isClosed);
	if (deleted.size === 0) return null;

	// For a closed ring, start iteration right after a deleted anchor so the
	// wrap-around run stays contiguous in the linear scan below.
	let ordered = anchors.map((anchor, index) => ({ anchor, index }));
	if (isClosed) {
		const firstDeleted = Math.min(...deleted);
		ordered = [
			...ordered.slice(firstDeleted + 1),
			...ordered.slice(0, firstDeleted),
		];
	}

	const runs: AnchorNode[][] = [];
	let current: AnchorNode[] = [];
	for (const { anchor, index } of ordered) {
		if (deleted.has(index)) {
			if (current.length > 0) runs.push(current);
			current = [];
		} else {
			current.push(anchor);
		}
	}
	if (current.length > 0) runs.push(current);

	const segmentLists = runs
		.filter((run) => run.length >= 2)
		.map((run) => buildSegments(run, false));
	return segmentLists.length === 0 ? "erase" : segmentLists;
}

/** Where a cut lands on a path: on an existing anchor, or inside a segment. */
export type PathCutPosition =
	| { kind: "anchor"; pointType: "start" | "end" }
	| { kind: "edge"; t: number };

/**
 * Cut a path open at an anchor or at a point inside a segment. An open path
 * yields the two runs on either side of the cut; a closed path yields a single
 * open run that starts and ends at the cut point. A cut inside a segment first
 * materializes that point as a real anchor. Returns null when there is nothing
 * to separate — the endpoints of an open path, or an out-of-range index.
 */
export function cutPathSegments(
	segments: CubicBezierSegment[],
	segmentIndex: number,
	position: PathCutPosition,
): CubicBezierSegment[][] | null {
	if (segmentIndex < 0 || segmentIndex >= segments.length) return null;

	// Inserting the anchor turns an edge cut into an anchor cut on the boundary
	// between the two halves of the segment that was split.
	const working =
		position.kind === "edge"
			? splitSegmentAtIndex(segments, segmentIndex, position.t)
			: segments;
	const boundary =
		position.kind === "edge" || position.pointType === "end"
			? segmentIndex + 1
			: segmentIndex;

	if (working.at(-1)?.isClosed === true) {
		// A closed ring is a single subpath, so rotating the cut point to the
		// front and dropping the closing flag is all it takes to open it.
		const pivot = boundary % working.length;
		const cutAnchor = anchorAtBoundary(working, pivot);
		const opened = [...working.slice(pivot), ...working.slice(0, pivot)].map(
			(segment, index) => ({
				...cloneSegment(segment),
				start: index === 0 ? cutAnchor : undefined,
				isMoved: index === 0,
				isClosed: undefined,
			}),
		);
		return [opened];
	}

	if (boundary <= 0 || boundary >= working.length) return null;

	const head = working.slice(0, boundary).map(cloneSegment);
	const tailAnchor = anchorAtBoundary(working, boundary);
	const tail = working.slice(boundary).map((segment, index) =>
		index === 0
			? {
					...cloneSegment(segment),
					start: tailAnchor,
					isMoved: true,
				}
			: cloneSegment(segment),
	);
	return [head, tail];
}

/** Map path-edit handles to unique anchor indices (closed join wraps to 0). */
function collectAnchorIndices(
	handles: ReadonlyArray<{
		segmentIndex: number;
		pointType: "start" | "end";
	}>,
	anchorCount: number,
	isClosed: boolean,
): Set<number> {
	const indices = new Set<number>();
	for (const handle of handles) {
		let index = anchorIndexFromHandle(handle.segmentIndex, handle.pointType);
		// Closed path: end of the last segment is the join shared with anchor 0.
		if (isClosed && index >= anchorCount) index = 0;
		if (index >= 0 && index < anchorCount) indices.add(index);
	}
	return indices;
}

/**
 * Find the nearest path anchor (start of an open path's first segment, or the
 * end of any segment) within `tolWorld` of the world point. Mirrors the
 * unselected-path anchor loop in PathEditTool.findHandleAtPoint.
 */
export function hitTestPathAnchor(
	path: Path,
	ancestorTransform: ElementTransform | null,
	worldX: number,
	worldY: number,
	tolWorld: number,
): {
	segmentIndex: number;
	pointType: "start" | "end";
	worldX: number;
	worldY: number;
	isEndpoint: boolean;
} | null {
	const worldSegs = getWorldSegments(path, ancestorTransform ?? undefined);
	const isClosed = path.segments.at(-1)?.isClosed === true;
	const tolSq = tolWorld * tolWorld;

	let best: {
		segmentIndex: number;
		pointType: "start" | "end";
		worldX: number;
		worldY: number;
		isEndpoint: boolean;
	} | null = null;
	let bestDistSq = tolSq;

	for (let i = 0; i < path.segments.length; i++) {
		const ws = worldSegs[i];

		// Start anchor: only the first segment of an open path
		if (i === 0 && !isClosed && ws.start) {
			const dx = worldX - ws.start.x;
			const dy = worldY - ws.start.y;
			const distSq = dx * dx + dy * dy;
			if (distSq <= bestDistSq) {
				best = {
					segmentIndex: 0,
					pointType: "start",
					worldX: ws.start.x,
					worldY: ws.start.y,
					isEndpoint: true,
				};
				bestDistSq = distSq;
			}
		}

		// End anchor of every segment
		{
			const dx = worldX - ws.end.x;
			const dy = worldY - ws.end.y;
			const distSq = dx * dx + dy * dy;
			if (distSq <= bestDistSq) {
				best = {
					segmentIndex: i,
					pointType: "end",
					worldX: ws.end.x,
					worldY: ws.end.y,
					isEndpoint: !isClosed && i === path.segments.length - 1,
				};
				bestDistSq = distSq;
			}
		}
	}

	return best;
}

/**
 * Build the ControlPointHandle array for displaying a path's anchors and
 * non-zero control points. Field names match PathEditTool.findHandleAtPoint.
 */
export function buildPathControlPoints(
	path: Path,
	ancestorTransform: ElementTransform | null,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): ControlPointHandle[] {
	const worldSegs = getWorldSegments(path, ancestorTransform ?? undefined);
	const isClosed = path.segments.at(-1)?.isClosed === true;
	const handles: ControlPointHandle[] = [];

	const pushHandle = (
		type: ControlPointHandle["type"],
		segmentIndex: number,
		pointType: ControlPointHandle["pointType"],
		world: { x: number; y: number },
	) => {
		const screen = worldToScreen(
			world.x,
			world.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		handles.push({
			type,
			pathId: path.id,
			segmentIndex,
			pointType,
			worldX: world.x,
			worldY: world.y,
			screenX: screen.x,
			screenY: screen.y,
			selected: false,
		});
	};

	for (let i = 0; i < path.segments.length; i++) {
		const seg = path.segments[i];
		const ws = worldSegs[i];

		// Start anchor: only the first segment of an open path
		if (i === 0 && !isClosed && ws.start) {
			pushHandle("anchor", 0, "start", ws.start);
		}

		// End anchor of every segment
		pushHandle("anchor", i, "end", ws.end);

		// cp1: only when the local cp1 is non-zero
		if (Math.hypot(seg.cp1.x, seg.cp1.y) > 1e-6) {
			pushHandle("control", i, "cp1", ws.cp1);
		}

		// cp2: only when the local cp2 is non-zero
		if (Math.hypot(seg.cp2.x, seg.cp2.y) > 1e-6) {
			pushHandle("control", i, "cp2", ws.cp2);
		}
	}

	return handles;
}

/**
 * Reset (zero out) the control points adjacent to an anchor, returning new
 * segments. Used before alt-anchor drag so the tangent starts from linear.
 */
export function resetAnchorSegmentCPs(
	segments: CubicBezierSegment[],
	segmentIndex: number,
	pointType: "start" | "end",
): CubicBezierSegment[] {
	const newSegments = segments.map((seg) => ({
		...seg,
		start: seg.start ? { ...seg.start } : undefined,
		cp1: { ...seg.cp1 },
		cp2: { ...seg.cp2 },
		end: { ...seg.end },
	}));
	const lastSeg = newSegments[newSegments.length - 1];
	const isClosedPath = lastSeg?.isClosed === true;

	if (pointType === "end") {
		newSegments[segmentIndex].cp2 = { x: 0, y: 0 };
		const nextSeg =
			segmentIndex < newSegments.length - 1
				? newSegments[segmentIndex + 1]
				: isClosedPath
					? newSegments[0]
					: null;
		if (nextSeg) {
			nextSeg.cp1 = { x: 0, y: 0 };
		}
	} else if (pointType === "start") {
		newSegments[segmentIndex].cp1 = { x: 0, y: 0 };
		const prevSeg = isClosedPath ? newSegments[newSegments.length - 1] : null;
		if (prevSeg) {
			prevSeg.cp2 = { x: 0, y: 0 };
		}
	}

	return newSegments;
}

/**
 * Apply a tangent-handle drag from an anchor: pull symmetric cp handles out of
 * the anchor by (dx, dy). Returns new segments.
 */
export function applyAnchorCPDrag(
	segments: CubicBezierSegment[],
	segmentIndex: number,
	pointType: "start" | "end",
	dx: number,
	dy: number,
): CubicBezierSegment[] {
	const newSegments = segments.map((seg) => ({
		...seg,
		start: seg.start ? { ...seg.start } : undefined,
		cp1: { ...seg.cp1 },
		cp2: { ...seg.cp2 },
		end: { ...seg.end },
	}));

	const lastSeg = newSegments[newSegments.length - 1];
	const isClosedPath = lastSeg?.isClosed === true;

	if (pointType === "end") {
		// Drag from end anchor: next.cp1 = drag direction, this.cp2 = opposite
		const nextSeg =
			segmentIndex < newSegments.length - 1
				? newSegments[segmentIndex + 1]
				: isClosedPath
					? newSegments[0]
					: null;
		if (nextSeg) {
			nextSeg.cp1 = { x: dx, y: dy };
		}
		newSegments[segmentIndex].cp2 = { x: -dx, y: -dy };
	} else if (pointType === "start" && segmentIndex === 0) {
		// Drag from start anchor: cp1 = drag direction, prev.cp2 = opposite
		newSegments[0].cp1 = { x: dx, y: dy };
		const prevSeg = isClosedPath ? newSegments[newSegments.length - 1] : null;
		if (prevSeg) {
			prevSeg.cp2 = { x: -dx, y: -dy };
		}
	}

	return newSegments;
}

// --- Helper functions ---

/** Absolute anchor sitting on the boundary before `index`. */
function anchorAtBoundary(
	segments: CubicBezierSegment[],
	index: number,
): BezierPoint {
	const anchor =
		index === 0 ? getStartAnchor(segments[0]) : segments[index - 1].end;
	return { ...anchor };
}

function cloneSegment(segment: CubicBezierSegment): CubicBezierSegment {
	return {
		...segment,
		start: segment.start ? { ...segment.start } : undefined,
		cp1: { ...segment.cp1 },
		cp2: { ...segment.cp2 },
		end: { ...segment.end },
	};
}

function toHandleOrNull(
	anchor: { x: number; y: number },
	cp: { x: number; y: number },
): { x: number; y: number } | null {
	const epsilon = 1e-6;
	const isStraight =
		Math.abs(anchor.x - cp.x) < epsilon && Math.abs(anchor.y - cp.y) < epsilon;
	if (isStraight) return null;
	return { x: cp.x, y: cp.y };
}

export function isSamePoint(
	a: { x: number; y: number },
	b: { x: number; y: number },
): boolean {
	const epsilon = 1e-6;
	return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

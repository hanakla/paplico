import { interpolateStrokeWidths } from "../renderer/geometry/strokeTessellator";
import type { BrushSettings } from "../schema";
import {
	type BoundingBox,
	type ElementTransform,
	type EraseMask,
	isGroup,
	isIdentityTransform,
	type Layer,
	type Path,
	type PathSegment,
	type StrokeAppearance,
	type StrokeWidthPoint,
	type Viewport,
} from "../schema";
import { boundsIntersect, calculatePathBounds } from "../utils/geometry/bounds";
import {
	applyTransformToBounds,
	composeTransforms,
	computeTransformOrigin,
	inverseTransform,
	screenToWorld,
} from "../utils/geometry/geometry";
import {
	splitPathByNormalizedRanges,
	subtractEraserFromFilledPath,
} from "../utils/geometry/pathOps";
import { processStroke } from "../utils/geometry/strokeFitting";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

export type EraserMode = "slice" | "mask" | "width-adjust";

interface EraserToolOptions {
	width: number;
	mode: EraserMode;
	/** Mask opacity (0–1). Only used in "mask" mode. Default: 1.0 */
	maskOpacity?: number;
	/** Brush settings for mask rendering. Only used in "mask" mode. */
	maskBrushSettings?: BrushSettings;
	/** Erase across all unlocked layers instead of only the current layer */
	pierceAllLayers?: boolean;
}

interface Point {
	x: number;
	y: number;
}

interface PathPolylinePoint extends Point {
	startsSubpath: boolean;
}

/**
 * 消しゴムストロークのAABBをeraserRadius分拡張して返す。
 */
function computeEraserBounds(
	stroke: Point[],
	eraserRadius: number,
): BoundingBox {
	let minX = stroke[0].x;
	let minY = stroke[0].y;
	let maxX = stroke[0].x;
	let maxY = stroke[0].y;

	for (let i = 1; i < stroke.length; i++) {
		const p = stroke[i];
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}

	return {
		minX: minX - eraserRadius,
		minY: minY - eraserRadius,
		maxX: maxX + eraserRadius,
		maxY: maxY + eraserRadius,
		width: maxX - minX + eraserRadius * 2,
		height: maxY - minY + eraserRadius * 2,
	};
}

/**
 * splitPathByEraserの結果が
 * 元パスから変化したかを判定する。
 *
 * - 結果が0本 → 全消去で交差あり
 * - 結果が2本以上 → 分割で交差あり
 * - 結果が1本 → セグメント数か始点/終点座標が異なれば交差あり
 */
function hasEraserModifiedPath(resultPaths: Path[], original: Path): boolean {
	if (resultPaths.length !== 1) return true;

	const result = resultPaths[0];
	if (result.segments.length !== original.segments.length) return true;

	// 始点の比較
	const origFirst = original.segments[0];
	const resFirst = result.segments[0];
	const origStart = origFirst.start;
	const resStart = resFirst.start;
	if (origStart && resStart) {
		if (
			Math.abs(origStart.x - resStart.x) > 0.01 ||
			Math.abs(origStart.y - resStart.y) > 0.01
		) {
			return true;
		}
	}

	// 終点の比較
	const origLast = original.segments[original.segments.length - 1];
	const resLast = result.segments[result.segments.length - 1];
	if (
		Math.abs(origLast.end.x - resLast.end.x) > 0.01 ||
		Math.abs(origLast.end.y - resLast.end.y) > 0.01
	) {
		return true;
	}

	return false;
}

export class EraserTool implements Tool {
	public readonly name = "eraser";

	private context: ToolContext;
	private options: EraserToolOptions;
	private currentStroke: Point[] | null = null;
	private currentPressures: number[] | null = null;
	private eraserRadius: number;
	/** onPointerMove内での間引き最小距離（eraserRadius / 4） */
	private minMoveDistance: number;

	public constructor(context: ToolContext, options: EraserToolOptions) {
		this.context = context;
		this.options = { ...options, mode: options.mode ?? "slice" };
		this.eraserRadius = options.width / 2;
		this.minMoveDistance = this.eraserRadius / 4;
	}

	public setOptions(options: Partial<EraserToolOptions>): void {
		if (options.width != null) {
			this.options.width = options.width;
			this.eraserRadius = options.width / 2;
			this.minMoveDistance = this.eraserRadius / 4;
		}

		this.options.mode = options.mode ?? this.options.mode;

		if (options.pierceAllLayers != null) {
			this.options.pierceAllLayers = options.pierceAllLayers;
		}
	}

	/** Layers to erase across: all unlocked layers when piercing, else the current one. */
	private resolveTargetLayers(): Layer[] {
		if (this.options.pierceAllLayers) {
			return this.context.getLayers();
		}
		const current = this.context.getCurrentLayer();
		return current ? [current] : [];
	}

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly()) return;

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		this.currentStroke = [worldPos];
		this.currentPressures = [event.pressure ?? 0.5];
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (!this.currentStroke) return;

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);

		// 距離ベース間引き: 前のポイントから最小距離未満の場合はスキップ
		const last = this.currentStroke[this.currentStroke.length - 1];
		const dx = worldPos.x - last.x;
		const dy = worldPos.y - last.y;
		if (dx * dx + dy * dy < this.minMoveDistance * this.minMoveDistance) {
			return;
		}

		this.currentStroke.push(worldPos);
		this.currentPressures!.push(event.pressure ?? 0.5);
	}

	public onPointerUp(
		_event: PointerEventData,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): void {
		if (!this.currentStroke || this.currentStroke.length === 0) {
			this.currentStroke = null;
			this.currentPressures = null;
			return;
		}

		const targetLayers = this.resolveTargetLayers();
		if (targetLayers.length === 0) {
			this.currentStroke = null;
			this.currentPressures = null;
			return;
		}

		switch (this.options.mode) {
			case "slice":
			case "width-adjust":
				this.performUnifiedErase(targetLayers);
				break;
			case "mask":
				this.performMaskErase(targetLayers);
				break;
		}

		this.currentStroke = null;
		this.currentPressures = null;
	}

	/**
	 * Unified erase: slice first, then width-adjust on surviving/new paths.
	 * All mutations happen in a single transact.
	 */
	private performUnifiedErase(layers: Layer[]): void {
		if (!this.currentStroke) return;

		const eraserBounds = computeEraserBounds(
			this.currentStroke,
			this.eraserRadius,
		);

		const objects = this.context.getObjects();
		const sliceResults: Array<{
			id: string;
			layerId: string;
			splitPaths: Path[];
		}> = [];
		const widthUpdates: Array<{
			id: string;
			layerId: string;
			strokeWidths: StrokeWidthPoint[];
		}> = [];

		const targets = layers.flatMap((layer) =>
			layer.locked
				? []
				: this.getTargetElementIds(layer).map((id) => ({ id, layer })),
		);

		for (const { id: elementId, layer } of targets) {
			if (this.context.isElementLocked(elementId)) continue;

			const element = objects[elementId];
			if (element?.type !== "path") continue;

			const pathEl = element;
			const composedT = resolveComposedTransform(
				this.context,
				elementId,
				element,
			);

			const localBounds = calculatePathBounds(pathEl);
			const brushHalfSize = getBrushHalfSize(pathEl);

			// AABB check in world space (expand by brush half-size for thick stroke edges)
			const expandedBounds = {
				minX: localBounds.minX - brushHalfSize,
				minY: localBounds.minY - brushHalfSize,
				maxX: localBounds.maxX + brushHalfSize,
				maxY: localBounds.maxY + brushHalfSize,
				width: localBounds.width + brushHalfSize * 2,
				height: localBounds.height + brushHalfSize * 2,
			};
			const worldBounds = applyTransformToBounds(expandedBounds, composedT);
			if (!boundsIntersect(worldBounds, eraserBounds)) continue;

			// Convert eraser to local space once for both slice and width-adjust
			const origin = computeTransformOrigin(localBounds);
			const localStroke = worldToLocalFull(
				this.currentStroke,
				composedT,
				origin,
			);
			const avgScale =
				(Math.abs(composedT.scaleX) + Math.abs(composedT.scaleY)) / 2;
			const localEraserRadius =
				avgScale > 0 ? this.eraserRadius / avgScale : this.eraserRadius;
			const hasFill = pathEl.filters?.some((f) => f.processor === "fill");

			if (hasFill) {
				const splitResult = subtractEraserFromFilledPath(
					pathEl,
					localStroke,
					localEraserRadius,
				);
				if (hasEraserModifiedPath(splitResult, pathEl)) {
					sliceResults.push({
						id: elementId,
						layerId: layer.id,
						splitPaths: splitResult,
					});
				}
				continue;
			}

			const newWidths = computeWidthAdjustment(
				pathEl,
				localStroke,
				localEraserRadius,
				brushHalfSize,
			);
			if (!newWidths) continue;

			const cutRanges = findNegativeWidthRanges(newWidths);
			if (cutRanges.length === 0) {
				widthUpdates.push({
					id: elementId,
					layerId: layer.id,
					strokeWidths: newWidths,
				});
				continue;
			}

			const splitPaths = splitPathByNormalizedRanges(pathEl, cutRanges);
			const sourcePathStart = pathEl.pathStart ?? 0;
			const sourcePathSpan = (pathEl.pathEnd ?? 1) - sourcePathStart;
			for (const splitPath of splitPaths) {
				const localPathStart =
					((splitPath.pathStart ?? sourcePathStart) - sourcePathStart) /
					sourcePathSpan;
				const localPathEnd =
					((splitPath.pathEnd ?? sourcePathStart + sourcePathSpan) -
						sourcePathStart) /
					sourcePathSpan;
				splitPath.strokeWidths = sliceStrokeWidths(
					newWidths,
					localPathStart,
					localPathEnd,
				);
			}
			sliceResults.push({ id: elementId, layerId: layer.id, splitPaths });
		}

		if (sliceResults.length === 0 && widthUpdates.length === 0) return;

		const layerById = new Map(
			layers.map((layer) => [layer.id, layer] as const),
		);
		const splitLocations = new Map<
			string,
			{ parentGroupId: string | null; index: number }
		>();
		for (const { id, layerId } of sliceResults) {
			for (const obj of Object.values(objects)) {
				if (!obj || !isGroup(obj)) continue;
				const index = obj.childIds.indexOf(id);
				if (index !== -1) {
					splitLocations.set(id, { parentGroupId: obj.id, index });
					break;
				}
			}
			if (!splitLocations.has(id)) {
				const index = layerById.get(layerId)?.elementIds.indexOf(id) ?? -1;
				if (index !== -1) {
					splitLocations.set(id, { parentGroupId: null, index });
				}
			}
		}
		const orderedSliceResults = [...sliceResults].sort((a, b) => {
			const aLocation = splitLocations.get(a.id);
			const bLocation = splitLocations.get(b.id);
			const aParent = aLocation?.parentGroupId ?? a.layerId;
			const bParent = bLocation?.parentGroupId ?? b.layerId;
			return (
				aParent.localeCompare(bParent) ||
				(aLocation?.index ?? 0) - (bLocation?.index ?? 0)
			);
		});

		this.context.transact((commands) => {
			// Delete all sliced elements in one batch to avoid stale Valtio reads
			// overwriting Yjs childIds when multiple group children are processed
			if (sliceResults.length > 0) {
				commands.deleteElements(sliceResults.map(({ id }) => id));
			}

			const insertionOffsets = new Map<
				string,
				{ removed: number; inserted: number }
			>();
			for (const { id, layerId, splitPaths } of orderedSliceResults) {
				const location = splitLocations.get(id);
				if (!location) continue;

				const parentKey = location.parentGroupId ?? layerId;
				const offsets = insertionOffsets.get(parentKey) ?? {
					removed: 0,
					inserted: 0,
				};
				const insertIndex = location.index - offsets.removed + offsets.inserted;
				if (location.parentGroupId) {
					commands.addPathsToGroup(
						splitPaths,
						location.parentGroupId,
						insertIndex,
						layerId,
					);
				} else {
					commands.addPaths(splitPaths, insertIndex, layerId);
				}
				offsets.removed++;
				offsets.inserted += splitPaths.length;
				insertionOffsets.set(parentKey, offsets);
			}

			for (const { id, layerId, strokeWidths } of widthUpdates) {
				commands.updateElement(layerId, id, { strokeWidths });
			}
		});
	}

	private performMaskErase(layers: Layer[]): void {
		if (!this.currentStroke || !this.currentPressures) return;
		if (this.currentStroke.length < 2) return;

		const maskOpacity = this.options.maskOpacity ?? 1.0;
		const brushSettings: BrushSettings = this.options.maskBrushSettings ?? {
			type: "scatter",
			source: { kind: "file", fileUid: "__airbrush" },
			size: this.options.width,
			sizeByPressure: 0.5,
			opacity: 1,
			opacityByPressure: 0,
			spacing: 0.1,
			flow: 1,
			stampRotation: "none",
			randomSeed: 0,
			rotationByTilt: 0,
			aspectRatioByTilt: 0,
			sizeBySpeed: 0,
			pooling: 0,
			poolingSizeRatio: 0.5,
		};

		const masks: Array<{ elementId: string; mask: EraseMask }> = [];

		const eraserBounds = computeEraserBounds(
			this.currentStroke,
			this.eraserRadius,
		);

		const objects = this.context.getObjects();
		const targets = layers.flatMap((layer) =>
			layer.locked ? [] : this.getTargetElementIds(layer),
		);
		for (const elementId of targets) {
			if (this.context.isElementLocked(elementId)) continue;

			const element = objects[elementId];
			if (element?.type !== "path") continue;

			const composedT = resolveComposedTransform(
				this.context,
				elementId,
				element,
			);

			// AABB check in world space
			const localBounds = calculatePathBounds(element);
			const worldBounds = applyTransformToBounds(localBounds, composedT);
			if (!boundsIntersect(worldBounds, eraserBounds)) continue;

			// Convert world-space stroke to element's full local space
			const origin = computeTransformOrigin(localBounds);
			const localStroke = worldToLocalFull(
				this.currentStroke,
				composedT,
				origin,
			);
			const segments = buildSegmentsFromStroke(
				localStroke,
				this.currentPressures!,
			);
			if (segments.length === 0) continue;

			masks.push({
				elementId,
				mask: {
					uid: crypto.randomUUID(),
					segments,
					strokeColor: {
						type: "solid",
						color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
					},
					brushSettings,
					opacity: maskOpacity,
				},
			});
		}

		if (masks.length === 0) return;

		this.context.transact((commands) => {
			for (const { elementId, mask } of masks) {
				commands.addEraseMask(elementId, mask);
			}
		});
	}

	/**
	 * Return target element IDs: selected elements if any, otherwise all layer elements.
	 * Groups are expanded recursively so that their children are included as targets.
	 */
	private getTargetElementIds(
		layer: NonNullable<ReturnType<ToolContext["getCurrentLayer"]>>,
	): string[] {
		const objects = this.context.getObjects();

		// Mesh containers are NOT expanded (v1 limitation): their children
		// render warped, so erasing the stored (unwarped) geometry would cut
		// somewhere else than under the eraser.
		const expandGroups = (ids: string[]): string[] => {
			const result: string[] = [];
			for (const id of ids) {
				const obj = objects[id];
				if (obj && isGroup(obj)) {
					result.push(...expandGroups(obj.childIds));
				} else {
					result.push(id);
				}
			}
			return result;
		};

		const selected = this.context.getSelectedElementIds();
		if (selected.length > 0) {
			const layerSet = new Set(layer.elementIds);
			const topLevel = selected.filter((id) => layerSet.has(id));
			return expandGroups(topLevel);
		}
		return expandGroups(layer.elementIds);
	}

	public onCancel(): void {
		this.currentStroke = null;
		this.currentPressures = null;
	}

	public getCursor(): string {
		return "none";
	}

	public getCurrentStroke(): Point[] | null {
		return this.currentStroke;
	}
}

/**
 * Convert eraser stroke points into PathSegment array (linear segments).
 */
function buildSegmentsFromStroke(
	stroke: Point[],
	pressures: number[],
): PathSegment[] {
	if (stroke.length < 2) return [];

	const segments: PathSegment[] = [];
	for (let i = 0; i < stroke.length - 1; i++) {
		const p0 = stroke[i];
		const p1 = stroke[i + 1];

		segments.push({
			start: i === 0 ? { x: p0.x, y: p0.y } : undefined,
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: p1.x, y: p1.y },
			startPressure: pressures[i] ?? 0.5,
			endPressure: pressures[i + 1] ?? 0.5,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: i * 16,
			endDeltaTime: (i + 1) * 16,
			isMoved: i === 0,
		});
	}

	return segments;
}

/**
 * Compute width adjustment for a path based on eraser stroke intersection.
 *
 * ## Algorithm
 *
 * **1. Hit testing:**
 * For each eraser point, project it onto the path polyline to find the closest
 * point. If the distance is within `hitRadius = eraserRadius + brushHalfSize`,
 * it's a hit. The cross product of the segment normal and the eraser vector
 * determines which side (side1 = left of travel, side2 = right) the eraser is on.
 *
 * **2. Geometric overlap reduction:**
 * Instead of linear distance interpolation, the reduction is computed from the
 * actual geometric overlap between the eraser circle and the stroke edges:
 *
 * ```
 *   nearEdge = closestDist - eraserRadius
 * ```
 *
 * - `nearEdge > 0`: eraser's closest edge is outside the path center.
 *   Remaining width on the closest side = `nearEdge / brushHalfSize`.
 * - `nearEdge <= 0`: eraser extends past center. Closest side is fully erased.
 *   Opposite side is also eroded by `(-nearEdge) / brushHalfSize`.
 *
 * **3. Guard-peak-guard bracketing:**
 * To prevent the reduction from bleeding along the path via interpolation,
 * each hit inserts 3 StrokeWidthPoints:
 *
 * ```
 *   [tLeft: guard] ---- [closestT: peak (reduced)] ---- [tRight: guard]
 * ```
 *
 * - Guard points preserve the interpolated original width at the boundaries.
 * - `tRadius = eraserRadius / pathLength` defines the influence zone in t-space.
 * - Existing CPs strictly between the guards are removed to avoid conflicts.
 */
function computeWidthAdjustment(
	path: Path,
	eraserStroke: Point[],
	eraserRadius: number,
	brushHalfSize: number,
): StrokeWidthPoint[] | null {
	// Flatten path segments into polyline for intersection testing
	const pathPoints = flattenPathToPolyline(path);
	if (pathPoints.length < 2) return null;

	// Convert eraser point array to a proper bezier path via processStroke,
	// then flatten it back to a uniform polyline. This smooths out jitter
	// and fills gaps between sparse input points from fast strokes.
	const eraserPoints = smoothEraserStroke(eraserStroke);

	const existing = path.strokeWidths ?? [];
	const newWidths: StrokeWidthPoint[] = [...existing];
	const totalSegs = pathPoints.length - 1;

	// Coarse hit radius for initial closest-point search (uses full brush width)
	const coarseHitRadius = eraserRadius + brushHalfSize;

	// Compute per-segment lengths and cumulative arc-lengths for arc-length parameterization
	const segLengths = new Float64Array(totalSegs);
	const cumulativeLengths = new Float64Array(pathPoints.length); // cumulativeLengths[0] = 0
	let totalLength = 0;
	for (let i = 0; i < totalSegs; i++) {
		const startsSubpath = pathPoints[i + 1].startsSubpath;
		const dx = startsSubpath ? 0 : pathPoints[i + 1].x - pathPoints[i].x;
		const dy = startsSubpath ? 0 : pathPoints[i + 1].y - pathPoints[i].y;
		const len = Math.sqrt(dx * dx + dy * dy);
		segLengths[i] = len;
		totalLength += len;
		cumulativeLengths[i + 1] = totalLength;
	}

	// Phase 1: Collect all hits from eraser segments against original widths.
	// A single eraser segment may hit multiple points on the path (e.g. at
	// self-intersections or U-shaped curves), so we collect ALL candidates
	// within coarseHitRadius and cluster them by t-distance.
	const tRadius = totalLength > 0 ? eraserRadius / totalLength : 0.05;
	const hits: Array<{ t: number; side1: number; side2: number }> = [];
	const eraserSegCount = eraserPoints.length - 1;

	for (let ei = 0; ei < Math.max(eraserSegCount, 1); ei++) {
		const hasEraserSeg = eraserSegCount > 0;
		const e0 = eraserPoints[ei];
		const e1 = hasEraserSeg ? eraserPoints[ei + 1] : e0;

		// Collect all path segments within coarse hit radius
		const candidates: Array<{
			segmentIndex: number;
			t: number;
			dist: number;
			side: 1 | 2;
		}> = [];

		for (let i = 0; i < totalSegs; i++) {
			if (pathPoints[i + 1].startsSubpath) continue;

			const ax = pathPoints[i].x;
			const ay = pathPoints[i].y;
			const bx = pathPoints[i + 1].x;
			const by = pathPoints[i + 1].y;

			const segDx = bx - ax;
			const segDy = by - ay;
			const segLenSq = segDx * segDx + segDy * segDy;
			if (segLenSq < 1e-20) continue;

			const { dist, projOnPath, closestOnPath } = hasEraserSeg
				? segmentToSegmentClosest(e0.x, e0.y, e1.x, e1.y, ax, ay, bx, by)
				: pointToSegmentClosest(e0.x, e0.y, ax, ay, bx, by);

			if (dist < coarseHitRadius) {
				const t =
					totalLength > 0
						? (cumulativeLengths[i] + projOnPath * segLengths[i]) / totalLength
						: 0;

				const segLen = Math.sqrt(segLenSq);
				const nx = -segDy / segLen;
				const ny = segDx / segLen;
				const toEraser =
					(closestOnPath.ex - closestOnPath.px) * nx +
					(closestOnPath.ey - closestOnPath.py) * ny;
				const side: 1 | 2 = toEraser >= 0 ? 1 : 2;

				candidates.push({ segmentIndex: i, t, dist, side });
			}
		}

		if (candidates.length === 0) continue;

		// Keep one closest point for each contiguous hit region. Comparing with
		// the previously visited segment prevents the cluster anchor from drifting
		// and splitting one straight overlap into multiple unrelated hits.
		candidates.sort((a, b) => a.t - b.t);
		const clustered: typeof candidates = [];
		let closest = candidates[0];
		let previous = candidates[0];
		for (let ci = 1; ci < candidates.length; ci++) {
			const curr = candidates[ci];
			if (curr.segmentIndex <= previous.segmentIndex + 1) {
				if (curr.dist < closest.dist) closest = curr;
			} else {
				clustered.push(closest);
				closest = curr;
			}
			previous = curr;
		}
		clustered.push(closest);

		// Compute width adjustment for each clustered hit
		for (const candidate of clustered) {
			const current = interpolateStrokeWidths(existing, candidate.t);
			const effectiveSideRatio =
				candidate.side === 1 ? current.side1 : current.side2;
			const effectiveHitRadius =
				eraserRadius + brushHalfSize * effectiveSideRatio;
			if (candidate.dist > effectiveHitRadius) continue;

			const nearEdge = candidate.dist - eraserRadius;

			const currentClosestRatio =
				candidate.side === 1 ? current.side1 : current.side2;
			const closestSideRatio =
				brushHalfSize > 0
					? Math.min(currentClosestRatio, nearEdge / brushHalfSize)
					: 0;

			hits.push({
				t: candidate.t,
				side1: candidate.side === 1 ? closestSideRatio : current.side1,
				side2: candidate.side === 2 ? closestSideRatio : current.side2,
			});
		}
	}

	if (hits.length === 0) return null;

	// Phase 2: Group hits into disjoint influence ranges.
	// Hits whose influence zones (t ± tRadius) overlap are merged into one range.
	// This prevents a single range from spanning unrelated path regions
	// (e.g. t=0.2 and t=0.8 at a self-intersection).
	hits.sort((a, b) => a.t - b.t);
	const margin = MERGE_T_THRESHOLD;

	type HitRange = {
		left: number;
		right: number;
		hits: Array<{ t: number; side1: number; side2: number }>;
	};
	const ranges: HitRange[] = [];
	let currentRange: HitRange = {
		left: Math.max(0, hits[0].t - tRadius),
		right: Math.min(1, hits[0].t + tRadius),
		hits: [hits[0]],
	};

	for (let hi = 1; hi < hits.length; hi++) {
		const hitLeft = hits[hi].t - tRadius;
		if (hitLeft <= currentRange.right + margin) {
			// Overlaps — extend current range
			currentRange.right = Math.min(1, hits[hi].t + tRadius);
			currentRange.hits.push(hits[hi]);
		} else {
			// Disjoint — finalize current range and start a new one
			ranges.push(currentRange);
			currentRange = {
				left: Math.max(0, hits[hi].t - tRadius),
				right: Math.min(1, hits[hi].t + tRadius),
				hits: [hits[hi]],
			};
		}
	}
	ranges.push(currentRange);

	// Apply each range independently
	for (const range of ranges) {
		// Remove existing CPs within this influence zone
		for (let i = newWidths.length - 1; i >= 0; i--) {
			const t = newWidths[i].t;
			if (t >= range.left && t <= range.right) {
				newWidths.splice(i, 1);
			}
		}

		const hasLeftHit = range.hits.some(
			({ t }) => Math.abs(t - range.left) < MERGE_T_THRESHOLD,
		);
		const hasRightHit = range.hits.some(
			({ t }) => Math.abs(t - range.right) < MERGE_T_THRESHOLD,
		);
		if (!hasLeftHit) {
			newWidths.push({
				t: range.left,
				...interpolateStrokeWidths(existing, range.left),
			});
		}

		newWidths.push(
			...simplifyStrokeWidths(
				range.hits
					.filter(({ t }) => t >= range.left && t <= range.right)
					.map(({ t, side1, side2 }) => ({ t, side1, side2 })),
			),
		);

		if (!hasRightHit) {
			newWidths.push({
				t: range.right,
				...interpolateStrokeWidths(existing, range.right),
			});
		}
	}

	newWidths.sort((a, b) => a.t - b.t);
	return newWidths;
}

function findNegativeWidthRanges(
	strokeWidths: StrokeWidthPoint[],
): Array<{ start: number; end: number }> {
	const points = [
		{ t: 0, ...interpolateStrokeWidths(strokeWidths, 0) },
		...strokeWidths.filter(({ t }) => t > 0 && t < 1),
		{ t: 1, ...interpolateStrokeWidths(strokeWidths, 1) },
	].toSorted((a, b) => a.t - b.t);
	const ranges: Array<{ start: number; end: number }> = [];
	let rangeStart: number | null =
		points[0].side1 + points[0].side2 < 0 ? points[0].t : null;

	for (let i = 1; i < points.length; i++) {
		const previous = points[i - 1];
		const current = points[i];
		const previousSum = previous.side1 + previous.side2;
		const currentSum = current.side1 + current.side2;

		if (previousSum >= 0 && currentSum < 0) {
			rangeStart = interpolateZeroCrossing(
				previous.t,
				current.t,
				previousSum,
				currentSum,
			);
		} else if (previousSum < 0 && currentSum >= 0 && rangeStart != null) {
			ranges.push({
				start: rangeStart,
				end: interpolateZeroCrossing(
					previous.t,
					current.t,
					previousSum,
					currentSum,
				),
			});
			rangeStart = null;
		}
	}

	if (rangeStart != null) {
		ranges.push({ start: rangeStart, end: 1 });
	}

	return ranges;
}

function interpolateZeroCrossing(
	startT: number,
	endT: number,
	startValue: number,
	endValue: number,
): number {
	const span = endValue - startValue;
	if (span === 0) return startT;
	return startT + (-startValue * (endT - startT)) / span;
}

function sliceStrokeWidths(
	strokeWidths: StrokeWidthPoint[] | undefined,
	pathStart: number,
	pathEnd: number,
): StrokeWidthPoint[] | undefined {
	if (!strokeWidths?.length) return undefined;

	const pathSpan = pathEnd - pathStart;
	if (pathSpan <= 0) return undefined;

	const startWidth = interpolateStrokeWidths(strokeWidths, pathStart);
	const endWidth = interpolateStrokeWidths(strokeWidths, pathEnd);

	return [
		{ t: 0, ...startWidth },
		...strokeWidths
			.filter(({ t }) => t > pathStart && t < pathEnd)
			.map(({ t, side1, side2 }) => ({
				t: (t - pathStart) / pathSpan,
				side1,
				side2,
			})),
		{ t: 1, ...endWidth },
	];
}

const MERGE_T_THRESHOLD = 0.005;
const SIMPLIFY_TOLERANCE = 0.02;

/** Merge points with near-identical t values (keep smaller widths), then
 *  remove redundant interior points that can be linearly interpolated. */
function simplifyStrokeWidths(widths: StrokeWidthPoint[]): StrokeWidthPoint[] {
	if (widths.length <= 1) return widths;

	// 1. Merge close t values — keep per-side minimum (most erased)
	const merged: StrokeWidthPoint[] = [widths[0]];
	for (let i = 1; i < widths.length; i++) {
		const prev = merged[merged.length - 1];
		if (widths[i].t - prev.t < MERGE_T_THRESHOLD) {
			merged[merged.length - 1] = {
				t: prev.t,
				side1: Math.min(prev.side1, widths[i].side1),
				side2: Math.min(prev.side2, widths[i].side2),
			};
		} else {
			merged.push(widths[i]);
		}
	}

	if (merged.length <= 2) return merged;

	// 2. Remove interior points that are redundant (linearly interpolatable)
	const result: StrokeWidthPoint[] = [merged[0]];
	for (let i = 1; i < merged.length - 1; i++) {
		const prev = result[result.length - 1];
		const curr = merged[i];
		const next = merged[i + 1];

		const range = next.t - prev.t;
		if (range <= 0) continue;

		const frac = (curr.t - prev.t) / range;
		const interpSide1 = prev.side1 + (next.side1 - prev.side1) * frac;
		const interpSide2 = prev.side2 + (next.side2 - prev.side2) * frac;

		if (
			Math.abs(curr.side1 - interpSide1) > SIMPLIFY_TOLERANCE ||
			Math.abs(curr.side2 - interpSide2) > SIMPLIFY_TOLERANCE
		) {
			result.push(curr);
		}
	}
	result.push(merged[merged.length - 1]);

	return result;
}

/** Extract brush half-size from a path's stroke appearance filter. */
function getBrushHalfSize(path: Path): number {
	const strokeFilter = path.filters?.find((f) => f.processor === "stroke") as
		| StrokeAppearance
		| undefined;
	const size = strokeFilter?.paramData.params.brushSettings?.size ?? 2;
	return size / 2;
}

function flattenPathToPolyline(path: Path): PathPolylinePoint[] {
	const points: PathPolylinePoint[] = [];
	let prevX = 0;
	let prevY = 0;

	for (const seg of path.segments) {
		const sx = seg.start ? seg.start.x : prevX;
		const sy = seg.start ? seg.start.y : prevY;
		if (points.length === 0 || seg.start) {
			points.push({ x: sx, y: sy, startsSubpath: true });
		}

		// Sample cubic bezier
		const c1x = sx + seg.cp1.x;
		const c1y = sy + seg.cp1.y;
		const c2x = seg.end.x + seg.cp2.x;
		const c2y = seg.end.y + seg.cp2.y;
		const ex = seg.end.x;
		const ey = seg.end.y;

		const steps = 10;
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const t1 = 1 - t;
			const x =
				t1 * t1 * t1 * sx +
				3 * t1 * t1 * t * c1x +
				3 * t1 * t * t * c2x +
				t * t * t * ex;
			const y =
				t1 * t1 * t1 * sy +
				3 * t1 * t1 * t * c1y +
				3 * t1 * t * t * c2y +
				t * t * t * ey;
			points.push({ x, y, startsSubpath: false });
		}

		prevX = ex;
		prevY = ey;
	}

	return points;
}

const ERASER_SMOOTH_VIEWPORT: Viewport = {
	x: 0,
	y: 0,
	zoom: 1,
	rotation: 0,
};

/** Convert raw eraser point array to a smoothed bezier path, then flatten
 *  back to a uniform polyline. Falls back to the original points if
 *  processStroke produces nothing (e.g. fewer than 2 input points). */
function smoothEraserStroke(raw: Point[]): Point[] {
	if (raw.length < 3) return raw;

	const bezierPoints = raw.map((p) => ({
		x: p.x,
		y: p.y,
		pressure: 0.5,
		tiltX: 0,
		tiltY: 0,
		deltaTime: 0,
	}));
	const segments = processStroke(bezierPoints, 0.3, ERASER_SMOOTH_VIEWPORT);
	if (segments.length === 0) return raw;

	// Flatten bezier segments into uniform polyline
	const result: Point[] = [];
	let prevX = 0;
	let prevY = 0;

	for (const seg of segments) {
		const sx = seg.start ? seg.start.x : prevX;
		const sy = seg.start ? seg.start.y : prevY;
		if (result.length === 0 || seg.start) {
			result.push({ x: sx, y: sy });
		}

		const c1x = sx + seg.cp1.x;
		const c1y = sy + seg.cp1.y;
		const c2x = seg.end.x + seg.cp2.x;
		const c2y = seg.end.y + seg.cp2.y;
		const ex = seg.end.x;
		const ey = seg.end.y;

		const steps = 10;
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const t1 = 1 - t;
			result.push({
				x:
					t1 * t1 * t1 * sx +
					3 * t1 * t1 * t * c1x +
					3 * t1 * t * t * c2x +
					t * t * t * ex,
				y:
					t1 * t1 * t1 * sy +
					3 * t1 * t1 * t * c1y +
					3 * t1 * t * t * c2y +
					t * t * t * ey,
			});
		}

		prevX = ex;
		prevY = ey;
	}

	return result.length >= 2 ? result : raw;
}

/** Point-to-segment closest point. Returns distance, projection t on segment, and closest points. */
function pointToSegmentClosest(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): {
	dist: number;
	projOnPath: number;
	closestOnPath: { px: number; py: number; ex: number; ey: number };
} {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
	return {
		dist,
		projOnPath: t,
		closestOnPath: { px: cx, py: cy, ex: px, ey: py },
	};
}

/** Segment-to-segment closest distance. Returns min distance, projection on path segment, and closest point pair. */
function segmentToSegmentClosest(
	e0x: number,
	e0y: number,
	e1x: number,
	e1y: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): {
	dist: number;
	projOnPath: number;
	closestOnPath: { px: number; py: number; ex: number; ey: number };
} {
	// Sample eraser segment at multiple points and keep the closest
	const samples = Math.max(
		2,
		Math.ceil(
			Math.sqrt((e1x - e0x) ** 2 + (e1y - e0y) ** 2) /
				Math.max(Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2), 1),
		) + 1,
	);

	let bestDist = Number.POSITIVE_INFINITY;
	let bestProj = 0;
	let bestOnPath = { px: ax, py: ay, ex: e0x, ey: e0y };

	for (let s = 0; s < samples; s++) {
		const u = s / (samples - 1);
		const epx = e0x + u * (e1x - e0x);
		const epy = e0y + u * (e1y - e0y);
		const r = pointToSegmentClosest(epx, epy, ax, ay, bx, by);
		if (r.dist < bestDist) {
			bestDist = r.dist;
			bestProj = r.projOnPath;
			bestOnPath = r.closestOnPath;
		}
	}

	// Also check path endpoints projected onto eraser segment
	for (const [px, py] of [
		[ax, ay],
		[bx, by],
	] as const) {
		const edx = e1x - e0x;
		const edy = e1y - e0y;
		const eLenSq = edx * edx + edy * edy;
		if (eLenSq < 1e-20) continue;
		let u = ((px - e0x) * edx + (py - e0y) * edy) / eLenSq;
		u = Math.max(0, Math.min(1, u));
		const epx = e0x + u * edx;
		const epy = e0y + u * edy;
		const dist = Math.sqrt((px - epx) ** 2 + (py - epy) ** 2);
		if (dist < bestDist) {
			bestDist = dist;
			// Compute projOnPath for this path point
			const pdx = bx - ax;
			const pdy = by - ay;
			const pLenSq = pdx * pdx + pdy * pdy;
			bestProj =
				pLenSq > 0
					? Math.max(
							0,
							Math.min(1, ((px - ax) * pdx + (py - ay) * pdy) / pLenSq),
						)
					: 0;
			bestOnPath = { px, py, ex: epx, ey: epy };
		}
	}

	return { dist: bestDist, projOnPath: bestProj, closestOnPath: bestOnPath };
}

/**
 * Resolve full world transform (ancestor chain + own transform).
 * Returns composed transform for converting between world and local space.
 */
function resolveComposedTransform(
	context: ToolContext,
	elementId: string,
	element: { transform: ElementTransform },
): ElementTransform {
	const ancestorT = context.getAncestorTransform(elementId);
	return ancestorT
		? composeTransforms(ancestorT, element.transform)
		: element.transform;
}

/**
 * Convert world-space points to element's local space using full transform chain.
 * Returns the original points if composedT is identity (no allocation).
 */
function worldToLocalFull(
	points: Point[],
	composedT: ElementTransform,
	origin: Point,
): Point[] {
	if (isIdentityTransform(composedT)) return points;
	return points.map((p) =>
		inverseTransform(p.x, p.y, composedT, origin.x, origin.y),
	);
}

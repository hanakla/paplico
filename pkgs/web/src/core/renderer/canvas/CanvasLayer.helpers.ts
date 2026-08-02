import {
	createIdentityTransform,
	createStrokeBrushSettings,
} from "../../document/factory";
import {
	type AnyArtObject,
	type BoundingBox,
	type CompoundPath,
	type CubicBezierSegment,
	type FillAppearance,
	type FillColor,
	type Filter,
	getContainerChildIds,
	type Path,
	type StrokeAppearance,
	type Viewport,
} from "../../schema";
import { getStrokeWidth } from "../../utils/elementQuery";
import type { PipelineType } from "./CanvasLayerTypes";

const STENCIL_MASK_FILL: FillColor = {
	type: "solid",
	color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
};

/** Axis-aligned bounding box of a 4-corner quad (world space). */
export function aabbOfQuad(
	quad: readonly [
		{ x: number; y: number },
		{ x: number; y: number },
		{ x: number; y: number },
		{ x: number; y: number },
	],
): BoundingBox {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const c of quad) {
		minX = Math.min(minX, c.x);
		minY = Math.min(minY, c.y);
		maxX = Math.max(maxX, c.x);
		maxY = Math.max(maxY, c.y);
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function calculatePrebufDimensions({
	viewport,
	visibleBounds,
	canvasWidth,
	canvasHeight,
	maxTextureDimension,
}: {
	viewport: Viewport;
	visibleBounds: Pick<BoundingBox, "width" | "height"> | null;
	canvasWidth: number;
	canvasHeight: number;
	maxTextureDimension: number;
}): {
	prebufWidth: number;
	prebufHeight: number;
	prebufZoom: number;
} {
	const requestedWorldWidth =
		visibleBounds?.width ?? canvasWidth / viewport.zoom;
	const requestedWorldHeight =
		visibleBounds?.height ?? canvasHeight / viewport.zoom;
	const zoomLimitFromWidth =
		requestedWorldWidth > 0
			? maxTextureDimension / requestedWorldWidth
			: viewport.zoom;
	const zoomLimitFromHeight =
		requestedWorldHeight > 0
			? maxTextureDimension / requestedWorldHeight
			: viewport.zoom;
	const prebufZoom = Math.max(
		Number.EPSILON,
		Math.min(viewport.zoom, zoomLimitFromWidth, zoomLimitFromHeight),
	);

	return {
		prebufWidth: Math.max(1, Math.ceil(requestedWorldWidth * prebufZoom)),
		prebufHeight: Math.max(1, Math.ceil(requestedWorldHeight * prebufZoom)),
		prebufZoom,
	};
}

/**
 * Cap an interactive filter bake's density (texels per world px) to the
 * power-of-two bucket at or above the viewport zoom, so a zoomed-out viewport
 * does not rasterize filters far denser than the screen can show. The bucket
 * is quantized because downstream caches key on the resulting density and
 * would miss on every frame of a continuous zoom.
 *
 * Invariants: result <= rasterZoom, and result >= min(rasterZoom, viewportZoom)
 * so a raised rasterizationDpi still sharpens zoomed-in views.
 */
export function capFilterBakeDensity(
	rasterZoom: number,
	viewportZoom: number,
): number {
	if (!Number.isFinite(viewportZoom) || viewportZoom <= 0) return rasterZoom;
	const bucket = 2 ** Math.ceil(Math.log2(viewportZoom));
	return Math.min(rasterZoom, Math.max(bucket, viewportZoom));
}

/**
 * Screen-space phase (top-left origin, physical px) that anchors a constant-
 * spacing dot lattice to the world origin. Using this as the lattice phase makes
 * the dots pan with the canvas while keeping their on-screen spacing fixed
 * regardless of zoom (zoom only changes how many dots are visible, never their
 * screen position — so they never crawl).
 */
export function computeDotGridPhase(
	targetWidth: number,
	targetHeight: number,
	viewport: Viewport,
): { phaseX: number; phaseY: number } {
	const cos = Math.cos(viewport.rotation);
	const sin = Math.sin(viewport.rotation);
	const ex = -viewport.x * viewport.zoom;
	const ey = -viewport.y * viewport.zoom;
	return {
		phaseX: targetWidth / 2 + (ex * cos + ey * sin),
		phaseY: targetHeight / 2 - (-ex * sin + ey * cos),
	};
}

/**
 * Expand a set of top-level target element IDs into the full set of IDs in
 * their render subtrees: container children (group/compound-path/blend),
 * object-mask sources, group/text clip paths, and a text's axis-bound path.
 *
 * Export/copy renders receive only the top-level selection as `elementFilter`.
 * Pre-passes that walk the whole elementsMap (glass-solid bake, clip/object
 * masks, per-element filter plans) must be restricted to this expanded set so
 * they keep a selected group's descendants while excluding front siblings.
 * Mirrors the clipboard closure in PaplicoCommands.collectElementsByIds, but on
 * live document objects. Pure: reads only the passed objects, allocates nothing
 * shared. Dangling references are skipped like the atlas collectors do.
 */
export function expandRenderFilter(
	topLevel: ReadonlySet<string>,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Set<string> {
	const result = new Set<string>();
	const stack: string[] = [...topLevel];
	for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
		if (result.has(id)) continue;
		const el = elementsMap.get(id);
		if (!el) continue;
		result.add(id);

		// Container children (group childIds / compound-path sources / blend
		// objectIds + spineSourceId) — SSoT via schema.
		for (const childId of getContainerChildIds(el) ?? []) stack.push(childId);

		// Object-mask sources (any element type carries ArtObject.mask).
		if (el.mask) for (const mid of el.mask.elementIds) stack.push(mid);

		// clipPathId / axisBinding are references, not container children, so
		// getContainerChildIds does not include them — pull them in explicitly.
		if (el.type === "group" && el.clipPathId) stack.push(el.clipPathId);
		if (el.type === "text") {
			if (el.clipPathId) stack.push(el.clipPathId);
			if (el.axisBinding) stack.push(el.axisBinding.pathObjectId);
		}
	}
	return result;
}

export function createCompoundPathRenderPath(
	compoundPath: CompoundPath,
	segments: CubicBezierSegment[],
	baseSourcePath: Path | undefined,
	_pipelineType: PipelineType,
	isMaskRender = false,
): Path {
	const cpFill = (
		compoundPath.filters?.find(
			(f) => f.processor === "fill" && f.enabled !== false,
		) as FillAppearance | undefined
	)?.paramData.params.fill;
	const cpStroke = compoundPath.filters?.find(
		(f) => f.processor === "stroke" && f.enabled !== false,
	) as StrokeAppearance | undefined;
	const baseStroke = baseSourcePath?.filters?.find(
		(f) => f.processor === "stroke" && f.enabled !== false,
	) as StrokeAppearance | undefined;

	const brushSettings =
		cpStroke?.paramData.params.brushSettings ??
		baseStroke?.paramData.params.brushSettings ??
		createStrokeBrushSettings(getStrokeWidth(compoundPath.filters));

	const strokeColor = isMaskRender
		? undefined
		: (cpStroke?.paramData.params.strokeColor ?? {
				type: "solid" as const,
				color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
			});
	const fill = isMaskRender ? (cpFill ?? STENCIL_MASK_FILL) : cpFill;

	const filters: Filter[] = [];
	if (strokeColor) {
		filters.push({
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: { strokeColor, brushSettings },
			},
		} as StrokeAppearance);
	}
	if (fill) {
		filters.push({
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill } },
		} as FillAppearance);
	}

	return {
		type: "path",
		id: `${compoundPath.id}-render`,
		opacity: compoundPath.opacity,
		blendMode: compoundPath.blendMode,
		segments,
		filters,
		transform: createIdentityTransform(),
	};
}

/**
 * Remove duplicate/near-adjacent points from a flat [x,y,...] polygon array
 * and strip the closing point if it matches the first.
 */
export function cleanupPolygonPoints(points: number[]): number[] {
	if (points.length < 4) return points;

	const EPSILON = 0.001; // 近い点を同一とみなす閾値
	const result: number[] = [];
	let lastX: number | null = null;
	let lastY: number | null = null;

	// Remove duplicate/near adjacent points
	for (let i = 0; i < points.length / 2; i++) {
		const x = points[i * 2];
		const y = points[i * 2 + 1];
		if (
			lastX === null ||
			lastY === null ||
			Math.abs(x - lastX) > EPSILON ||
			Math.abs(y - lastY) > EPSILON
		) {
			result.push(x, y);
			lastX = x;
			lastY = y;
		}
	}

	// Remove closing point if first ~= last
	const n = result.length / 2;
	if (
		n >= 2 &&
		Math.abs(result[0] - result[(n - 1) * 2]) < EPSILON &&
		Math.abs(result[1] - result[(n - 1) * 2 + 1]) < EPSILON
	) {
		result.pop();
		result.pop();
	}

	return result;
}

/**
 * Split bezier segments into sub-paths at `isMoved` boundaries.
 */
export function splitIntoSubPaths(
	segments: CubicBezierSegment[],
): CubicBezierSegment[][] {
	if (segments.length === 0) return [];

	const subPaths: CubicBezierSegment[][] = [];
	let currentSubPath: CubicBezierSegment[] = [];

	for (const segment of segments) {
		// isMovedがtrueなら新しいサブパスを開始
		if (segment.isMoved && currentSubPath.length > 0) {
			subPaths.push(currentSubPath);
			currentSubPath = [];
		}
		currentSubPath.push(segment);
	}

	// 最後のサブパスを追加
	if (currentSubPath.length > 0) {
		subPaths.push(currentSubPath);
	}

	return subPaths;
}

/**
 * Compute signed area of a polygon (shoelace formula).
 * Positive = counter-clockwise, Negative = clockwise.
 */
function computeSignedArea(points: number[]): number {
	let area = 0;
	const n = points.length / 2;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const x1 = points[i * 2];
		const y1 = points[i * 2 + 1];
		const x2 = points[j * 2];
		const y2 = points[j * 2 + 1];
		area += x1 * y2 - x2 * y1;
	}
	return area / 2;
}

/**
 * Compute bounding box of a flat [x,y,...] polygon.
 */
function computePolygonBounds(points: number[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (let i = 0; i < points.length; i += 2) {
		const x = points[i],
			y = points[i + 1];
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

/**
 * Check if bounds A fully contains bounds B.
 */
function boundsContain(
	a: { minX: number; minY: number; maxX: number; maxY: number },
	b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
	return (
		a.minX <= b.minX && a.maxX >= b.maxX && a.minY <= b.minY && a.maxY >= b.maxY
	);
}

/**
 * Point-in-polygon test using ray casting.
 */
function pointInPolygon(x: number, y: number, polygon: number[]): boolean {
	let inside = false;
	const n = polygon.length / 2;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = polygon[i * 2],
			yi = polygon[i * 2 + 1];
		const xj = polygon[j * 2],
			yj = polygon[j * 2 + 1];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * Group sub-paths into outer contours + holes using containment analysis.
 */
export function groupSubPathsByContainment(
	subPaths: number[][],
): Array<{ outer: number[]; holes: number[][] }> {
	if (subPaths.length === 0) return [];
	if (subPaths.length === 1) return [{ outer: subPaths[0], holes: [] }];

	type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
	type Probe = { x: number; y: number };
	type Meta = {
		index: number;
		points: number[];
		bounds: Bounds;
		sign: -1 | 1;
		absArea: number;
		probe: Probe;
		parent: number | null;
		depth: number;
	};

	const metas: Meta[] = subPaths.map((points, index) => {
		const bounds = computePolygonBounds(points);
		const area = computeSignedArea(points);
		return {
			index,
			points,
			bounds,
			sign: area < 0 ? -1 : 1,
			absArea: Math.abs(area),
			probe: pickContainmentProbePoint(points, bounds),
			parent: null,
			depth: 0,
		};
	});

	for (let i = 0; i < metas.length; i++) {
		let parent: number | null = null;
		for (let j = 0; j < metas.length; j++) {
			if (i === j) continue;
			if (!containsSubPath(metas[j], metas[i])) continue;
			if (parent == null || metas[j].absArea < metas[parent].absArea) {
				parent = j;
			}
		}
		metas[i].parent = parent;
	}

	const uniqueSigns = new Set(metas.map((meta) => meta.sign));
	if (uniqueSigns.size <= 1) {
		return [...metas]
			.sort((a, b) => a.index - b.index)
			.map((meta) => ({ outer: meta.points, holes: [] }));
	}

	for (const meta of metas) {
		meta.depth = computeDepth(meta.index, metas);
	}

	const groupsByIndex = new Map<
		number,
		{ outer: number[]; holes: number[][] }
	>();
	const outerMetas = metas.filter((meta) => meta.depth % 2 === 0);
	for (const outer of outerMetas) {
		groupsByIndex.set(outer.index, { outer: outer.points, holes: [] });
	}

	for (const meta of metas) {
		if (meta.depth % 2 === 0) continue;
		const owner = findOwningOuter(meta, metas, groupsByIndex, outerMetas);
		if (owner) {
			groupsByIndex.get(owner.index)?.holes.push(meta.points);
			continue;
		}
		groupsByIndex.set(meta.index, { outer: meta.points, holes: [] });
	}

	return [...groupsByIndex.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, group]) => group);
}

function containsSubPath(
	outer: {
		bounds: { minX: number; minY: number; maxX: number; maxY: number };
		points: number[];
	},
	inner: {
		bounds: { minX: number; minY: number; maxX: number; maxY: number };
		probe: { x: number; y: number };
	},
): boolean {
	if (!boundsContain(outer.bounds, inner.bounds)) return false;
	return pointInPolygon(inner.probe.x, inner.probe.y, outer.points);
}

function computeDepth(
	index: number,
	metas: Array<{ parent: number | null }>,
): number {
	let depth = 0;
	let cursor = metas[index]?.parent ?? null;
	let guard = 0;
	while (cursor != null && guard < metas.length) {
		depth++;
		cursor = metas[cursor]?.parent ?? null;
		guard++;
	}
	return depth;
}

function pickContainmentProbePoint(
	points: number[],
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
): { x: number; y: number } {
	const count = points.length / 2;
	if (count === 0) return { x: 0, y: 0 };

	let sumX = 0;
	let sumY = 0;
	for (let i = 0; i < points.length; i += 2) {
		sumX += points[i];
		sumY += points[i + 1];
	}

	const centroid = { x: sumX / count, y: sumY / count };
	if (pointInPolygon(centroid.x, centroid.y, points)) return centroid;

	const center = {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
	};
	if (pointInPolygon(center.x, center.y, points)) return center;

	for (let i = 0; i < points.length; i += 2) {
		const next = (i + 2) % points.length;
		const midX = (points[i] + points[next]) / 2;
		const midY = (points[i + 1] + points[next + 1]) / 2;
		if (pointInPolygon(midX, midY, points)) {
			return { x: midX, y: midY };
		}
	}

	const p0 = { x: points[0], y: points[1] };
	const towardCenterX = center.x - p0.x;
	const towardCenterY = center.y - p0.y;
	const len = Math.hypot(towardCenterX, towardCenterY);
	if (len > 0) {
		const nudged = {
			x: p0.x + (towardCenterX / len) * 0.001,
			y: p0.y + (towardCenterY / len) * 0.001,
		};
		if (pointInPolygon(nudged.x, nudged.y, points)) return nudged;
	}

	return p0;
}

/**
 * Split a group's filters into appearances before and after ContentAppearance.
 * Used to determine when group-level fill/stroke renders relative to children.
 * If no ContentAppearance exists (legacy groups), all appearances go to `after`.
 */
export function splitGroupAppearances(filters: Filter[] | undefined): {
	before: Filter[];
	after: Filter[];
} {
	if (!filters) return { before: [], after: [] };

	const contentIndex = filters.findIndex(
		(f) => f.processor === "content" && f.enabled !== false,
	);

	const isAppearance = (f: Filter) =>
		(f.processor === "fill" || f.processor === "stroke") && f.enabled !== false;

	if (contentIndex === -1) {
		// No ContentAppearance — all appearances render after children
		return { before: [], after: filters.filter(isAppearance) };
	}

	return {
		before: filters.slice(0, contentIndex).filter(isAppearance),
		after: filters.slice(contentIndex + 1).filter(isAppearance),
	};
}

function findOwningOuter(
	meta: {
		index: number;
		parent: number | null;
		absArea: number;
		points: number[];
		bounds: { minX: number; minY: number; maxX: number; maxY: number };
		probe: { x: number; y: number };
	},
	metas: Array<{
		index: number;
		parent: number | null;
		depth: number;
		absArea: number;
		points: number[];
		bounds: { minX: number; minY: number; maxX: number; maxY: number };
		probe: { x: number; y: number };
	}>,
	groupsByIndex: Map<number, { outer: number[]; holes: number[][] }>,
	outerMetas: Array<{
		index: number;
		absArea: number;
		points: number[];
		bounds: { minX: number; minY: number; maxX: number; maxY: number };
		probe: { x: number; y: number };
	}>,
): {
	index: number;
	absArea: number;
	points: number[];
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
	probe: { x: number; y: number };
} | null {
	let cursor = meta.parent;
	let guard = 0;
	while (cursor != null && guard < metas.length) {
		const candidate = metas[cursor];
		if (
			candidate &&
			candidate.depth % 2 === 0 &&
			groupsByIndex.has(candidate.index)
		) {
			return candidate;
		}
		cursor = candidate?.parent ?? null;
		guard++;
	}

	let owner: (typeof outerMetas)[number] | null = null;
	for (const outer of outerMetas) {
		if (outer.index === meta.index) continue;
		if (!containsSubPath(outer, meta)) continue;
		if (owner == null || outer.absArea < owner.absArea) {
			owner = outer;
		}
	}
	return owner;
}

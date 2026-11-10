import {
	type AnyArtObject,
	type BoundingBox,
	type Filter,
	getContainerChildIds,
	isGroup,
	type Viewport,
} from "../../schema";
import { computePolylineSignedArea } from "../../utils/geometry/measure/area";
import {
	boundsContain,
	translateBounds,
} from "../../utils/geometry/primitives/box";

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

/** Pan margin baked around the viewport on store-eligible frames when the
 *  host passes none, in CSS px per side. A pan stays a cache blit until it
 *  exits the margin, which then costs one oversized re-render that re-centers
 *  the store. The size follows Inkscape's store padding, for pans of about
 *  16 px per frame. */
export const DEFAULT_PAN_MARGIN_PX = 256;

/** Store dimensions quantum (device px). Margined prebuf sizes are rounded up
 *  to this so continuous zoom does not re-allocate the five prebuf-sized
 *  textures every frame (DocumentCache ensure* compare sizes exactly). */
export const STORE_DIM_QUANTUM = 128;

export function calculatePrebufDimensions({
	viewport,
	visibleBounds,
	canvasWidth,
	canvasHeight,
	maxTextureDimension,
	zoomOverride,
	marginPx = 0,
}: {
	viewport: Viewport;
	visibleBounds: Pick<BoundingBox, "width" | "height"> | null;
	canvasWidth: number;
	canvasHeight: number;
	maxTextureDimension: number;
	/** Render density decoupled from the viewport (pixel preview renders at the
	 *  document's rasterization scale). World coverage still follows the
	 *  viewport; the maxTextureDimension clamp applies as usual. */
	zoomOverride?: number;
	/** Extra device px per side for the pan-blit store. 0 keeps the exact
	 *  pre-store sizing (exports and pixel preview depend on it). */
	marginPx?: number;
}): {
	prebufWidth: number;
	prebufHeight: number;
	prebufZoom: number;
} {
	const requestedZoom = zoomOverride ?? viewport.zoom;
	const requestedWorldWidth =
		visibleBounds?.width ?? canvasWidth / viewport.zoom;
	const requestedWorldHeight =
		visibleBounds?.height ?? canvasHeight / viewport.zoom;
	const zoomLimitFromWidth =
		requestedWorldWidth > 0
			? maxTextureDimension / requestedWorldWidth
			: requestedZoom;
	const zoomLimitFromHeight =
		requestedWorldHeight > 0
			? maxTextureDimension / requestedWorldHeight
			: requestedZoom;
	const prebufZoom = Math.max(
		Number.EPSILON,
		Math.min(requestedZoom, zoomLimitFromWidth, zoomLimitFromHeight),
	);

	return {
		prebufWidth: applyStoreMargin(
			Math.max(1, Math.ceil(requestedWorldWidth * prebufZoom)),
			marginPx,
			maxTextureDimension,
		),
		prebufHeight: applyStoreMargin(
			Math.max(1, Math.ceil(requestedWorldHeight * prebufZoom)),
			marginPx,
			maxTextureDimension,
		),
		prebufZoom,
	};
}

/**
 * Shift `bounds` by the sub-pixel amount that puts the texel grid of a store
 * covering `storeBounds` onto whole pixels of a `width` × `height` canvas
 * viewing `viewport` unrotated at the store's density, following
 * worldToScreen. A blit through the shifted bounds copies each texel onto
 * one pixel exactly; the content moves by at most half a pixel.
 */
export function alignToCanvasPixels(
	bounds: BoundingBox,
	storeBounds: BoundingBox,
	viewport: Viewport,
	width: number,
	height: number,
): BoundingBox {
	const { zoom } = viewport;
	const sx = width / 2 + (storeBounds.minX - viewport.x) * zoom;
	const sy = height / 2 + (viewport.y - storeBounds.maxY) * zoom;
	return translateBounds(
		bounds,
		(Math.round(sx) - sx) / zoom,
		(sy - Math.round(sy)) / zoom,
	);
}

/**
 * Ids whose edit changes pixels OUTSIDE the element's own bounds because
 * another element derives its render from them: mask/clip/axis references and
 * the children of derived containers (compound path booleans, blends, mesh
 * warps — a source edit reshapes the container anywhere). Plain group children
 * are excluded: a group composes children in place, so a child edit stays
 * inside the child's own region. The partial-redraw path cannot bound these
 * effects and falls back to a full render.
 */
export function collectExternallyReferencedIds(
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Set<string> {
	const referenced = new Set<string>();
	for (const el of elementsMap.values()) {
		if (el.type !== "group") {
			for (const childId of getContainerChildIds(el) ?? []) {
				referenced.add(childId);
			}
		}
		if (el.mask) for (const mid of el.mask.elementIds) referenced.add(mid);
		if ((el.type === "group" || el.type === "text") && el.clipPathId) {
			referenced.add(el.clipPathId);
		}
		if (el.type === "text" && el.axisBinding) {
			referenced.add(el.axisBinding.pathObjectId);
		}
	}
	return referenced;
}

/** Union of two world-space boxes (width/height kept consistent). */
export function unionBoundingBoxes(
	a: BoundingBox | null,
	b: BoundingBox | null,
): BoundingBox | null {
	if (!a) return b;
	if (!b) return a;
	const minX = Math.min(a.minX, b.minX);
	const minY = Math.min(a.minY, b.minY);
	const maxX = Math.max(a.maxX, b.maxX);
	const maxY = Math.max(a.maxY, b.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Convert a getVisibleWorldBounds result into the BoundingBox shape used by
 *  culling and the composite-frame cache. */
export function visibleBoundsToBox(v: {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
}): BoundingBox {
	return {
		minX: v.left,
		minY: v.bottom,
		maxX: v.right,
		maxY: v.top,
		width: v.width,
		height: v.height,
	};
}

function applyStoreMargin(
	base: number,
	marginPx: number,
	maxTextureDimension: number,
): number {
	if (marginPx <= 0) return base;
	const padded = base + marginPx * 2;
	return Math.min(
		maxTextureDimension,
		Math.ceil(padded / STORE_DIM_QUANTUM) * STORE_DIM_QUANTUM,
	);
}

/**
 * Texel budget for one interactive filter bake. Every filter of a chain runs
 * a fullscreen pass over the bake, so this bounds the per-frame cost of a
 * long chain at any zoom.
 */
const INTERACTIVE_BAKE_TEXEL_BUDGET = 16 * 1024 * 1024;

/**
 * How far past a density bucket the viewport zoom goes before live bakes use
 * the next one. Right past the boundary the next density holds more texels
 * for almost no gain in sharpness, and a two-finger pan wobbles the zoom
 * across a boundary it sits on.
 */
const BAKE_BUCKET_ZOOM_TOLERANCE = 1.125;

/**
 * Density buckets of a live bake per doubling of the zoom. With one, a zoom
 * right past a power of two bakes at twice the density the display shows,
 * four times the texels in every texture of the filter chain.
 */
const LIVE_BAKE_BUCKETS_PER_OCTAVE = 2;

/** Side (texels) of the grid a cropped filter bake is cut on. A pan has to
 *  cross a tile before the crop changes, so the kept bake is not re-baked on
 *  every pan frame. */
const CROPPED_BAKE_TILE_TEXELS = 512;

/** Texels added to a chain's reach for the bilinear taps at its edge. */
const CROPPED_BAKE_PAD_TEXELS = 2;

/** Whether an element composites with plain source-over, so its content can
 *  draw straight onto the target instead of through a bake. */
export function hasNormalBlending(element: AnyArtObject): boolean {
	return (
		(element.blendMode ?? "normal") === "normal" &&
		(element.compositionMode ?? "normal") === "normal"
	);
}

/**
 * Interactive bake density (texels per world px): the bucket at or above the
 * viewport zoom less BAKE_BUCKET_ZOOM_TOLERANCE, with
 * LIVE_BAKE_BUCKETS_PER_OCTAVE buckets per doubling, so bakes follow what the
 * display actually needs
 * — sharper as the user zooms in, coarser zoomed out (Inkscape bakes its
 * raster caches at the live CTM the same way; rasterizationDpi governs
 * exports, not the screen). The bucket is quantized because downstream caches
 * key on the resulting density and would miss on every frame of a continuous
 * zoom. Degenerate zoom values fall back to the document's raster scale.
 *
 * With `bakeBounds` (the element's full bake rect in world px) the bucket is
 * capped at the power of two that keeps that rect under the texel budget,
 * never below the raster scale. A zoomed-in filter bake covers the viewport
 * plus the filter margin, and the margin is in world px, so at 16 texels per
 * world px a margin of a few hundred px alone reaches tens of millions of
 * texels per pass. The cap comes from the element's own rect so it holds
 * still while the view pans and whether or not the bake is cached.
 *
 * `minDensity` replaces the raster-scale floor for a bake whose rect is
 * bounded by the view rather than by the element. `isExport` takes the
 * power-of-two bucket at or above the zoom itself, so display-quality
 * decisions never change exported pixels.
 */
export function interactiveBakeDensity(
	rasterZoom: number,
	viewportZoom: number,
	bakeBounds?: { width: number; height: number },
	{
		minDensity = rasterZoom,
		isExport = false,
	}: { minDensity?: number; isExport?: boolean } = {},
): number {
	if (!Number.isFinite(viewportZoom) || viewportZoom <= 0) return rasterZoom;
	const tolerance = isExport ? 1 : BAKE_BUCKET_ZOOM_TOLERANCE;
	const bucketsPerOctave = isExport ? 1 : LIVE_BAKE_BUCKETS_PER_OCTAVE;
	const bucket =
		2 **
		(Math.ceil(Math.log2(viewportZoom / tolerance) * bucketsPerOctave) /
			bucketsPerOctave);
	if (!bakeBounds) return bucket;
	const area = Math.max(1, bakeBounds.width * bakeBounds.height);
	const budgetDensity =
		2 ** Math.floor(Math.log2(Math.sqrt(INTERACTIVE_BAKE_TEXEL_BUDGET / area)));
	return Math.min(bucket, Math.max(minDensity, budgetDensity));
}

/**
 * The part of an element's filter bake (`textureBounds`, world px) that the
 * region `needed` requires, when the chain's output at a point reads its
 * input up to `reach` world px away. The cut follows a grid of
 * CROPPED_BAKE_TILE_TEXELS laid from the bake's top-left corner at `density`
 * texels per world px, so a pan inside one tile keeps the same crop. `valid`
 * is where the cropped result matches the whole bake: the crop less the reach
 * on every side cut inside the element.
 */
export function cropFilterBake(
	textureBounds: BoundingBox,
	needed: BoundingBox,
	reach: number,
	density: number,
): { bake: BoundingBox; valid: BoundingBox } {
	const tile = CROPPED_BAKE_TILE_TEXELS / density;
	const read = reach + CROPPED_BAKE_PAD_TEXELS / density;
	const { minX: left, maxY: top } = textureBounds;
	const minX = Math.max(
		left,
		left + Math.floor((needed.minX - read - left) / tile) * tile,
	);
	const maxX = Math.min(
		textureBounds.maxX,
		left + Math.ceil((needed.maxX + read - left) / tile) * tile,
	);
	const maxY = Math.min(
		top,
		top - Math.floor((top - needed.maxY - read) / tile) * tile,
	);
	const minY = Math.max(
		textureBounds.minY,
		top - Math.ceil((top - needed.minY + read) / tile) * tile,
	);
	const valid = {
		minX: minX > left ? minX + read : minX,
		minY: minY > textureBounds.minY ? minY + read : minY,
		maxX: maxX < textureBounds.maxX ? maxX - read : maxX,
		maxY: maxY < top ? maxY - read : maxY,
	};
	return {
		bake: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
		valid: {
			...valid,
			width: valid.maxX - valid.minX,
			height: valid.maxY - valid.minY,
		},
	};
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

/**
 * Render filter for an export whose targets may sit inside groups. Extends
 * expandRenderFilter with every ancestor group of the targets (so their
 * clips, masks and transforms still apply) and reports the ancestors'
 * other children as `skipIds`, so the group draws only the requested branch.
 */
export function expandRenderFilterWithAncestors(
	topLevel: ReadonlySet<string>,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): { filter: Set<string>; skipIds: Set<string> } {
	const filter = expandRenderFilter(topLevel, elementsMap);
	const parentGroupMap = buildParentGroupMap(elementsMap);
	const ancestors = new Set<string>();
	for (const id of topLevel) {
		for (
			let parentId = parentGroupMap.get(id);
			parentId != null && !ancestors.has(parentId);
			parentId = parentGroupMap.get(parentId)
		) {
			ancestors.add(parentId);
		}
	}
	for (const ancestorId of ancestors) {
		const ancestor = elementsMap.get(ancestorId);
		if (!ancestor || !isGroup(ancestor)) continue;
		filter.add(ancestorId);
		// The clip path and mask sources shape the branch even though they are
		// not requested — keep them and everything they reference.
		const shapeSources = new Set<string>(ancestor.mask?.elementIds ?? []);
		if (ancestor.clipPathId) shapeSources.add(ancestor.clipPathId);
		for (const id of expandRenderFilter(shapeSources, elementsMap)) {
			filter.add(id);
		}
	}
	const skipIds = new Set<string>();
	for (const ancestorId of ancestors) {
		const ancestor = elementsMap.get(ancestorId);
		if (!ancestor || !isGroup(ancestor)) continue;
		for (const childId of ancestor.childIds) {
			if (!filter.has(childId)) skipIds.add(childId);
		}
	}
	return { filter, skipIds };
}

/**
 * How far each element's rendered output may reach through its own filter
 * plan or a descendant's. Culling on the flat bounds alone drops a group
 * whose child's filter spreads past it wherever only that spread reaches.
 */
export function collectFilterSpread(
	plans: Iterable<{ elementId: string; textureBounds: BoundingBox }>,
	parentOf: ReadonlyMap<string, string>,
): Map<string, BoundingBox> {
	const spread = new Map<string, BoundingBox>();
	for (const plan of plans) {
		for (
			let id: string | undefined = plan.elementId;
			id != null;
			id = parentOf.get(id)
		) {
			spread.set(
				id,
				unionBoundingBoxes(spread.get(id) ?? null, plan.textureBounds)!,
			);
		}
	}
	return spread;
}

/** child id → containing group id, for every group in `elementsMap`. */
export function buildParentGroupMap(
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Map<string, string> {
	const built = new Map<string, string>();
	for (const el of elementsMap.values()) {
		if (!isGroup(el)) continue;
		for (const childId of el.childIds) built.set(childId, el.id);
	}
	return built;
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
		const area = computePolylineSignedArea(points);
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

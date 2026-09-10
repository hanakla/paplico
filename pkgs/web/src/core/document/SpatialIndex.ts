import { subscribeKey } from "valtio/utils";
import type { ObjectsChangeDelta } from "../collaboration/YjsProvider";
import type { RendererState } from "../Paplico";
import type { SnapLine, SnapResult } from "../renderer/ui/types";
import {
	type AnyArtObject,
	type Artboard,
	type BlendObject,
	type BoundingBox,
	type Document,
	type ElementTransform,
	getArtboardBounds,
	getContainerChildIds,
	getTransform,
	IDENTITY_TRANSFORM,
	isBlend,
	isContainer,
	isGroup,
	isIdentityTransform,
	isMesh,
	isPath,
	isRepeat,
	type Layer,
	type MeshArtObject,
	type Path,
	type RepeatObject,
	type TextElement,
} from "../schema";
import { isEffectivelyLocked } from "../utils/elementQuery";
import {
	computeBlendIntermediates,
	resolveBlendSourcePath,
	resolveBlendSpinePath,
} from "../utils/geometry/blendInterpolation";
import {
	boundsArea,
	boundsIntersectionArea,
	boundsIntersectionBox,
	brandWorldBBox,
	calculateElementBounds,
	calculateLocalElementBounds,
	calculatePathBounds,
	calculateRepeatSourceUnion,
	doesPathIntersectRect,
	isPointInPath,
	isPointOnPath,
	type LocalBBox,
	type LocalBoundsCache,
	type WorldBBox,
	type WorldBoundsCache,
} from "../utils/geometry/bounds";
import {
	applyTransformToBounds,
	asLocalCoord,
	asWorldCoord,
	composeTransforms,
	computeTransformOrigin,
	inverseTransform,
	type LocalCoord,
	transformLinearMatrix,
	type WorldBezierSegment,
	type WorldCoord,
} from "../utils/geometry/geometry";
import { createMeshWarpInverse } from "../utils/geometry/meshWarp";
import { Quadtree } from "../utils/geometry/Quadtree";
import {
	type Affine2D,
	composeAffine,
	computeRepeatInstances,
	elementTransformToAffine,
	repeatGridRegion,
} from "../utils/geometry/repeatInterpolation";
import { getWorldSegments, toWorldPath } from "../utils/geometry/segmentOps";
import {
	type AppearancePresetMap,
	createAppearancePresetsMap,
	resolveElementAppearance,
} from "./appearancePresets";

const WORLD_BOUNDS: BoundingBox = {
	minX: -1_000_000,
	minY: -1_000_000,
	maxX: 1_000_000,
	maxY: 1_000_000,
	width: 2_000_000,
	height: 2_000_000,
};

export class SpatialIndex {
	private static readonly SNAP_THRESHOLD_PX = 6;

	private layerQuadtrees = new Map<string, Quadtree<AnyArtObject>>();
	private artboardQuadtree = new Quadtree<Artboard>(WORLD_BOUNDS);
	private boundsCache: WorldBoundsCache = new Map();

	/**
	 * Companion to boundsCache holding local (pre-own-transform) bounds.
	 * Text entries hold the precise layout bounds pushed via setTextBounds;
	 * the synchronous text estimate is too rough for bbox/hit-test consumers.
	 * Entries MUST be dropped wherever the matching boundsCache entry is
	 * dropped so both caches share one invalidation discipline.
	 */
	private localBoundsCache: LocalBoundsCache = new Map();

	/** Memoized inverse warp per mesh; see getMeshWarpInverse. */
	private meshInverseCache = new Map<
		string,
		{ fingerprint: string; inverse: ReturnType<typeof createMeshWarpInverse> }
	>();

	/** Reverse index: childId → parentGroupId for O(1) parent lookup. */
	/**
	 * Injected precise hit test for axis-bound texts (path + glyph ink instead
	 * of the AABB). Lives in the typography layer; wired by the engine facade.
	 * Returns null to fall back to the bounds test.
	 */
	private textHitTester:
		| ((
				element: TextElement,
				x: number,
				y: number,
				tolerance: number,
		  ) => boolean | null)
		| null = null;

	public setTextHitTester(fn: SpatialIndex["textHitTester"]): void {
		this.textHitTester = fn;
	}

	private parentGroupMap = new Map<string, string>();

	/** Cached elementsMap (preset refs resolved); rebuilt when document.objects or appearancePresets change. */
	private cachedElementsMap: Map<string, AnyArtObject> | null = null;
	private cachedObjectsRef: Record<string, AnyArtObject> | null = null;
	private cachedPresetsRef: Document["appearancePresets"] | null = null;
	private cachedPresets: AppearancePresetMap = new Map();

	private unsubscribes: Array<() => void> = [];

	public constructor(private store: RendererState) {}

	/**
	 * Subscribe to store.document reference changes and auto-rebuild all indices.
	 * Uses notifyInSync so the rebuild fires synchronously during the assignment,
	 * before control returns to the caller.
	 */
	public start(): void {
		if (this.unsubscribes.length > 0) return;
		this.unsubscribes.push(
			subscribeKey(
				this.store,
				"document",
				() => {
					this.rebuildAllIndices();
				},
				true,
			),
		);
	}

	public stop(): void {
		for (const unsub of this.unsubscribes) unsub();
		this.unsubscribes = [];
	}

	// ===== Bounds Cache =====

	/**
	 * Returns cached bounds if available; otherwise calculates, caches, and returns them.
	 * If element is not provided, it is looked up from the store.
	 */
	public getBounds(
		elementId: string,
		element?: AnyArtObject,
	): WorldBBox | null {
		const cached = this.boundsCache.get(elementId);
		if (cached) return cached;

		const el = element ?? this.findElement(elementId);
		if (!el) return null;

		const elementsMap = this.getElementsMapCached();
		const bounds = calculateElementBounds(
			this.resolveAppearance(el),
			elementsMap,
			this.localBoundsCache,
		);
		this.boundsCache.set(elementId, bounds);
		return bounds;
	}

	/**
	 * Returns element bounds in world space, composing the full ancestor group transform chain.
	 * For top-level elements (no parent group), identical to getBounds().
	 */
	public getWorldBounds(elementId: string): WorldBBox | null {
		const ancestorT = this.resolveWorldTransform(elementId);
		if (isIdentityTransform(ancestorT)) return this.getBounds(elementId);

		const el = this.findElement(elementId);
		if (!el) return null;

		const elementsMap = this.getElementsMapCached();
		const localBounds = calculateLocalElementBounds(
			el,
			elementsMap,
			this.localBoundsCache,
		);
		const composedT = composeTransforms(ancestorT, getTransform(el));
		return applyTransformToBounds(localBounds, composedT);
	}

	/** The blend that directly absorbs this element, or null. */
	private getDirectBlendParent(elementId: string): BlendObject | null {
		const parentId = this.parentGroupMap.get(elementId);
		if (!parentId) return null;
		const parent = this.store.document.objects[parentId];
		return parent && isBlend(parent) ? parent : null;
	}

	/**
	 * World-space outline segments of a path element as actually drawn, for
	 * selection overlays. Ancestor transforms — including a parent blend's
	 * source-pivot compensation (see resolveWorldTransform) — are applied, so the
	 * outline tracks the rendered shape. Returns null for non-path/empty geometry.
	 */
	public getElementWorldSegments(
		elementId: string,
	): WorldBezierSegment[] | null {
		const el = this.findElement(elementId);
		if (!el || !isPath(el) || el.segments.length === 0) return null;
		return getWorldSegments(
			el,
			this.getAncestorTransform(elementId) ?? undefined,
		);
	}

	/**
	 * World-space path of a path element with segment metadata preserved
	 * (isMoved/isClosed — required by text axis binding to classify and walk
	 * subpaths). Returns null for non-path/empty geometry.
	 */
	public getElementWorldPath(elementId: string): Path | null {
		const el = this.findElement(elementId);
		if (!el || !isPath(el) || el.segments.length === 0) return null;
		return toWorldPath(el, this.getAncestorTransform(elementId) ?? undefined);
	}

	/**
	 * Returns the composed ancestor transform chain for the given element.
	 * Returns null if the element has no parent group or the transform is identity.
	 */
	public getAncestorTransform(elementId: string): ElementTransform | null {
		const t = this.resolveWorldTransform(elementId);
		return isIdentityTransform(t) ? null : t;
	}

	/** Explicitly set bounds, e.g. after applying a move/resize delta. */
	public setBounds(elementId: string, bounds: WorldBBox): void {
		this.boundsCache.set(elementId, bounds);

		// Sync quadtree entry so hit-testing uses the same bounds as the cache
		const element = this.findElement(elementId);
		if (!element) return;

		for (const [, quadtree] of this.layerQuadtrees) {
			if (quadtree.remove(elementId)) {
				quadtree.insert({ id: elementId, data: element, bounds });
				break;
			}
		}
	}

	/**
	 * Store precise text bounds computed asynchronously by the text layout
	 * engine. `worldBounds` has the element's own transform applied;
	 * `localBounds` is the pre-transform box in the same space as
	 * calculateLocalElementBounds. Ancestor container bounds were computed
	 * from the rough synchronous text estimate, so recalculate them here.
	 */
	public setTextBounds(
		elementId: string,
		worldBounds: WorldBBox,
		localBounds: LocalBBox,
	): void {
		this.localBoundsCache.set(elementId, localBounds);
		this.setBounds(elementId, worldBounds);
		this.invalidateAncestorBounds(elementId);
	}

	/**
	 * Recalculate an element's cached bounds from the current document (bounds
	 * are stored in the element's parent space) and refresh every ancestor
	 * container whose bounds depend on it. Use after a mutation that reshapes
	 * the element, e.g. a resize.
	 */
	public invalidateBoundsWithAncestors(elementId: string): void {
		this.invalidateBounds(elementId);
		this.invalidateAncestorBounds(elementId);
	}

	/** Recalculate cached bounds for every ancestor container of an element. */
	private invalidateAncestorBounds(elementId: string): void {
		let ancestorId = this.parentGroupMap.get(elementId);
		while (ancestorId) {
			this.invalidateBounds(ancestorId);
			ancestorId = this.parentGroupMap.get(ancestorId);
		}
	}

	/** Incrementally update the cached elementsMap from a delta (avoids full O(N) rebuild). */
	public applyObjectsDelta(delta: ObjectsChangeDelta): void {
		if (!this.cachedElementsMap) return;
		for (const [id, obj] of delta.added) this.cachedElementsMap.set(id, obj);
		for (const [id, obj] of delta.updated) this.cachedElementsMap.set(id, obj);
		for (const id of delta.deleted) this.cachedElementsMap.delete(id);
	}

	/** Clear a single element's bounds cache entry without touching the quadtree. */
	private clearBoundsCache(elementId: string): void {
		this.boundsCache.delete(elementId);
		this.localBoundsCache.delete(elementId);
	}

	/**
	 * Clear the cached bounds of an element and of every container above it.
	 * A container's bounds are derived from its children's cached bounds, so a
	 * change deep inside a nested group has to drop the whole chain or the
	 * containers in between keep reporting the pre-change extent.
	 */
	public clearBoundsCacheWithAncestors(elementId: string): void {
		for (
			let id: string | undefined = elementId;
			id;
			id = this.parentGroupMap.get(id)
		) {
			this.clearBoundsCache(id);
		}
	}

	/** Recalculate bounds and sync the Quadtree entry. Falls back to cache-only deletion if element is not found. */
	public invalidateBounds(elementId: string): void {
		this.localBoundsCache.delete(elementId);
		this.meshInverseCache.delete(elementId);
		const element = this.findElement(elementId);
		if (!element) {
			this.boundsCache.delete(elementId);
			return;
		}

		const elementsMap = this.getElementsMapCached();
		const bounds = calculateElementBounds(
			this.resolveAppearance(element),
			elementsMap,
			this.localBoundsCache,
		);
		this.boundsCache.set(elementId, bounds);

		for (const [, quadtree] of this.layerQuadtrees) {
			if (quadtree.remove(elementId)) {
				quadtree.insert({ id: elementId, data: element, bounds });
				break;
			}
		}
	}

	// ===== Mutation =====

	public insertElement(
		layerId: string,
		element: AnyArtObject,
		parentGroupId?: string,
	): void {
		const quadtree = this.getOrCreateLayerQuadtree(layerId);
		const elementsMap = this.getElementsMapCached();
		const bounds = calculateElementBounds(
			this.resolveAppearance(element),
			elementsMap,
			this.localBoundsCache,
		);
		this.boundsCache.set(element.id, bounds);
		quadtree.insert({ id: element.id, data: element, bounds });

		// Register children of container elements in the reverse index.
		const insertedChildIds = getContainerChildIds(element);
		if (insertedChildIds) {
			for (const childId of insertedChildIds) {
				this.parentGroupMap.set(childId, element.id);
			}
		}

		if (parentGroupId) {
			this.parentGroupMap.set(element.id, parentGroupId);
		}
	}

	public removeElement(layerId: string, elementId: string): void {
		this.layerQuadtrees.get(layerId)?.remove(elementId);
		this.boundsCache.delete(elementId);
		this.localBoundsCache.delete(elementId);

		const element = this.findElement(elementId);
		if (element) {
			const removedChildIds = getContainerChildIds(element);
			if (removedChildIds) {
				for (const childId of removedChildIds) {
					this.parentGroupMap.delete(childId);
				}
			}
		}
		this.parentGroupMap.delete(elementId);
	}

	/**
	 * Update an element's Quadtree entry: recalculate bounds and re-insert.
	 * Used for incremental sync after partial document updates.
	 */
	public updateElement(layerId: string, element: AnyArtObject): void {
		const quadtree = this.layerQuadtrees.get(layerId);
		if (!quadtree) return;

		quadtree.remove(element.id);
		this.boundsCache.delete(element.id);
		this.localBoundsCache.delete(element.id);

		const elementsMap = this.getElementsMapCached();
		const bounds = calculateElementBounds(
			this.resolveAppearance(element),
			elementsMap,
			this.localBoundsCache,
		);
		this.boundsCache.set(element.id, bounds);
		quadtree.insert({ id: element.id, data: element, bounds });

		const updatedChildIds = getContainerChildIds(element);
		if (updatedChildIds) {
			// Remove stale child entries that point to this element as their parent.
			for (const [childId, parentId] of this.parentGroupMap) {
				if (parentId === element.id) {
					this.parentGroupMap.delete(childId);
				}
			}
			for (const childId of updatedChildIds) {
				this.parentGroupMap.set(childId, element.id);
			}
		}
	}

	public createLayerIndex(layerId: string): void {
		this.getOrCreateLayerQuadtree(layerId);
	}

	public rebuildAllIndices(): void {
		this.layerQuadtrees.clear();

		// Clear bounds cache to prevent stale values after undo/redo,
		// but preserve text element bounds. Text bounds are computed
		// asynchronously by TextRenderer and the synchronous fallback
		// (calculateTextBounds) is too rough for reliable hit-testing.
		// Preserved bounds are reused by rebuildLayerIndex below.
		const preservedTextBounds = new Map<string, WorldBBox>();
		for (const [id, bounds] of this.boundsCache) {
			if (this.store.document.objects[id]?.type === "text") {
				preservedTextBounds.set(id, bounds);
			}
		}
		const preservedTextLocalBounds = new Map<string, LocalBBox>();
		for (const [id, bounds] of this.localBoundsCache) {
			if (this.store.document.objects[id]?.type === "text") {
				preservedTextLocalBounds.set(id, bounds);
			}
		}
		this.boundsCache.clear();
		this.localBoundsCache.clear();
		for (const [id, bounds] of preservedTextBounds) {
			this.boundsCache.set(id, bounds);
		}
		for (const [id, bounds] of preservedTextLocalBounds) {
			this.localBoundsCache.set(id, bounds);
		}

		this.cachedElementsMap = null;
		this.cachedObjectsRef = null;

		// Rebuild parent group reverse index.
		this.parentGroupMap.clear();

		const activeIds = new Set<string>();

		for (const layer of this.store.document.layers) {
			this.rebuildLayerIndex(layer, activeIds);
		}

		for (const obj of Object.values(this.store.document.objects)) {
			const childIds = getContainerChildIds(obj);
			if (childIds) {
				for (const childId of childIds) {
					this.parentGroupMap.set(childId, obj.id);
				}
			}
		}

		for (const id of this.boundsCache.keys()) {
			if (!activeIds.has(id)) {
				this.boundsCache.delete(id);
			}
		}
		for (const id of this.localBoundsCache.keys()) {
			if (!activeIds.has(id)) {
				this.localBoundsCache.delete(id);
			}
		}

		// Rebuild the artboard spatial index.
		this.artboardQuadtree = new Quadtree<Artboard>(WORLD_BOUNDS);
		for (const artboard of this.store.document.artboards) {
			this.insertArtboard(artboard);
		}
	}

	/** Look up the parent Group ID for a given child element ID. O(1). */
	public getParentGroupId(elementId: string): string | null {
		return this.parentGroupMap.get(elementId) ?? null;
	}

	/**
	 * Check if an element is effectively locked by checking the element itself,
	 * its ancestor groups, and its containing layer.
	 */
	public isElementLocked(elementId: string): boolean {
		return isEffectivelyLocked(
			elementId,
			this.store.document.objects,
			this.store.document.layers,
			this.parentGroupMap,
		);
	}

	/** Returns the bounds cache map; used to avoid recomputation in the render loop. */
	public getBoundsCache(): WorldBoundsCache {
		return this.boundsCache;
	}

	// ===== Artboard Index =====

	private insertArtboard(artboard: Artboard): void {
		const bounds = getArtboardBounds(artboard);
		this.artboardQuadtree.insert({ id: artboard.id, data: artboard, bounds });
	}

	public updateArtboard(artboard: Artboard): void {
		this.artboardQuadtree.remove(artboard.id);
		this.insertArtboard(artboard);
	}

	/**
	 * Calculate the snapped position for an artboard being moved.
	 * Compares all artboard edges; a full scan is required because edge alignment
	 * is independent of spatial proximity.
	 */
	public snapArtboard(
		movingArtboardId: string,
		originalBounds: BoundingBox,
		proposedDeltaX: number,
		proposedDeltaY: number,
		zoom: number,
	): SnapResult {
		const threshold = SpatialIndex.SNAP_THRESHOLD_PX / zoom;

		const candidate = {
			minX: originalBounds.minX + proposedDeltaX,
			maxX: originalBounds.maxX + proposedDeltaX,
			minY: originalBounds.minY + proposedDeltaY,
			maxY: originalBounds.maxY + proposedDeltaY,
		};

		// Full scan: edge alignment is independent of spatial proximity, and artboard count stays small.
		const others = this.artboardQuadtree
			.getAll()
			.filter((item) => item.id !== movingArtboardId);

		let bestCorrectionX = 0;
		let bestDistX = threshold;
		let snapLineX: SnapLine | null = null;

		for (const other of others) {
			const ob = other.bounds;
			for (const movingEdge of [candidate.minX, candidate.maxX]) {
				for (const targetEdge of [ob.minX, ob.maxX]) {
					const dist = Math.abs(movingEdge - targetEdge);
					if (dist < bestDistX) {
						bestDistX = dist;
						bestCorrectionX = targetEdge - movingEdge;
						snapLineX = {
							axis: "vertical",
							position: targetEdge,
							extentMin: Math.min(candidate.minY, ob.minY),
							extentMax: Math.max(candidate.maxY, ob.maxY),
						};
					}
				}
			}
		}

		let bestCorrectionY = 0;
		let bestDistY = threshold;
		let snapLineY: SnapLine | null = null;

		for (const other of others) {
			const ob = other.bounds;
			for (const movingEdge of [candidate.minY, candidate.maxY]) {
				for (const targetEdge of [ob.minY, ob.maxY]) {
					const dist = Math.abs(movingEdge - targetEdge);
					if (dist < bestDistY) {
						bestDistY = dist;
						bestCorrectionY = targetEdge - movingEdge;
						snapLineY = {
							axis: "horizontal",
							position: targetEdge,
							extentMin: Math.min(candidate.minX + bestCorrectionX, ob.minX),
							extentMax: Math.max(candidate.maxX + bestCorrectionX, ob.maxX),
						};
					}
				}
			}
		}

		const snapLines: SnapLine[] = [];
		if (snapLineX) snapLines.push(snapLineX);
		if (snapLineY) snapLines.push(snapLineY);

		return {
			deltaX: proposedDeltaX + bestCorrectionX,
			deltaY: proposedDeltaY + bestCorrectionY,
			snapLines,
		};
	}

	/**
	 * Calculate the snapped position for elements being moved.
	 * Snaps to edges and centers of all layer elements and artboards.
	 * In group edit mode, also includes children of the active container.
	 */
	public snapElements(
		movingElementIds: string[],
		originalBounds: BoundingBox,
		proposedDeltaX: number,
		proposedDeltaY: number,
		zoom: number,
	): SnapResult {
		const threshold = SpatialIndex.SNAP_THRESHOLD_PX / zoom;
		const movingSet = new Set(movingElementIds);

		const candidate = {
			minX: originalBounds.minX + proposedDeltaX,
			maxX: originalBounds.maxX + proposedDeltaX,
			minY: originalBounds.minY + proposedDeltaY,
			maxY: originalBounds.maxY + proposedDeltaY,
		};
		const candidateCenterX = (candidate.minX + candidate.maxX) / 2;
		const candidateCenterY = (candidate.minY + candidate.maxY) / 2;

		const targets: Array<{
			minX: number;
			maxX: number;
			minY: number;
			maxY: number;
		}> = [];

		// Full scan: collect all non-moving elements as snap targets; edge alignment is independent of spatial proximity.
		for (const [, quadtree] of this.layerQuadtrees) {
			for (const item of quadtree.getAll()) {
				if (movingSet.has(item.id)) continue;
				targets.push(item.bounds);
			}
		}

		// In an editing scope, also include children of the active container.
		const editingScopeIdForSnap = this.store.editingScopeStack.at(-1);
		if (editingScopeIdForSnap) {
			const container = this.store.document.objects[editingScopeIdForSnap];
			const snapChildIds = container ? getContainerChildIds(container) : null;
			if (snapChildIds) {
				for (const childId of snapChildIds) {
					if (movingSet.has(childId)) continue;
					const childBounds = this.boundsCache.get(childId);
					if (childBounds) targets.push(childBounds);
				}
			}
		}

		// Include artboard bounds as snap targets.
		for (const item of this.artboardQuadtree.getAll()) {
			targets.push(item.bounds);
		}

		let bestCorrectionX = 0;
		let bestDistX = threshold;
		let snapLineX: SnapLine | null = null;

		for (const tb of targets) {
			const targetCenterX = (tb.minX + tb.maxX) / 2;
			for (const movingEdge of [
				candidate.minX,
				candidate.maxX,
				candidateCenterX,
			]) {
				for (const targetEdge of [tb.minX, tb.maxX, targetCenterX]) {
					const dist = Math.abs(movingEdge - targetEdge);
					if (dist < bestDistX) {
						bestDistX = dist;
						bestCorrectionX = targetEdge - movingEdge;
						snapLineX = {
							axis: "vertical",
							position: targetEdge,
							extentMin: Math.min(candidate.minY, tb.minY),
							extentMax: Math.max(candidate.maxY, tb.maxY),
						};
					}
				}
			}
		}

		let bestCorrectionY = 0;
		let bestDistY = threshold;
		let snapLineY: SnapLine | null = null;

		for (const tb of targets) {
			const targetCenterY = (tb.minY + tb.maxY) / 2;
			for (const movingEdge of [
				candidate.minY,
				candidate.maxY,
				candidateCenterY,
			]) {
				for (const targetEdge of [tb.minY, tb.maxY, targetCenterY]) {
					const dist = Math.abs(movingEdge - targetEdge);
					if (dist < bestDistY) {
						bestDistY = dist;
						bestCorrectionY = targetEdge - movingEdge;
						snapLineY = {
							axis: "horizontal",
							position: targetEdge,
							extentMin: Math.min(candidate.minX + bestCorrectionX, tb.minX),
							extentMax: Math.max(candidate.maxX + bestCorrectionX, tb.maxX),
						};
					}
				}
			}
		}

		const snapLines: SnapLine[] = [];
		if (snapLineX) snapLines.push(snapLineX);
		if (snapLineY) snapLines.push(snapLineY);

		return {
			deltaX: proposedDeltaX + bestCorrectionX,
			deltaY: proposedDeltaY + bestCorrectionY,
			snapLines,
		};
	}

	// ===== Artboard Element Overlap =====

	/**
	 * Find all top-level elements across all layers whose effective bounding box
	 * overlaps the given artboard bounds by more than 50% of the element's area.
	 *
	 * For ClipGroups (Groups with clipPathId), the "effective BB" is the intersection
	 * of the clipPath's BB and the group children's union BB.
	 * Group children are NOT returned individually — only the parent group.
	 */
	public findElementsOverlappingArtboard(
		artboardBounds: BoundingBox,
	): Array<{ layerId: string; elementId: string }> {
		const results: Array<{ layerId: string; elementId: string }> = [];
		const elementsMap = this.getElementsMapCached();

		for (const layer of this.store.document.layers) {
			const quadtree = this.layerQuadtrees.get(layer.id);
			if (!quadtree) continue;

			for (const item of quadtree.query(artboardBounds)) {
				const effectiveBB = this.getEffectiveBounds(item.data, elementsMap);
				if (!effectiveBB) continue;

				const area = boundsArea(effectiveBB);
				if (area <= 0) continue;

				const overlapArea = boundsIntersectionArea(artboardBounds, effectiveBB);
				if (overlapArea / area > 0.5) {
					results.push({ layerId: layer.id, elementId: item.id });
				}
			}
		}

		return results;
	}

	/**
	 * Get the "effective bounding box" of an element for artboard overlap testing.
	 *
	 * For ClipGroups (Group with clipPathId): returns the intersection of the
	 * clipPath element's BB and the group's union BB.
	 * For all other elements: returns the normal BB.
	 */
	private getEffectiveBounds(
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
	): BoundingBox | null {
		if (isGroup(element) && element.clipPathId) {
			const clipEl = elementsMap.get(element.clipPathId);
			if (!clipEl) return this.getBounds(element.id, element);

			const clipBounds =
				this.getBounds(clipEl.id, clipEl) ??
				calculateElementBounds(
					this.resolveAppearance(clipEl),
					elementsMap,
					this.localBoundsCache,
				);
			const groupBounds =
				this.getBounds(element.id, element) ??
				calculateElementBounds(
					this.resolveAppearance(element),
					elementsMap,
					this.localBoundsCache,
				);

			return boundsIntersectionBox(clipBounds, groupBounds);
		}

		return (
			this.getBounds(element.id, element) ??
			calculateElementBounds(
				this.resolveAppearance(element),
				elementsMap,
				this.localBoundsCache,
			)
		);
	}

	/**
	 * Snap a bounding box to element and artboard edges across all layers.
	 * Used when creating or resizing artboards to snap to nearby boundaries.
	 */
	public snapBoundsToElements(
		candidateBounds: BoundingBox,
		zoom: number,
	): SnapResult {
		const threshold = SpatialIndex.SNAP_THRESHOLD_PX / zoom;

		let bestCorrectionX = 0;
		let bestDistX = threshold;
		let snapLineX: SnapLine | null = null;

		let bestCorrectionY = 0;
		let bestDistY = threshold;
		let snapLineY: SnapLine | null = null;

		for (const [, quadtree] of this.layerQuadtrees) {
			for (const item of quadtree.getAll()) {
				const ob = item.bounds;

				for (const movingEdge of [candidateBounds.minX, candidateBounds.maxX]) {
					for (const targetEdge of [ob.minX, ob.maxX]) {
						const dist = Math.abs(movingEdge - targetEdge);
						if (dist < bestDistX) {
							bestDistX = dist;
							bestCorrectionX = targetEdge - movingEdge;
							snapLineX = {
								axis: "vertical",
								position: targetEdge,
								extentMin: Math.min(candidateBounds.minY, ob.minY),
								extentMax: Math.max(candidateBounds.maxY, ob.maxY),
							};
						}
					}
				}

				for (const movingEdge of [candidateBounds.minY, candidateBounds.maxY]) {
					for (const targetEdge of [ob.minY, ob.maxY]) {
						const dist = Math.abs(movingEdge - targetEdge);
						if (dist < bestDistY) {
							bestDistY = dist;
							bestCorrectionY = targetEdge - movingEdge;
							snapLineY = {
								axis: "horizontal",
								position: targetEdge,
								extentMin: Math.min(
									candidateBounds.minX + bestCorrectionX,
									ob.minX,
								),
								extentMax: Math.max(
									candidateBounds.maxX + bestCorrectionX,
									ob.maxX,
								),
							};
						}
					}
				}
			}
		}

		for (const item of this.artboardQuadtree.getAll()) {
			const ob = item.bounds;

			for (const movingEdge of [candidateBounds.minX, candidateBounds.maxX]) {
				for (const targetEdge of [ob.minX, ob.maxX]) {
					const dist = Math.abs(movingEdge - targetEdge);
					if (dist < bestDistX) {
						bestDistX = dist;
						bestCorrectionX = targetEdge - movingEdge;
						snapLineX = {
							axis: "vertical",
							position: targetEdge,
							extentMin: Math.min(candidateBounds.minY, ob.minY),
							extentMax: Math.max(candidateBounds.maxY, ob.maxY),
						};
					}
				}
			}

			for (const movingEdge of [candidateBounds.minY, candidateBounds.maxY]) {
				for (const targetEdge of [ob.minY, ob.maxY]) {
					const dist = Math.abs(movingEdge - targetEdge);
					if (dist < bestDistY) {
						bestDistY = dist;
						bestCorrectionY = targetEdge - movingEdge;
						snapLineY = {
							axis: "horizontal",
							position: targetEdge,
							extentMin: Math.min(
								candidateBounds.minX + bestCorrectionX,
								ob.minX,
							),
							extentMax: Math.max(
								candidateBounds.maxX + bestCorrectionX,
								ob.maxX,
							),
						};
					}
				}
			}
		}

		const snapLines: SnapLine[] = [];
		if (snapLineX) snapLines.push(snapLineX);
		if (snapLineY) snapLines.push(snapLineY);

		return {
			deltaX: bestCorrectionX,
			deltaY: bestCorrectionY,
			snapLines,
		};
	}

	// ===== Query =====

	public queryElements(
		layerId: string,
		bounds: WorldBBox,
		editingScopeId?: string,
	): AnyArtObject[] {
		if (editingScopeId) {
			const scopedLayer = this.store.document.layers.find(
				(layer) => layer.id === editingScopeId,
			);
			if (scopedLayer) {
				return scopedLayer.elementIds
					.map((id) => this.store.document.objects[id])
					.filter((el): el is AnyArtObject => {
						if (!el) return false;
						const elBounds = this.getBounds(el.id, el);
						if (!elBounds) return false;
						return (
							elBounds.minX <= bounds.maxX &&
							elBounds.maxX >= bounds.minX &&
							elBounds.minY <= bounds.maxY &&
							elBounds.maxY >= bounds.minY
						);
					});
			}

			const scopeElement = this.store.document.objects[editingScopeId];
			if (!scopeElement) return [];
			const containerChildIds = getContainerChildIds(scopeElement);

			// Single-element scope: the scope element itself is the only candidate.
			if (!containerChildIds) {
				const elBounds = this.getWorldBounds(editingScopeId);
				if (!elBounds) return [];
				const intersects =
					elBounds.minX <= bounds.maxX &&
					elBounds.maxX >= bounds.minX &&
					elBounds.minY <= bounds.maxY &&
					elBounds.maxY >= bounds.minY;
				return intersects ? [scopeElement] : [];
			}

			// getWorldBounds composes the full ancestor chain around each child's
			// own origin — matching how the renderer places the child (see
			// writeTransformAt in ViewportManager) and the exact inverse of the
			// per-candidate worldToLocalCoords inversion in findElementAtPoint.
			return containerChildIds
				.map((id) => this.store.document.objects[id])
				.filter((el): el is AnyArtObject => {
					if (!el) return false;
					const elBounds = this.getWorldBounds(el.id);
					if (!elBounds) return false;
					return (
						elBounds.minX <= bounds.maxX &&
						elBounds.maxX >= bounds.minX &&
						elBounds.minY <= bounds.maxY &&
						elBounds.maxY >= bounds.minY
					);
				});
		}

		const quadtree = this.layerQuadtrees.get(layerId);
		if (!quadtree) return [];

		return quadtree.query(bounds).map((item) => item.data);
	}

	public findElementAtPoint(
		layerId: string,
		x: number,
		y: number,
		tolerance = 5,
	): AnyArtObject | null {
		const bounds = brandWorldBBox({
			minX: x - tolerance,
			minY: y - tolerance,
			maxX: x + tolerance,
			maxY: y + tolerance,
			width: tolerance * 2,
			height: tolerance * 2,
		});

		const editingScopeId = this.store.editingScopeStack.at(-1);
		const candidates = this.queryElements(
			layerId,
			bounds,
			editingScopeId ?? undefined,
		);
		const visibleCandidates = candidates.filter(
			(el) => isElementVisible(el) && !this.isElementLocked(el.id),
		);
		if (visibleCandidates.length === 0) return null;

		// Editing scope: candidates are the scope element's children (or the
		// scope element itself for single-element scopes). Hit-test each
		// candidate in its own local space via worldToLocalCoords — the exact
		// inverse of how the renderer places it (composed ancestor chain
		// applied around the candidate's own origin, see writeTransformAt in
		// ViewportManager) and of the getWorldBounds boxes used by
		// queryElements to pick the candidates.
		if (editingScopeId) {
			// Reverse order for front-to-back priority.
			for (let i = visibleCandidates.length - 1; i >= 0; i--) {
				const candidate = visibleCandidates[i];
				const { x: localX, y: localY } = this.worldToLocalCoords(
					asWorldCoord(x),
					asWorldCoord(y),
					candidate.id,
					candidate,
				);
				if (this.isPointOnElementLocal(candidate, localX, localY, tolerance)) {
					// The scope element itself must never be promoted to an
					// ancestor clip group, or it would become unselectable
					// inside its own scope.
					if (candidate.id === editingScopeId) {
						return candidate;
					}
					return this.resolveClipGroupAncestor(candidate, editingScopeId);
				}
			}
			return null;
		}

		// Not in an editing scope. Candidates are top-level elements whose parent
		// space IS world space, so the world point doubles as the parent-local
		// point isPointOnElement expects.
		const hitElements = visibleCandidates.filter((el) =>
			this.isPointOnElement(el, asLocalCoord(x), asLocalCoord(y), tolerance),
		);
		if (hitElements.length === 0) return null;

		// Resolve each hit element to its top-level selectable target
		// Walk the full ancestor chain so deeply nested children resolve
		// to their top-level container.
		const resolvedTargets = new Map<string, AnyArtObject>();
		for (const element of hitElements) {
			let targetId = element.id;
			let targetElement: AnyArtObject = element;
			let parentId = this.parentGroupMap.get(targetId);
			while (parentId) {
				const parent = this.store.document.objects[parentId];
				if (!parent || !isContainer(parent) || !isElementVisible(parent)) break;
				targetId = parentId;
				targetElement = parent;
				parentId = this.parentGroupMap.get(targetId);
			}
			resolvedTargets.set(targetElement.id, targetElement);
		}

		// Return the frontmost element according to layer Z-order
		// (layer.elementIds: index 0 = backmost, last = frontmost)
		const layer = this.store.document.layers.find((l) => l.id === layerId);
		if (layer) {
			for (let i = layer.elementIds.length - 1; i >= 0; i--) {
				const el = resolvedTargets.get(layer.elementIds[i]);
				if (el) return el;
			}
		}

		return resolvedTargets.values().next().value ?? null;
	}

	/**
	 * If the element is a descendant of a clip group (Group with clipPathId)
	 * that the user hasn't entered via editingScopeStack, promote to the clip group.
	 */
	private resolveClipGroupAncestor(
		element: AnyArtObject,
		editingScopeId: string | undefined,
	): AnyArtObject {
		let currentId = element.id;
		let parentId = this.parentGroupMap.get(currentId);
		while (parentId) {
			if (parentId === editingScopeId) break;
			const parent = this.store.document.objects[parentId];
			if (!parent) break;
			if (isGroup(parent) && parent.clipPathId) return parent;
			currentId = parentId;
			parentId = this.parentGroupMap.get(currentId);
		}
		return element;
	}

	/**
	 * Find a path element at a point, resolving through groups.
	 * Unlike findElementAtPoint which returns parent groups,
	 * this returns the actual child path inside a group.
	 */
	public findPathAtPoint(
		layerId: string,
		x: number,
		y: number,
		tolerance = 5,
		deepSearch = false,
	): Path | null {
		const element = this.findElementAtPoint(layerId, x, y, tolerance);
		if (!element) return null;

		if (element.type === "path" && isPath(element)) return element;

		const pathSearchChildIds = getContainerChildIds(element);
		if (pathSearchChildIds) {
			// A mesh warp container renders its children warped, so their stored
			// (unwarped) geometry is only reachable after entering the mesh's own
			// editing scope — even a deep search must not leak through it.
			if (
				isMesh(element) &&
				!this.store.editingScopeStack.includes(element.id)
			) {
				return null;
			}
			if (!deepSearch) {
				// Only dig into container children if we are editing inside this container
				// or if this container is a direct child of the current editing scope.
				const editingScopeId = this.store.editingScopeStack.at(-1);
				const canDigInto =
					editingScopeId === element.id ||
					(editingScopeId != null &&
						this.parentGroupMap.get(element.id) === editingScopeId);
				if (!canDigInto) return null;
			}

			const { x: localX, y: localY } = this.worldToLocalCoords(
				asWorldCoord(x),
				asWorldCoord(y),
				element.id,
				element,
			);

			return this.findPathInChildren(
				pathSearchChildIds,
				localX,
				localY,
				tolerance,
			);
		}

		return null;
	}

	public findElementsInRect(
		layerId: string,
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
	): AnyArtObject[] {
		const editingScopeId = this.store.editingScopeStack.at(-1);
		const candidates = this.queryElements(
			layerId,
			brandWorldBBox({
				minX,
				minY,
				maxX,
				maxY,
				width: maxX - minX,
				height: maxY - minY,
			}),
			editingScopeId ?? undefined,
		).filter((el) => isElementVisible(el) && !this.isElementLocked(el.id));

		return candidates.filter((el) =>
			this.isElementInRect(el, minX, minY, maxX, maxY),
		);
	}

	// ===== Internal =====

	/**
	 * Resolve the composed world-space transform for an element
	 * by walking up the ancestor Group chain via parentGroupMap.
	 */
	private resolveWorldTransform(elementId: string): ElementTransform {
		let t = IDENTITY_TRANSFORM;
		let ancestorId = this.parentGroupMap.get(elementId);
		while (ancestorId) {
			const ancestor = this.store.document.objects[ancestorId];
			if (ancestor) {
				t = composeTransforms(getTransform(ancestor), t);
			}
			ancestorId = this.parentGroupMap.get(ancestorId);
		}

		// A blend draws its sources baked and pivots the whole blend around the
		// blend's own bbox center (renderBlend), not each source's center. Generic
		// consumers apply this ancestor transform around the element's own center,
		// which only matches for pure translation. Re-express the blend transform
		// as one pivoted around the source's center so EVERY ancestor-aware
		// consumer (bounds, outline, PathEdit handles, rotate…) matches the
		// rendering.
		const blend = this.getDirectBlendParent(elementId);
		if (blend) return this.pivotBlendTransformAroundSource(t, blend, elementId);
		return t;
	}

	/**
	 * Re-express `blendWorldT` (pivoting around the blend's local bbox center) as
	 * an equivalent transform pivoting around the source's local bbox center.
	 * Same rotation/scale; only the translation is shifted by (I − A)(Ob − Os),
	 * where A is the transform's linear part, Ob the blend center, Os the source
	 * center — so applyTransform(p, result, Os) == applyTransform(p, blendWorldT, Ob).
	 */
	private pivotBlendTransformAroundSource(
		blendWorldT: ElementTransform,
		blend: BlendObject,
		sourceId: string,
	): ElementTransform {
		const source = this.store.document.objects[sourceId];
		if (!source) return blendWorldT;

		const elementsMap = this.getElementsMapCached();
		const os = computeTransformOrigin(
			calculateLocalElementBounds(source, elementsMap, this.localBoundsCache),
		);
		const ob = computeTransformOrigin(
			calculateLocalElementBounds(blend, elementsMap, this.localBoundsCache),
		);
		const dx = ob.x - os.x;
		const dy = ob.y - os.y;
		// A·d, where A is the blend transform's linear part (rotation · shear · scale).
		const m = transformLinearMatrix(blendWorldT);
		const adx = m.m00 * dx + m.m01 * dy;
		const ady = m.m10 * dx + m.m11 * dy;
		return {
			...blendWorldT,
			x: blendWorldT.x + dx - adx,
			y: blendWorldT.y + dy - ady,
		};
	}

	/**
	 * Inverse-transform a world-space point into the local coordinate space
	 * of an element, composing the full ancestor chain + the element's own transform.
	 */
	private worldToLocalCoords(
		x: WorldCoord,
		y: WorldCoord,
		elementId: string,
		element: AnyArtObject,
	): { x: LocalCoord; y: LocalCoord } {
		const worldT = composeTransforms(
			this.resolveWorldTransform(elementId),
			getTransform(element),
		);
		// Identity chain: world space and the element's local space coincide.
		if (isIdentityTransform(worldT))
			return { x: asLocalCoord(x), y: asLocalCoord(y) };
		const localBounds = calculateLocalElementBounds(
			element,
			this.getElementsMapCached(),
			this.localBoundsCache,
		);
		const origin = computeTransformOrigin(localBounds);
		return inverseTransform(x, y, worldT, origin.x, origin.y);
	}

	/**
	 * Recursively search container children for a Path element at the given point.
	 * Handles nested containers, coordinate transforms, and clip path rejection at each level.
	 */
	private findPathInChildren(
		childIds: string[],
		x: LocalCoord,
		y: LocalCoord,
		tolerance: number,
	): Path | null {
		// childIds[0] draws backmost, so walk from the end to hit the frontmost
		// path first, matching the layer-level Z-order resolution.
		for (let i = childIds.length - 1; i >= 0; i--) {
			const childId = childIds[i];
			const child = this.store.document.objects[childId];
			if (!child || !isElementVisible(child) || this.isElementLocked(childId))
				continue;

			if (isPath(child)) {
				// Inverse-apply the child's own transform before the hit test: x/y are
				// in the container's local space, but isPointOnPath expects the path's
				// local space. Blend sources keep their own transforms (the positional
				// offset is the whole point of a blend), so without this a body click on
				// a blend's inner object never hits.
				if (this.isPointOnPathLocal(child, x, y, tolerance)) return child;
				continue;
			}

			if (!isContainer(child)) continue;
			// Nested mesh warp containers keep the same scope barrier as the
			// top-level path search: children stay unreachable until the mesh's
			// own editing scope is entered.
			if (isMesh(child) && !this.store.editingScopeStack.includes(child.id))
				continue;
			const nestedChildIds = getContainerChildIds(child);
			if (!nestedChildIds) continue;

			// Transform into this container's local coordinate space
			const { x: lx, y: ly } = this.toElementLocal(child, x, y);

			// Clip path rejection
			if (
				isGroup(child) &&
				child.clipPathId &&
				!this.isInsideClipPath(child.clipPathId!, lx, ly)
			) {
				continue;
			}

			const found = this.findPathInChildren(nestedChildIds, lx, ly, tolerance);
			if (found) return found;
		}
		return null;
	}

	/**
	 * Move a point from an element's parent space into the element's own,
	 * undoing the element's transform around its bounds-derived origin.
	 */
	private toElementLocal(
		element: AnyArtObject,
		x: LocalCoord,
		y: LocalCoord,
	): { x: LocalCoord; y: LocalCoord } {
		const t = getTransform(element);
		if (isIdentityTransform(t)) return { x, y };

		const localBounds = calculateLocalElementBounds(
			element,
			this.getElementsMapCached(),
			this.localBoundsCache,
		);
		const origin = computeTransformOrigin(localBounds);
		const local = inverseTransform(x, y, t, origin.x, origin.y);
		return { x: local.x as LocalCoord, y: local.y as LocalCoord };
	}

	/**
	 * Check if a point (in the clip group's local space — the space the clip
	 * path's geometry lives in, since clipPathId refers to one of the group's
	 * children) is inside the clip path shape.
	 */
	private isInsideClipPath(
		clipPathId: string,
		x: LocalCoord,
		y: LocalCoord,
	): boolean {
		const clipPath = this.store.document.objects[clipPathId];
		if (!clipPath || !isPath(clipPath)) return true;
		return this.isPointInsidePathShape(clipPath, x, y);
	}

	/**
	 * Point-in-fill test for a path, given a point in the path's *parent* space.
	 * Only the path's own transform is left to invert — callers have already
	 * removed the container's and every ancestor's.
	 */
	private isPointInsidePathShape(
		path: Path,
		x: LocalCoord,
		y: LocalCoord,
	): boolean {
		const t = getTransform(path);
		let cx: number = x;
		let cy: number = y;
		if (!isIdentityTransform(t)) {
			const localBounds = calculatePathBounds(this.resolveAppearance(path));
			const origin = computeTransformOrigin(localBounds);
			const local = inverseTransform(x, y, t, origin.x, origin.y);
			cx = local.x;
			cy = local.y;
		}
		return isPointInPath(cx, cy, path);
	}

	private findElement(elementId: string): AnyArtObject | null {
		return this.store.document.objects[elementId] ?? null;
	}

	/**
	 * Copy of `element` with appearance preset refs expanded (same reference
	 * when it has none), so bounds and hit tests see preset-provided strokes
	 * and fills.
	 */
	public resolveAppearance<T extends AnyArtObject>(element: T): T {
		return resolveElementAppearance(element, this.getPresetsMapCached());
	}

	private getPresetsMapCached(): AppearancePresetMap {
		const presets = this.store.document.appearancePresets;
		if (this.cachedPresetsRef !== presets) {
			this.cachedPresets = createAppearancePresetsMap(this.store.document);
			this.cachedPresetsRef = presets;
		}
		return this.cachedPresets;
	}

	/** Returns a cached Map of document.objects with preset refs resolved; rebuilt when objects or presets change. */
	private getElementsMapCached(): Map<string, AnyArtObject> {
		const objects = this.store.document.objects;
		const presets = this.getPresetsMapCached();
		if (
			this.cachedObjectsRef !== objects ||
			this.cachedPresetsRef !== this.store.document.appearancePresets ||
			!this.cachedElementsMap
		) {
			this.cachedElementsMap = new Map(
				Object.entries(objects).map(([id, el]) => [
					id,
					resolveElementAppearance(el, presets),
				]),
			);
			this.cachedObjectsRef = objects;
		}
		return this.cachedElementsMap;
	}

	private getOrCreateLayerQuadtree(layerId: string): Quadtree<AnyArtObject> {
		let quadtree = this.layerQuadtrees.get(layerId);
		if (!quadtree) {
			quadtree = new Quadtree<AnyArtObject>(WORLD_BOUNDS);
			this.layerQuadtrees.set(layerId, quadtree);
		}
		return quadtree;
	}

	private rebuildLayerIndex(layer: Layer, activeIds?: Set<string>): void {
		const quadtree = new Quadtree<AnyArtObject>(WORLD_BOUNDS);
		const elementsMap = this.getElementsMapCached();

		for (const elementId of layer.elementIds) {
			const element = this.store.document.objects[elementId];
			if (!element) continue;

			// Container descendants are not in the quadtree (only top-level
			// elements are), but their cached bounds must survive the
			// active-id sweep in rebuildAllIndices — otherwise grouped text
			// loses its preserved precise bounds on every rebuild.
			if (activeIds) {
				activeIds.add(element.id);
				addDescendantIds(element, this.store.document.objects, activeIds);
			}

			// Preserve any existing cached bounds (e.g. async-computed text bounds).
			const cached = this.boundsCache.get(element.id);
			const bounds =
				cached ??
				calculateElementBounds(
					this.resolveAppearance(element),
					elementsMap,
					this.localBoundsCache,
				);
			this.boundsCache.set(element.id, bounds);
			quadtree.insert({ id: element.id, data: element, bounds });
		}
		this.layerQuadtrees.set(layer.id, quadtree);
	}

	/**
	 * Rebuild parent group map for all elements in all layers.
	 * Use this after modifying container childIds to ensure hit-testing returns parent containers.
	 */
	public rebuildParentGroupMap(): void {
		this.parentGroupMap.clear();
		for (const element of Object.values(this.store.document.objects)) {
			const childIds = getContainerChildIds(element);
			if (!childIds) continue;
			for (const childId of childIds) {
				this.parentGroupMap.set(childId, element.id);
			}
		}
	}

	/** Update parentGroupMap entries for a specific container (clear old → add new). */
	public refreshContainerMappings(container: AnyArtObject): void {
		for (const [childId, parentId] of this.parentGroupMap) {
			if (parentId === container.id) this.parentGroupMap.delete(childId);
		}
		const childIds = getContainerChildIds(container);
		if (childIds) {
			for (const cid of childIds) this.parentGroupMap.set(cid, container.id);
		}
	}

	/** Remove all parentGroupMap entries for a deleted container. */
	public clearContainerMappings(container: AnyArtObject): void {
		const childIds = getContainerChildIds(container);
		if (childIds) {
			for (const cid of childIds) this.parentGroupMap.delete(cid);
		}
		this.parentGroupMap.delete(container.id);
	}

	/** Reconcile layer quadtrees with the given active layer IDs. */
	public syncLayerIndices(activeLayerIds: Set<string>): void {
		for (const id of activeLayerIds) {
			this.getOrCreateLayerQuadtree(id);
		}
		for (const id of this.layerQuadtrees.keys()) {
			if (!activeLayerIds.has(id)) this.layerQuadtrees.delete(id);
		}
	}

	/**
	 * Hit-test a path at a point, inverse-applying the path's own transform first
	 * so the point (given in the path's parent/local space) is mapped into the
	 * path's local segment space before testing.
	 */
	private isPointOnPathLocal(
		path: Path,
		x: LocalCoord,
		y: LocalCoord,
		tolerance: number,
	): boolean {
		const t = getTransform(path);
		if (isIdentityTransform(t))
			return isPointOnPath(x, y, this.resolveAppearance(path), tolerance);

		const localBounds = calculatePathBounds(this.resolveAppearance(path));
		const origin = computeTransformOrigin(localBounds);
		const local = inverseTransform(x, y, t, origin.x, origin.y);
		return isPointOnPath(
			local.x,
			local.y,
			this.resolveAppearance(path),
			tolerance,
		);
	}

	/** `x`/`y` are in the element's parent space (world for top-level elements). */
	private isPointOnElement(
		element: AnyArtObject,
		x: LocalCoord,
		y: LocalCoord,
		tolerance: number,
	): boolean {
		const t = getTransform(element);
		const hasTransform = !isIdentityTransform(t);

		if (isPath(element)) {
			return this.isPointOnPathLocal(element, x, y, tolerance);
		}

		// A repeat's instances are synthetic (only the sources live in
		// document.objects). Map the point back through every instance's placement
		// and test the source geometry, instead of the generic own-transform
		// inverse (which pivots around the local-bounds center, not the source
		// union center the repeat transform actually pivots around).
		if (isRepeat(element)) {
			return this.isPointOnRepeatInstances(element, x, y, tolerance);
		}

		let lx = x;
		let ly = y;
		if (hasTransform) {
			const localBounds = calculateLocalElementBounds(
				element,
				this.getElementsMapCached(),
				this.localBoundsCache,
			);
			const origin = computeTransformOrigin(localBounds);
			const local = inverseTransform(x, y, t, origin.x, origin.y);
			lx = local.x;
			ly = local.y;
		}
		return this.isPointOnElementLocal(element, lx, ly, tolerance);
	}

	/**
	 * Mesh warp container hit test: invert the Coons warp to recover the
	 * source-space point (null when the point is outside every deformed face),
	 * then recurse into the children exactly like a group — so hits land only
	 * where warped child content actually is.
	 */
	private isPointOnMeshLocal(
		element: MeshArtObject,
		x: LocalCoord,
		y: LocalCoord,
		tolerance: number,
	): boolean {
		const src = this.getMeshWarpInverse(element)({ x, y });
		if (!src) return false;
		return element.childIds.some((id) => {
			const child = this.store.document.objects[id];
			return (
				child != null &&
				isElementVisible(child) &&
				this.isPointOnElement(
					child,
					src.x as LocalCoord,
					src.y as LocalCoord,
					tolerance,
				)
			);
		});
	}

	/**
	 * Inverse warp per mesh, memoized on the cage geometry. Hit testing runs
	 * on every hover, and rebuilding the sampler each time re-resolves every
	 * face's effective boundary curves — the render side fingerprints its
	 * warp cache the same way.
	 */
	private getMeshWarpInverse(
		element: MeshArtObject,
	): ReturnType<typeof createMeshWarpInverse> {
		const fingerprint = JSON.stringify({
			vertices: element.vertices,
			faces: element.faces,
		});
		const cached = this.meshInverseCache.get(element.id);
		if (cached?.fingerprint === fingerprint) return cached.inverse;
		const inverse = createMeshWarpInverse(element.vertices, element.faces);
		this.meshInverseCache.set(element.id, { fingerprint, inverse });
		return inverse;
	}

	/** `x`/`y` are in the element's own local (pre-own-transform) space. */
	private isPointOnElementLocal(
		element: AnyArtObject,
		x: LocalCoord,
		y: LocalCoord,
		tolerance: number,
	): boolean {
		if (isPath(element)) {
			return isPointOnPath(x, y, this.resolveAppearance(element), tolerance);
		}

		if (isMesh(element)) {
			return this.isPointOnMeshLocal(element, x, y, tolerance);
		}

		// Axis-bound texts hit on their path + glyph ink, not the whole AABB
		if (element.type === "text" && element.axisBinding && this.textHitTester) {
			const hit = this.textHitTester(element, x, y, tolerance);
			if (hit !== null) return hit;
		}

		if (isContainer(element)) {
			const childIds = getContainerChildIds(element);
			if (!childIds || childIds.length === 0) return false;

			// If this is a clip group, reject points outside the clip path shape
			if (
				isGroup(element) &&
				element.clipPathId &&
				!this.isInsideClipPath(element.clipPathId!, x, y)
			) {
				return false;
			}

			const hitChild = childIds.some((id) => {
				const child = this.store.document.objects[id];
				return (
					child != null &&
					isElementVisible(child) &&
					this.isPointOnElement(child, x, y, tolerance)
				);
			});
			if (hitChild) return true;

			// A blend's keys/spine are baked at their stored positions (tested as
			// children above); its intermediates are synthetic (not in
			// document.objects), so test their geometry too.
			if (isBlend(element)) {
				return this.isPointOnBlendIntermediates(element, x, y, tolerance);
			}
			return false;
		}

		// Other non-path elements (ImageObject, TextElement, etc.): AABB test in
		// the element's local space — the box the renderer maps to the screen.
		// For identity transforms the parent-space cache equals the local box
		// and is the freshest source (setBounds writes only boundsCache).
		const bounds =
			(isIdentityTransform(getTransform(element))
				? this.boundsCache.get(element.id)
				: undefined) ??
			this.localBoundsCache.get(element.id) ??
			calculateLocalElementBounds(
				element,
				this.getElementsMapCached(),
				this.localBoundsCache,
			);
		return (
			x >= bounds.minX - tolerance &&
			x <= bounds.maxX + tolerance &&
			y >= bounds.minY - tolerance &&
			y <= bounds.maxY + tolerance
		);
	}

	/**
	 * Test the blend's synthetic intermediate shapes (same computation as the
	 * renderer). `lx`/`ly` are already in the blend's local space; the computed
	 * paths carry identity transforms with baked local-space segments. Keys/spine
	 * are tested separately as children (they are baked at their stored positions).
	 */
	private isPointOnBlendIntermediates(
		blend: BlendObject,
		lx: LocalCoord,
		ly: LocalCoord,
		tolerance: number,
	): boolean {
		const sources: Path[] = [];
		for (const id of blend.objectIds) {
			const el = this.store.document.objects[id];
			if (!el) continue;
			const resolved = resolveBlendSourcePath(
				el,
				(cid) => this.store.document.objects[cid],
			);
			if (resolved) sources.push(resolved);
		}
		if (sources.length < 2) return false;

		const spineSource = resolveBlendSpinePath(
			blend,
			(cid) => this.store.document.objects[cid],
		);

		for (const pair of computeBlendIntermediates(blend, sources, spineSource)) {
			for (const inter of pair) {
				if (isPointOnPath(lx, ly, inter, tolerance)) return true;
			}
		}
		return false;
	}

	/**
	 * Test every instance a repeat produces. `x`/`y` are in the repeat's parent
	 * space (world for a top-level repeat). For each instance the point is mapped
	 * back through the instance's full placement — the repeat's own transform
	 * (pivoted at the source union center) composed with the instance affine —
	 * into the sources' authored space, then hit-tested against the source
	 * geometry (isPointOnElement handles each source's own transform/fill).
	 */
	private isPointOnRepeatInstances(
		repeat: RepeatObject,
		x: LocalCoord,
		y: LocalCoord,
		tolerance: number,
	): boolean {
		const sourceUnion = calculateRepeatSourceUnion(
			repeat,
			this.getElementsMapCached(),
			this.localBoundsCache,
		);
		if (!sourceUnion) return false;

		const center = {
			x: (sourceUnion.minX + sourceUnion.maxX) / 2,
			y: (sourceUnion.minY + sourceUnion.maxY) / 2,
		};
		const outer = elementTransformToAffine(
			getTransform(repeat),
			center.x,
			center.y,
		);

		// Grid copies are clipped to the fill region, so a point outside it never
		// hits — even where an unclipped tile would still extend.
		if (repeat.mode === "grid") {
			const authored = inverseAffinePoint(outer, x, y);
			if (!authored) return false;
			const region = repeatGridRegion(repeat, sourceUnion);
			if (
				authored.x < region.minX ||
				authored.x > region.maxX ||
				authored.y < region.minY ||
				authored.y > region.maxY
			) {
				return false;
			}
		}

		for (const instance of computeRepeatInstances(repeat, center)) {
			const local = inverseAffinePoint(composeAffine(outer, instance), x, y);
			if (!local) continue;
			const lx = asLocalCoord(local.x);
			const ly = asLocalCoord(local.y);
			for (const id of repeat.sourceIds) {
				const source = this.store.document.objects[id];
				if (!source || !isElementVisible(source)) continue;
				if (this.isPointOnElement(source, lx, ly, tolerance)) return true;
			}
		}
		return false;
	}

	private isElementInRect(
		element: AnyArtObject,
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
	): boolean {
		const t = getTransform(element);
		const hasTransform = !isIdentityTransform(t);

		if (isPath(element)) {
			let rMinX = minX;
			let rMinY = minY;
			let rMaxX = maxX;
			let rMaxY = maxY;
			if (hasTransform) {
				const localBounds = calculatePathBounds(
					this.resolveAppearance(element),
				);
				const origin = computeTransformOrigin(localBounds);
				const tl = inverseTransform(minX, minY, t, origin.x, origin.y);
				const br = inverseTransform(maxX, maxY, t, origin.x, origin.y);
				const tr = inverseTransform(maxX, minY, t, origin.x, origin.y);
				const bl = inverseTransform(minX, maxY, t, origin.x, origin.y);
				rMinX = Math.min(tl.x, br.x, tr.x, bl.x);
				rMinY = Math.min(tl.y, br.y, tr.y, bl.y);
				rMaxX = Math.max(tl.x, br.x, tr.x, bl.x);
				rMaxY = Math.max(tl.y, br.y, tr.y, bl.y);
			}
			return doesPathIntersectRect(
				this.resolveAppearance(element),
				rMinX,
				rMinY,
				rMaxX,
				rMaxY,
			);
		}

		if (isContainer(element)) {
			const childIds = getContainerChildIds(element);
			if (!childIds || childIds.length === 0) return false;

			let rMinX = minX;
			let rMinY = minY;
			let rMaxX = maxX;
			let rMaxY = maxY;
			if (hasTransform) {
				const localBounds = calculateLocalElementBounds(
					element,
					this.getElementsMapCached(),
					this.localBoundsCache,
				);
				const origin = computeTransformOrigin(localBounds);
				const tl = inverseTransform(minX, minY, t, origin.x, origin.y);
				const br = inverseTransform(maxX, maxY, t, origin.x, origin.y);
				const tr = inverseTransform(maxX, minY, t, origin.x, origin.y);
				const bl = inverseTransform(minX, maxY, t, origin.x, origin.y);
				rMinX = Math.min(tl.x, br.x, tr.x, bl.x);
				rMinY = Math.min(tl.y, br.y, tr.y, bl.y);
				rMaxX = Math.max(tl.x, br.x, tr.x, bl.x);
				rMaxY = Math.max(tl.y, br.y, tr.y, bl.y);
			}

			return childIds.some((id) => {
				const child = this.store.document.objects[id];
				return (
					child != null &&
					isElementVisible(child) &&
					this.isElementInRect(child, rMinX, rMinY, rMaxX, rMaxY)
				);
			});
		}

		// Other elements (ImageObject, TextElement): AABB is accurate
		return true;
	}
}

function addDescendantIds(
	element: AnyArtObject,
	objects: Record<string, AnyArtObject>,
	out: Set<string>,
): void {
	const childIds = getContainerChildIds(element);
	if (!childIds) return;
	for (const childId of childIds) {
		const child = objects[childId];
		if (!child || out.has(childId)) continue;
		out.add(childId);
		addDescendantIds(child, objects, out);
	}
}

function isElementVisible(element: AnyArtObject): boolean {
	return element.visible !== false;
}

/** Map a point through the inverse of an affine, or null when non-invertible. */
function inverseAffinePoint(
	m: Affine2D,
	x: number,
	y: number,
): { x: number; y: number } | null {
	const det = m.a * m.d - m.b * m.c;
	if (Math.abs(det) < 1e-12) return null;
	const dx = x - m.e;
	const dy = y - m.f;
	return {
		x: (m.d * dx - m.c * dy) / det,
		y: (-m.b * dx + m.a * dy) / det,
	};
}

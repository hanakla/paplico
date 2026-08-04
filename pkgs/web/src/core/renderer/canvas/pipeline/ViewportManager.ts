import {
	type AnyArtObject,
	type BoundingBox,
	type ElementTransform,
	getTransform,
	isBlend,
	isGroup,
	isMesh,
	isRepeat,
	type Viewport,
} from "../../../schema";
import {
	calculateLocalElementBounds,
	type LocalBoundsCache,
} from "../../../utils/geometry/bounds";
import {
	composeTransforms,
	GPU_TRANSFORM_VALUES,
	getVisibleWorldBounds,
	IDENTITY_GPU_TRANSFORM,
	MASK_INVERT_BIT,
	NO_MASK_INDEX,
	transformLinearMatrix,
	writeGPUTransform,
} from "../../../utils/geometry/geometry";
import type { StructuredView } from "../../../utils/wgpu-utils";
import type { ChangedElements } from "../../types";
import type { ViewportState } from "../CanvasLayerTypes";

/**
 * The part of a mask atlas entry the transforms buffer carries to the shader.
 * `ClipMaskAtlas.MaskEntry` satisfies this structurally.
 */
export interface GPUMaskInfo {
	layerIndex: number;
	/** World-space area the mask texture covers. */
	bounds: BoundingBox;
	/** Default: false. Swaps which side of the mask keeps the pixels. */
	inverted?: boolean;
}

/**
 * Manages the viewport GPU uniform buffer (viewportX/Y, zoom, canvasWidth/
 * Height, rotSin/rotCos), the per-element transform GPU storage buffer, and
 * a pre-computed viewport bounds cache for culling.
 *
 * The viewport uniform and bounds cache are tightly coupled (a viewport
 * change invalidates the cached visible-world bounds). The transform buffer
 * is co-located here because it shares the element bounds cache with the
 * frame plan: `updateTransformsBuffer` computes and caches local element
 * bounds that `RenderPlanner.buildFramePlanStructure` reuses via
 * `getBoundsCache()`,
 * avoiding double computation. Element transforms themselves are stored in
 * world space and do NOT depend on viewport parameters.
 */
export class ViewportManager {
	private device: GPUDevice;
	private _viewportState: ViewportState = {
		current: null,
		width: 0,
		height: 0,
		bounds: null,
	};
	private viewportUniformView: StructuredView;
	private _uniformBuffer: GPUBuffer;
	private transformsBindGroupLayout: GPUBindGroupLayout;
	private transformsBuffer: GPUBuffer | null = null;
	private _transformsBindGroup: GPUBindGroup | null = null;
	private transformsBufferSize = 0;
	/** Maps element ID to its index in the transforms Storage Buffer.
	 *  Assignments are STABLE across rebuilds: an element keeps its slot until
	 *  it is deleted (freed slots are recycled), so entry caches that
	 *  fingerprint a transformIndex survive unrelated document edits. */
	private transformIndexMap: Map<string, number> = new Map();
	/** Slots released by deleted elements, reused before growing the tail. */
	private freeSlots: number[] = [];
	/** Slots held by non-element ids (mesh warp transients carrying a mask). */
	private auxiliaryMaskIds = new Set<string>();
	/** Next never-assigned slot. Slot 0 is the identity entry. */
	private nextSlot = 1;
	/**
	 * "none": buffer is up to date. "partial": only partialDirtyIds (plus
	 * their ancestors/descendants) need recomposing. "full": rebuild every
	 * element. Starts "full" so the first call always builds the buffer.
	 */
	private transformsDirty: "none" | "partial" | "full" = "full";
	/** Element ids accumulated by markElementTransformsDirty. */
	private partialDirtyIds = new Set<string>();
	/**
	 * Caches raw element bounds (before transform) by element ID.
	 * Cleared when transforms are marked dirty. Used by both
	 * updateTransformsBuffer and RenderPlanner (via getBoundsCache).
	 */
	private boundsCache: LocalBoundsCache = new Map();
	/** Cached child→parent group mapping, rebuilt when dirty. */
	private parentGroupMap: Map<string, string> = new Map();
	/** True when any Group element has a clipPathId set. */
	private _hasClipGroups = false;
	private _hasObjectMasks = false;
	/** Pre-allocated CPU buffer for transform data. Reused across frames. */
	private cachedBuffer: ArrayBuffer | null = null;
	private cachedF32: Float32Array | null = null;
	private cachedU32: Uint32Array | null = null;
	/** Composed (world-space) transform per element, populated by updateTransformsBuffer. */
	private _composedTransformCache: Map<string, ElementTransform> = new Map();

	public constructor(
		device: GPUDevice,
		uniformBuffer: GPUBuffer,
		viewportUniformView: StructuredView,
		transformsBindGroupLayout: GPUBindGroupLayout,
	) {
		this.device = device;
		this._uniformBuffer = uniformBuffer;
		this.viewportUniformView = viewportUniformView;
		this.transformsBindGroupLayout = transformsBindGroupLayout;
	}

	public get viewportState(): ViewportState {
		return this._viewportState;
	}

	public get transformsBindGroup(): GPUBindGroup | null {
		return this._transformsBindGroup;
	}

	/** The raw transforms storage buffer, for passes that read it outside the
	 *  render pipeline's bind group (the mix pass resolves dab world positions
	 *  in a compute shader). */
	public get transformsStorageBuffer(): GPUBuffer | null {
		return this.transformsBuffer;
	}

	public get uniformBuffer(): GPUBuffer {
		return this._uniformBuffer;
	}

	public getTransformIndex(elementId: string): number {
		return this.transformIndexMap.get(elementId) ?? 0;
	}

	/**
	 * Mark the transforms buffer as stale so it will be rebuilt on the next
	 * updateTransformsBuffer call.  Call this when element data changes
	 * (transform, geometry, add/remove, group structure).
	 * Viewport-only changes (pan/zoom) do NOT need to call this because
	 * element transforms are stored in world space.
	 */
	public markTransformsDirty(clearBoundsCache = true): void {
		this.transformsDirty = "full";
		this.partialDirtyIds.clear();
		this._composedTransformCache.clear();
		this.parentGroupMap.clear();
		if (clearBoundsCache) {
			this.boundsCache.clear();
		}
	}

	/**
	 * Mark only the given changed element ids stale. The next
	 * updateTransformsBuffer call recomposes just those elements — plus their
	 * ancestor groups (whose bounds-derived origins aggregate them) and, for
	 * changed groups, their descendants (whose composed transforms inherit
	 * them) — and uploads the touched slot range, instead of rebuilding and
	 * re-uploading every element. A pending full invalidation always wins.
	 */
	public markElementTransformsDirty(changes: ChangedElements): void {
		if (this.transformsDirty === "full") return;
		this.transformsDirty = "partial";
		for (const id of changes.upserted) this.partialDirtyIds.add(id);
		for (const id of changes.deleted) this.partialDirtyIds.add(id);
	}

	/**
	 * Evict cached local bounds for specific elements (and their ancestor
	 * groups, whose bounds aggregate them) and mark transforms stale.
	 * Use when an element's geometry changes under the same id — e.g. a
	 * tool preview override swaps in new segments — so the GPU transform
	 * origin and every bounds consumer recompute from the live geometry
	 * instead of the pre-edit cache. Cheaper than a full boundsCache clear
	 * when only a few elements changed.
	 *
	 * @returns every evicted id (the given ids plus their ancestors) —
	 * world-bounds consumers must treat these as stale too.
	 */
	public invalidateElementBounds(ids: Iterable<string>): ReadonlySet<string> {
		const evicted = new Set<string>();
		for (const id of ids) {
			let current: string | undefined = id;
			while (current !== undefined && !evicted.has(current)) {
				evicted.add(current);
				this.boundsCache.delete(current);
				current = this.parentGroupMap.get(current);
			}
		}
		if (evicted.size > 0) {
			this.markTransformsDirty(false);
		}
		return evicted;
	}

	/**
	 * Expose the bounds cache so RenderPlanner can reuse precomputed bounds
	 * instead of recalculating them (avoids double bounds computation).
	 */
	public getBoundsCache(): LocalBoundsCache {
		return this.boundsCache;
	}

	/**
	 * Expose the cached child→parent group mapping so callers that need
	 * ancestor traversal (e.g. collectClipGroups) can reuse it instead
	 * of rebuilding from scratch.  The map is populated lazily by
	 * updateTransformsBuffer and cleared when transforms are dirty.
	 */
	public getParentGroupMap(): ReadonlyMap<string, string> {
		return this.parentGroupMap;
	}

	public getComposedTransformCache(): ReadonlyMap<string, ElementTransform> {
		return this._composedTransformCache;
	}

	/** True when any element in the current document carries an ArtObject.mask. */
	public get hasObjectMasks(): boolean {
		return this._hasObjectMasks;
	}

	/** True when any Group element in the current document has a clipPathId. */
	public get hasClipGroups(): boolean {
		return this._hasClipGroups;
	}

	/**
	 * Update both viewportState and the GPU uniform buffer atomically.
	 * Use this when the viewport change should be reflected in subsequent
	 * rendering AND in state queries (e.g. bounds culling).
	 */
	public setViewportUniforms(
		viewport: Viewport,
		width: number,
		height: number,
	): void {
		const vp: Viewport = {
			x: viewport.x,
			y: viewport.y,
			zoom: viewport.zoom,
			rotation: viewport.rotation ?? 0,
		};
		this._viewportState.current = vp;
		this._viewportState.width = width;
		this._viewportState.height = height;
		this.writeViewportUniformsToGPU(vp, width, height);
	}

	/**
	 * Write viewport parameters to the GPU uniform buffer WITHOUT updating
	 * viewportState.  Use this for temporary viewport overrides where the
	 * logical state must remain unchanged (offscreen passes, rotation-free
	 * blits).
	 */
	public writeViewportUniformsToGPU(
		viewport: Viewport,
		width: number,
		height: number,
	): void {
		this.viewportUniformView.set({
			viewportX: viewport.x,
			viewportY: viewport.y,
			zoom: viewport.zoom,
			canvasWidth: width,
			canvasHeight: height,
			rotSin: -Math.sin(viewport.rotation),
			rotCos: Math.cos(viewport.rotation),
		});
		this.device.queue.writeBuffer(
			this._uniformBuffer,
			0,
			this.viewportUniformView.arrayBuffer,
		);
	}

	/** Re-sync the GPU uniform buffer to match the current viewportState. */
	public restoreViewportUniformsToGPU(): void {
		if (this._viewportState.current) {
			this.writeViewportUniformsToGPU(
				this._viewportState.current,
				this._viewportState.width,
				this._viewportState.height,
			);
		}
	}

	/** Recompute cached viewport bounds from current viewport / canvas dimensions. */
	public updateViewportBoundsCache(): void {
		if (
			this._viewportState.current &&
			this._viewportState.width > 0 &&
			this._viewportState.height > 0
		) {
			const vb = getVisibleWorldBounds(
				this._viewportState.current,
				this._viewportState.width,
				this._viewportState.height,
			);
			this._viewportState.bounds = {
				minX: vb.left,
				minY: vb.bottom,
				maxX: vb.right,
				maxY: vb.top,
				width: vb.width,
				height: vb.height,
			};
		} else {
			this._viewportState.bounds = null;
		}
	}

	/**
	 * Build per-element transform data and upload to the GPU Storage Buffer.
	 * Index 0 is always identity (used for preview paths and fallbacks).
	 * Each subsequent index corresponds to an element in elementsMap.
	 * The mapping from element ID → buffer index is stored in transformIndexMap.
	 *
	 * Optimized to write directly to a pre-allocated Float32Array, avoiding
	 * intermediate GPUElementTransform object allocations and reducing GC pressure.
	 */
	public updateTransformsBuffer(
		elementsMap: Map<string, AnyArtObject>,
		maskMap?: ReadonlyMap<string, GPUMaskInfo>,
	): void {
		if (this.transformsDirty === "none" && this.transformsBuffer) return;

		if (
			this.transformsDirty === "partial" &&
			this.transformsBuffer &&
			this.cachedF32 &&
			!maskMap
		) {
			if (this.tryPartialTransformsUpdate(elementsMap)) {
				this.transformsDirty = "none";
				this.partialDirtyIds.clear();
				return;
			}
			// The partial attempt may have synced parentGroupMap halfway before
			// bailing — rebuild both derived maps from scratch below.
			this.parentGroupMap.clear();
			this._composedTransformCache.clear();
		}

		this.transformsDirty = "none";
		this.partialDirtyIds.clear();

		if (this.parentGroupMap.size === 0) {
			this._hasClipGroups = false;
			this._hasObjectMasks = false;
			for (const [, element] of elementsMap) {
				if (isGroup(element) && element.clipPathId != null) {
					this._hasClipGroups = true;
				}
				if (element.mask?.elementIds.length) this._hasObjectMasks = true;
				const children = parentedChildIds(element);
				if (!children) continue;
				for (const childId of children) {
					this.parentGroupMap.set(childId, element.id);
				}
			}
		}
		const parentGroupMap = this.parentGroupMap;

		// Release slots of deleted elements; keep every survivor's slot stable.
		// After mass deletions (over half the slots free) compact the
		// assignment — fingerprinting caches self-invalidate and regenerate.
		for (const [id, slot] of this.transformIndexMap) {
			// Auxiliary ids are not document elements; their lifetime is owned by
			// reserveAuxiliaryMaskSlots.
			if (!elementsMap.has(id) && !this.auxiliaryMaskIds.has(id)) {
				this.transformIndexMap.delete(id);
				this.freeSlots.push(slot);
			}
		}
		if (this.freeSlots.length > this.transformIndexMap.size) {
			this.transformIndexMap.clear();
			this.auxiliaryMaskIds.clear();
			this.freeSlots.length = 0;
			this.nextSlot = 1;
		}
		for (const id of elementsMap.keys()) {
			if (!this.transformIndexMap.has(id)) {
				this.transformIndexMap.set(id, this.freeSlots.pop() ?? this.nextSlot++);
			}
		}

		const entryCount = this.nextSlot;
		const valueCount = entryCount * GPU_TRANSFORM_VALUES;

		// Reuse the pre-allocated CPU mirror; grow with 25% slack so a few
		// subsequently added elements still fit the partial-update path.
		if (
			!this.cachedF32 ||
			!this.cachedU32 ||
			this.cachedF32.length < valueCount
		) {
			const slackValues =
				Math.ceil((entryCount * 5) / 4) * GPU_TRANSFORM_VALUES;
			this.cachedBuffer = new ArrayBuffer(slackValues * 4);
			this.cachedF32 = new Float32Array(this.cachedBuffer);
			this.cachedU32 = new Uint32Array(this.cachedBuffer);
		}
		const f32 = this.cachedF32;
		const u32 = this.cachedU32;

		// Index 0 = identity
		writeGPUTransform(f32, 0, IDENTITY_GPU_TRANSFORM, u32);

		const composedCache = this._composedTransformCache;
		composedCache.clear();

		for (const [id, element] of elementsMap) {
			let t = getTransform(element);
			const parentId = parentGroupMap.get(id);
			if (parentId) {
				const cachedParent = composedCache.get(parentId);
				if (cachedParent) {
					t = composeTransforms(cachedParent, t);
				} else {
					let ancestorId: string | undefined = parentId;
					while (ancestorId) {
						const ancestor = elementsMap.get(ancestorId);
						if (ancestor) {
							t = composeTransforms(getTransform(ancestor), t);
						}
						ancestorId = parentGroupMap.get(ancestorId);
					}
				}
			}
			composedCache.set(id, t);

			let localBounds = this.boundsCache.get(id);
			if (!localBounds) {
				localBounds = calculateLocalElementBounds(
					element,
					elementsMap,
					this.boundsCache,
				);
				this.boundsCache.set(id, localBounds);
			}

			this.writeTransformAt(
				this.transformIndexMap.get(id)!,
				t,
				localBounds,
				maskMap?.get(id),
			);
		}

		const dataBytes = entryCount * GPU_TRANSFORM_VALUES * 4;

		if (!this.transformsBuffer || this.transformsBufferSize < dataBytes) {
			this.transformsBuffer?.destroy();
			// Same slack capacity as the CPU mirror so both agree on how many
			// added elements the partial path can absorb before growing.
			const capacityBytes = this.cachedF32.length * 4;
			this.transformsBuffer = this.device.createBuffer({
				label: "Element Transforms Storage Buffer",
				size: capacityBytes,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
			this.transformsBufferSize = capacityBytes;
			this._transformsBindGroup = this.device.createBindGroup({
				label: "Transforms Bind Group",
				layout: this.transformsBindGroupLayout,
				entries: [{ binding: 0, resource: { buffer: this.transformsBuffer } }],
			});
		}

		this.device.queue.writeBuffer(
			this.transformsBuffer,
			0,
			f32.buffer,
			0,
			dataBytes,
		);
	}

	/**
	 * Recompose only the dirty elements — expanded to ancestors (their
	 * bounds-derived origins aggregate descendants) and, for dirty groups,
	 * descendants (their composed transforms inherit ancestors) — then upload
	 * the touched slot range. Returns false when the change set requires the
	 * full rebuild instead: a blend/compound-path derives its bounds from a
	 * dirty id (no reverse index exists here), or new elements exceed the
	 * allocated capacity.
	 */
	private tryPartialTransformsUpdate(
		elementsMap: Map<string, AnyArtObject>,
	): boolean {
		const dirty = this.partialDirtyIds;
		// A tracked-but-empty change set (e.g. a delta-echo frame): nothing to do.
		if (dirty.size === 0) return true;

		// Bail when an element with derived bounds references a dirty id — its
		// origin shifts without itself being marked. Recompute hasClipGroups on
		// the same walk (a dirty group may have gained/lost its clipPathId).
		let hasClipGroups = false;
		let hasObjectMasks = false;
		for (const element of elementsMap.values()) {
			if (element.mask?.elementIds.length) hasObjectMasks = true;
			if (isGroup(element)) {
				if (element.clipPathId != null) hasClipGroups = true;
			} else if (isBlend(element)) {
				if (
					element.objectIds.some((id) => dirty.has(id)) ||
					(element.spineSourceId != null && dirty.has(element.spineSourceId))
				) {
					return false;
				}
			} else if (element.type === "compound-path") {
				if (element.sources.some((source) => dirty.has(source.id))) {
					return false;
				}
			} else if (isRepeat(element)) {
				// A repeat's bounds-derived origin aggregates its sources, so a moved
				// source shifts it without the repeat itself being marked dirty.
				if (element.sourceIds.some((id) => dirty.has(id))) {
					return false;
				}
			}
		}

		const affected = new Set<string>(dirty);

		// Sync parentGroupMap for dirty/deleted parents. Children that left a
		// group (or joined one) change their composed transforms too, as does
		// mask content moving between owners.
		//
		// Plain elements skip the scan below, which means an owner that keeps
		// existing while its mask is cleared would leave stale edges behind.
		// Clearing a mask always deletes its content (see
		// PaplicoCommands.removeMaskFromElement), and deleted ids drop their own
		// edge in the loop further down, so that combination does not arise.
		for (const id of dirty) {
			const element = elementsMap.get(id);
			const currentChildren =
				element != null ? parentedChildIds(element) : null;
			if (element != null && !currentChildren) continue;
			const currentChildSet = currentChildren ? new Set(currentChildren) : null;
			for (const [childId, parentId] of this.parentGroupMap) {
				if (parentId !== id) continue;
				if (currentChildSet?.has(childId)) continue;
				this.parentGroupMap.delete(childId);
				affected.add(childId);
			}
			if (!currentChildren) continue;
			for (const childId of currentChildren) {
				if (this.parentGroupMap.get(childId) !== id) {
					this.parentGroupMap.set(childId, id);
					affected.add(childId);
				}
			}
		}

		// Descendants of affected parents inherit their composed transforms.
		const stack = [...affected];
		while (stack.length > 0) {
			const id = stack.pop()!;
			const element = elementsMap.get(id);
			const children = element != null ? parentedChildIds(element) : null;
			if (!children) continue;
			for (const childId of children) {
				if (affected.has(childId)) continue;
				affected.add(childId);
				stack.push(childId);
			}
		}

		// Ancestors: a group's origin is its local bounds' centre, which
		// aggregates every descendant, so changes below bubble up. Their
		// composed transforms are untouched (composition ignores origins), so
		// their own descendants need no further expansion.
		for (const id of [...affected]) {
			let parentId = this.parentGroupMap.get(id);
			while (parentId != null && !affected.has(parentId)) {
				affected.add(parentId);
				parentId = this.parentGroupMap.get(parentId);
			}
		}

		// New elements must fit the existing buffers; growing is the full
		// path's job.
		const capacityEntries = Math.min(
			Math.floor(this.cachedF32!.length / GPU_TRANSFORM_VALUES),
			Math.floor(this.transformsBufferSize / (GPU_TRANSFORM_VALUES * 4)),
		);
		let newCount = 0;
		for (const id of affected) {
			if (elementsMap.has(id) && !this.transformIndexMap.has(id)) newCount++;
		}
		if (
			this.nextSlot + Math.max(0, newCount - this.freeSlots.length) >
			capacityEntries
		) {
			return false;
		}

		this._hasClipGroups = hasClipGroups;
		this._hasObjectMasks = hasObjectMasks;

		// Evict stale local bounds so origins recompute from live geometry.
		for (const id of affected) this.boundsCache.delete(id);

		let minSlot = Number.MAX_SAFE_INTEGER;
		let maxSlot = -1;
		for (const id of affected) {
			const element = elementsMap.get(id);
			if (element == null) {
				const slot = this.transformIndexMap.get(id);
				if (slot !== undefined) {
					this.transformIndexMap.delete(id);
					this.freeSlots.push(slot);
				}
				this._composedTransformCache.delete(id);
				this.parentGroupMap.delete(id);
				continue;
			}
			let slot = this.transformIndexMap.get(id);
			if (slot === undefined) {
				slot = this.freeSlots.pop() ?? this.nextSlot++;
				this.transformIndexMap.set(id, slot);
			}

			// Walk the ancestor chain directly: affected entries in the composed
			// cache are stale until rewritten here, and the set's iteration
			// order gives no parent-before-child guarantee.
			let t = getTransform(element);
			let ancestorId = this.parentGroupMap.get(id);
			while (ancestorId != null) {
				const ancestor = elementsMap.get(ancestorId);
				if (ancestor) t = composeTransforms(getTransform(ancestor), t);
				ancestorId = this.parentGroupMap.get(ancestorId);
			}
			this._composedTransformCache.set(id, t);

			let localBounds = this.boundsCache.get(id);
			if (!localBounds) {
				localBounds = calculateLocalElementBounds(
					element,
					elementsMap,
					this.boundsCache,
				);
				this.boundsCache.set(id, localBounds);
			}

			// Mask fields reset to NO_MASK, matching the full rebuild —
			// applyClipMasks re-writes them via writeMaskInfoOnly afterwards.
			this.writeTransformAt(slot, t, localBounds, undefined);
			if (slot < minSlot) minSlot = slot;
			if (slot > maxSlot) maxSlot = slot;
		}

		if (maxSlot >= 0) {
			const byteOffset = minSlot * GPU_TRANSFORM_VALUES * 4;
			const byteLength = (maxSlot - minSlot + 1) * GPU_TRANSFORM_VALUES * 4;
			this.device.queue.writeBuffer(
				this.transformsBuffer!,
				byteOffset,
				this.cachedF32!.buffer,
				byteOffset,
				byteLength,
			);
		}
		return true;
	}

	/** Write one element's GPU transform entry into the CPU mirror at `slot`.
	 *  Writes typed-array fields directly (no per-element object allocation). */
	private writeTransformAt(
		slot: number,
		t: ElementTransform,
		localBounds: { minX: number; minY: number; maxX: number; maxY: number },
		mask: GPUMaskInfo | undefined,
	): void {
		const f32 = this.cachedF32!;
		const u32 = this.cachedU32!;
		const originX = (localBounds.minX + localBounds.maxX) / 2;
		const originY = (localBounds.minY + localBounds.maxY) / 2;
		const offset = slot * GPU_TRANSFORM_VALUES;

		f32[offset] = t.x;
		f32[offset + 1] = t.y;
		f32[offset + 2] = originX;
		f32[offset + 3] = originY;
		// Row-major 2×2 linear part (rotation · shear · scale); the fast path
		// inside transformLinearMatrix skips trig for the common unskewed case.
		const m = transformLinearMatrix(t);
		f32[offset + 4] = m.m00;
		f32[offset + 5] = m.m01;
		f32[offset + 6] = m.m10;
		f32[offset + 7] = m.m11;

		if (mask) {
			u32[offset + 8] = maskIndexWord(mask);
			u32[offset + 9] = 0;
			f32[offset + 10] = mask.bounds.minX;
			f32[offset + 11] = mask.bounds.minY;
			f32[offset + 12] = mask.bounds.maxX;
			f32[offset + 13] = mask.bounds.maxY;
		} else {
			u32[offset + 8] = NO_MASK_INDEX;
			u32[offset + 9] = 0;
			f32[offset + 10] = 0;
			f32[offset + 11] = 0;
			f32[offset + 12] = 0;
			f32[offset + 13] = 0;
		}
	}

	/**
	 * Reserve transform slots for ids that are not document elements — mesh warp
	 * transients, which are normally drawn under their container's slot. A clip
	 * mask is stored per slot, so a masked transient needs one of its own (the
	 * shared identity slot 0 would leak the mask onto everything else). Each
	 * slot copies its container's transform, since that is what the transient
	 * would otherwise have been drawn with.
	 *
	 * Call before writeMaskInfoOnly; ids absent from `entries` release theirs.
	 */
	public reserveAuxiliaryMaskSlots(
		entries: ReadonlyArray<{ id: string; inheritFromId: string }>,
	): void {
		const wanted = new Set(entries.map((entry) => entry.id));
		for (const id of this.auxiliaryMaskIds) {
			if (wanted.has(id)) continue;
			const slot = this.transformIndexMap.get(id);
			if (slot !== undefined) {
				this.transformIndexMap.delete(id);
				this.freeSlots.push(slot);
			}
			this.auxiliaryMaskIds.delete(id);
		}
		for (const id of wanted) {
			if (this.transformIndexMap.has(id)) continue;
			this.transformIndexMap.set(id, this.freeSlots.pop() ?? this.nextSlot++);
			this.auxiliaryMaskIds.add(id);
		}
		if (entries.length === 0 || !this.cachedF32 || !this.cachedU32) return;

		// The mirror may predate these slots; grow it before writing.
		const valueCount = this.nextSlot * GPU_TRANSFORM_VALUES;
		if (this.cachedF32.length < valueCount) {
			const grown = new ArrayBuffer(valueCount * 4);
			new Float32Array(grown).set(this.cachedF32);
			this.cachedBuffer = grown;
			this.cachedF32 = new Float32Array(grown);
			this.cachedU32 = new Uint32Array(grown);
		}
		// The GPU buffer was sized during updateTransformsBuffer, before these
		// slots existed. Rebuild it next frame when they no longer fit, and let
		// writeMaskInfoOnly clamp this frame's upload to what is allocated.
		if (this.nextSlot * GPU_TRANSFORM_VALUES * 4 > this.transformsBufferSize) {
			this.transformsDirty = "full";
		}
		for (const { id, inheritFromId } of entries) {
			const slot = this.transformIndexMap.get(id);
			const sourceSlot = this.transformIndexMap.get(inheritFromId);
			if (slot === undefined) continue;
			const offset = slot * GPU_TRANSFORM_VALUES;
			if (sourceSlot === undefined) {
				writeGPUTransform(
					this.cachedF32,
					offset,
					IDENTITY_GPU_TRANSFORM,
					this.cachedU32,
				);
				continue;
			}
			const from = sourceSlot * GPU_TRANSFORM_VALUES;
			// Transform fields only (0..7); the mask fields (8..13) follow from
			// writeMaskInfoOnly.
			for (let i = 0; i < 8; i++) {
				this.cachedF32[offset + i] = this.cachedF32[from + i];
			}
		}
	}

	/**
	 * Write only clip-mask fields to the GPU transforms buffer.
	 * Assumes the buffer was already populated by a prior updateTransformsBuffer call.
	 * Avoids full CPU-side transform recomputation — only mask info (offset+8..+13)
	 * is updated for masked elements, then the affected bytes are uploaded.
	 */
	public writeMaskInfoOnly(maskMap: ReadonlyMap<string, GPUMaskInfo>): void {
		if (!this.transformsBuffer || !this.cachedF32 || !this.cachedU32) return;
		if (maskMap.size === 0) return;

		const f32 = this.cachedF32;
		const u32 = this.cachedU32;

		for (const [id, mask] of maskMap) {
			const idx = this.transformIndexMap.get(id);
			if (idx === undefined) continue;

			const offset = idx * GPU_TRANSFORM_VALUES;
			u32[offset + 8] = maskIndexWord(mask);
			u32[offset + 9] = 0;
			f32[offset + 10] = mask.bounds.minX;
			f32[offset + 11] = mask.bounds.minY;
			f32[offset + 12] = mask.bounds.maxX;
			f32[offset + 13] = mask.bounds.maxY;
		}

		// Slots may be sparse (freed slots persist between compactions), so the
		// populated range is bounded by the next never-assigned slot — capped at
		// what the GPU buffer actually holds (auxiliary slots can be reserved
		// after it was sized; the rebuild they request lands next frame).
		const dataBytes = Math.min(
			this.nextSlot * GPU_TRANSFORM_VALUES * 4,
			this.transformsBufferSize,
		);
		this.device.queue.writeBuffer(
			this.transformsBuffer,
			0,
			f32.buffer,
			0,
			dataBytes,
		);
	}

	public destroy(): void {
		this.transformsBuffer?.destroy();
		this.transformsBuffer = null;
		this._transformsBindGroup = null;
	}
}

/** Pack a mask entry into the `maskIndex` word the shader reads. */
function maskIndexWord(mask: GPUMaskInfo): number {
	return mask.inverted
		? (mask.layerIndex | MASK_INVERT_BIT) >>> 0
		: mask.layerIndex;
}

/**
 * Ids whose composed transform is parented to `element`: a group's children,
 * plus object-mask content. Mask elements are stored in owner-local space so
 * the mask follows the element it hides, and they keep composing through the
 * owner even while a mask-edit session has them sitting on a transient layer
 * (this map is derived from the reference, not from layer membership).
 *
 * Returns null when the element parents nothing, so callers can skip work.
 */
function parentedChildIds(element: AnyArtObject): readonly string[] | null {
	const maskIds = element.mask?.elementIds;
	// A mesh container holds its children in its own space just as a group
	// does — their stored coordinates are what the cage is built around.
	const childIds =
		isGroup(element) || isMesh(element) ? element.childIds : undefined;
	if (!childIds) return maskIds?.length ? maskIds : null;
	return maskIds?.length ? [...childIds, ...maskIds] : childIds;
}

/**
 * ClipMaskAtlas — Pre-renders clip masks into individual texture_2d textures.
 *
 * At frame start, all clip groups in the document are collected, and each
 * clip path is rendered as a white-on-transparent mask into its own
 * GPU texture_2d.  Each mask is sized to cover only its visible portion
 * at the main viewport zoom, so memory usage scales with on-screen area
 * rather than with the number of clip groups.
 *
 * The per-element `maskBoundsMin/Max` in the ElementTransform storage buffer
 * maps world-space coordinates to [0,1] UV for correct sampling.  BG3 is
 * switched per-element during the main render pass to bind the correct mask.
 */

import type { AnyArtObject, BoundingBox } from "../../../schema";
import { boundsIntersectionBox } from "../../../utils/geometry/bounds";
import { neverReached } from "../../../utils/lang";
import { expandRenderFilter } from "../CanvasLayer.helpers";
import type {
	FilteredTextureInfo,
	GPUCoreResources,
	RenderElementsFn,
	RenderElementToMaskFn,
	RenderState,
	ViewportState,
} from "../CanvasLayerTypes";
import { MaskAtlasAllocator, type MaskAtlasRect } from "./MaskAtlasAllocator";
import { createBorrowedTextureRef, type TextureRef } from "./RenderSurface";
import { quantizeSize, type TexturePool } from "./TexturePool";
import type { UniformEntry, UniformScope } from "./UniformScope";
import type { GPUMaskInfo } from "./ViewportManager";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Information about a single clip group collected during document traversal. */
export interface ClipGroupEntry {
	/** ID of the Group element that has the clipPathId set. */
	groupId: string;
	clipPathId: string;
	clipPath: AnyArtObject;
	groupBounds: BoundingBox;
	/** Key of this group's effective mask: its clip path intersected with the
	 *  enclosing clip group's effective mask, so nested clips need one mask. */
	maskKey: string;
	/** Effective mask key of the nearest enclosing clip group, if any. */
	parentMaskKey?: string;
}

/**
 * How a mask's sources are drawn into its texture.
 *
 * `silhouette` fills them flat white, which is all a clip path's in/out test
 * needs. `appearance` draws them as they actually look, so gradients and
 * partial opacity survive into the mask's luminance — this is what gives
 * object masks their soft edges.
 */
export type MaskRenderMode = "silhouette" | "appearance";

/** One mask to pre-render this frame. */
export interface MaskRenderRequest {
	/**
	 * Cache key. Build it with {@link clipMaskKey} / {@link objectMaskKey} so a
	 * clip path and a mask owner that happen to share an element id get
	 * separate textures.
	 */
	key: string;
	/** Elements drawn into the mask texture, in draw order. */
	sources: AnyArtObject[];
	/** World-space area the mask texture must cover. */
	coverBounds: BoundingBox;
	mode: MaskRenderMode;
	/** Effective mask this one is intersected with while it is drawn: the
	 *  sources sample that mask through the regular inline clip path, so the
	 *  result already carries every enclosing clip. Rendered before this one. */
	parentKey?: string;
}

/** Result of looking up a pre-rendered mask. */
export interface MaskEntry {
	/** Content and coverage identity used by downstream bake caches. */
	fingerprint: string;
	/** Texture layer index. The 2D atlas and standalone textures use 0. */
	layerIndex: number;
	/** World-space region covered by this mask texture. */
	bounds: BoundingBox;
	/** Pixel-space region inside the shared atlas. Undefined for standalone masks. */
	atlasRect?: MaskAtlasRect;
	/** BG3 bind group for this mask's texture_2d + sampler. */
	bindGroup: GPUBindGroup;
	/** View of the mask texture, for multi-mask chain bind groups. */
	textureView: GPUTextureView;
}

/** Cache key for the mask a clip path produces. A nested clip group's mask
 *  is specific to the enclosing effective mask it was intersected with. */
export function clipMaskKey(clipPathId: string, parentKey?: string): string {
	const own = `clip:${clipPathId}`;
	return parentKey ? `${own}|${parentKey}` : own;
}

/** Cache key for the mask attached to an element via `ArtObject.mask`. */
export function objectMaskKey(ownerId: string): string {
	return `mask:${ownerId}`;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

interface ClipMaskAtlasDeps extends GPUCoreResources {
	texturePool: TexturePool;
	uniformScope: UniformScope;
	maskBindGroupLayout: GPUBindGroupLayout;
	strokePipeline: GPURenderPipeline;
	dummyGradientBindGroup: GPUBindGroup;
	dummyMaskBindGroup: GPUBindGroup;
	getTransformsBindGroup: () => GPUBindGroup | null;
	getTransformIndex: (elementId: string) => number;
	/** Point the given elements' transform slots at a mask, so drawing them
	 *  samples it through the inline clip path. */
	writeMaskInfo: (masks: ReadonlyMap<string, GPUMaskInfo>) => void;
	renderElementToMask: RenderElementToMaskFn;
	renderElements: RenderElementsFn;
	/** How the element currently paints — fill, stroke, referenced pattern
	 *  revisions, nested children. Keys the cache of masks drawn with their
	 *  real appearance. */
	paintHash: (
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
	) => string;
	viewportState: ViewportState;
	renderState: RenderState;
	/** Push (or with `replace`, swap) the viewport binding of the pass being
	 *  encoded; null pops back to the previous one. */
	setActiveBindGroup: (entry: UniformEntry | null, replace?: boolean) => void;
	deferDestroy: (texture: GPUTexture) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface MaskCoverage {
	logicalWidth: number;
	logicalHeight: number;
	effectiveZoom: number;
	coverageBounds: BoundingBox;
	texWidth: number;
	texHeight: number;
}

interface CachedMask {
	fingerprint: string;
	texture: TextureRef | null;
	entry: MaskEntry;
	atlasRect: MaskAtlasRect | null;
	/** Render closure of the mask's source elements at bake time. A tracked
	 *  document change intersecting it drops the entry (the fingerprint alone
	 *  cannot see an in-place geometry edit of a silhouette source). */
	dependencyIds: ReadonlySet<string>;
}

interface RenderedMask {
	entry: MaskEntry;
	texture: TextureRef | null;
	atlasRect: MaskAtlasRect | null;
	batchItem?: AtlasSilhouetteBatchItem;
}

interface AtlasSilhouetteBatchItem {
	mask: MaskRenderRequest;
	coverage: MaskCoverage;
	atlasRect: MaskAtlasRect;
}

export class ClipMaskAtlas {
	private deps: ClipMaskAtlasDeps;
	private maskEntries = new Map<string, MaskEntry>();
	private maskCache = new Map<string, CachedMask>();
	private sampler: GPUSampler;
	private readonly atlasSize: number;
	private atlasAllocator: MaskAtlasAllocator;
	private atlasTexture: GPUTexture | null = null;
	private atlasTextureView: GPUTextureView | null = null;
	private atlasBindGroup: GPUBindGroup | null = null;
	private atlasClearTexture: GPUTexture | null = null;
	private readonly atlasDescriptorBuffer: GPUBuffer;
	private readonly atlasDescriptors = new Uint32Array(
		MAX_MASK_ATLAS_ENTRIES * MASK_ATLAS_DESCRIPTOR_U32_COUNT,
	);
	private readonly freeAtlasDescriptorIndices: number[] = [];
	private nextAtlasDescriptorIndex = 0;
	private atlasDescriptorsDirty = false;
	/** Set for the duration of each preRender; see its parameter. */
	private sourceFilteredTextures: Map<string, FilteredTextureInfo> =
		EMPTY_FILTERED_TEXTURES;

	public constructor(deps: ClipMaskAtlasDeps) {
		this.deps = deps;
		this.atlasSize = Math.min(
			MASK_ATLAS_SIZE,
			deps.device.limits.maxTextureDimension2D,
		);
		this.atlasAllocator = new MaskAtlasAllocator(
			this.atlasSize,
			this.atlasSize,
		);
		this.atlasDescriptorBuffer = deps.device.createBuffer({
			label: "Clip Mask Atlas Descriptor Buffer",
			size: this.atlasDescriptors.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.sampler = deps.device.createSampler({
			label: "Clip Mask Sampler",
			magFilter: "linear",
			minFilter: "linear",
		});
	}

	/**
	 * Look up a pre-rendered mask. Pass a key built by {@link clipMaskKey} or
	 * {@link objectMaskKey}.
	 */
	public getMaskEntry(key: string): MaskEntry | null {
		return this.maskEntries.get(key) ?? null;
	}

	/**
	 * Pre-render all masks into individual texture_2d textures.
	 *
	 * Must be called before the main render pass begins.  After this call,
	 * `getMaskEntry()` returns the bind group + bounds for each request.
	 */
	public preRender(
		encoder: GPUCommandEncoder,
		requests: MaskRenderRequest[],
		elementsMap: Map<string, AnyArtObject>,
		/** World region the frame draws, which a mask's texture is cropped to.
		 *  On a viewport-driven frame that is the whole margined store, not the
		 *  visible viewport: an owner in the margin is drawn this frame, and a
		 *  mask cropped to the viewport would come out empty and be dropped.
		 *  Null disables the crop. */
		drawRegion: BoundingBox | null,
		/** Filtered results for the sources, so an appearance that replaces an
		 *  element's render (a 3D solid) contributes its solid rather than the
		 *  flat look it suppressed. */
		sourceFilteredTextures: Map<
			string,
			FilteredTextureInfo
		> = EMPTY_FILTERED_TEXTURES,
	): void {
		this.sourceFilteredTextures = sourceFilteredTextures;
		this.maskEntries.clear();

		if (requests.length === 0) {
			// Keep cached textures alive — executeFilterPlans may have already
			// recorded commands referencing bind groups that point to these
			// textures earlier in the same encoder.  Releasing them now would
			// queue deferDestroy and the next frame's resetFrame() would destroy
			// them while the GPU is still processing this frame's submit.
			// Cached textures are cleaned up by invalidateAll() on document
			// change or by releaseStaleEntries when clipGroups become non-empty.
			return;
		}

		// Deduplicate by key — several groups may share one clip path. Merge
		// bounds to the union so the mask covers every requester.
		const uniqueMasks = new Map<string, MaskRenderRequest>();
		for (const request of requests) {
			const existing = uniqueMasks.get(request.key);
			if (!existing) {
				uniqueMasks.set(request.key, { ...request });
				continue;
			}
			const b = existing.coverBounds;
			const e = request.coverBounds;
			const minX = Math.min(b.minX, e.minX);
			const minY = Math.min(b.minY, e.minY);
			const maxX = Math.max(b.maxX, e.maxX);
			const maxY = Math.max(b.maxY, e.maxY);
			existing.coverBounds = {
				minX,
				minY,
				maxX,
				maxY,
				width: maxX - minX,
				height: maxY - minY,
			};
		}

		// A nested mask samples its parent's texture while it is drawn, so
		// parents must be rendered first. Keys nest as `own|parent|...`, so the
		// separator count is the nesting depth.
		const masks = Array.from(uniqueMasks.values()).sort(
			(a, b) => nestingDepth(a.key) - nestingDepth(b.key),
		);
		// The atlas batch is encoded after this loop, so a mask another one
		// samples as its parent must be drawn in loop order instead.
		const parentKeys = new Set(
			masks.flatMap((mask) => (mask.parentKey ? [mask.parentKey] : [])),
		);
		const zoom = this.deps.viewportState.current?.zoom ?? 1;
		const maxDim = this.deps.device.limits.maxTextureDimension2D;
		const savedBounds = this.deps.viewportState.bounds;
		const activeKeys = new Set<string>();
		const atlasSilhouetteBatch: AtlasSilhouetteBatchItem[] = [];

		for (let i = 0; i < masks.length; i++) {
			const mask = masks[i];
			activeKeys.add(mask.key);

			const coverage = computeMaskCoverage(
				mask.coverBounds,
				drawRegion,
				zoom,
				maxDim,
			);
			if (!coverage) continue;

			const parent = mask.parentKey
				? (this.maskCache.get(mask.parentKey) ?? null)
				: null;
			const fingerprint = `${this.computeMaskFingerprint(
				mask,
				coverage.texWidth,
				coverage.texHeight,
				coverage.effectiveZoom,
				coverage.coverageBounds,
				elementsMap,
			)}${parent ? `<${parent.fingerprint}` : ""}`;

			const cached = this.maskCache.get(mask.key);
			if (cached && cached.fingerprint === fingerprint) {
				this.maskEntries.set(mask.key, cached.entry);
				continue;
			}

			if (cached) this.releaseCachedMask(mask.key, cached);

			const rendered = this.renderMask(
				encoder,
				mask,
				i,
				elementsMap,
				coverage,
				fingerprint,
				parent?.entry ?? null,
				parentKeys.has(mask.key),
			);
			if (rendered) {
				if (rendered.batchItem) atlasSilhouetteBatch.push(rendered.batchItem);
				this.maskEntries.set(mask.key, rendered.entry);
				// A change to any enclosing clip path re-bakes the nested mask too.
				const dependencyIds = new Set(
					expandRenderFilter(
						new Set(mask.sources.map((s) => s.id)),
						elementsMap,
					),
				);
				for (const id of parent?.dependencyIds ?? []) dependencyIds.add(id);
				this.maskCache.set(mask.key, {
					fingerprint,
					texture: rendered.texture,
					entry: rendered.entry,
					atlasRect: rendered.atlasRect,
					dependencyIds,
				});
			}
		}

		this.renderSilhouetteAtlasBatch(encoder, atlasSilhouetteBatch, elementsMap);
		this.deps.viewportState.bounds = savedBounds;
		this.flushAtlasDescriptors();
		this.releaseStaleEntries(activeKeys);
	}

	public invalidateAll(): void {
		for (const [key, cached] of this.maskCache) {
			this.releaseCachedMask(key, cached);
		}
		this.maskCache.clear();
		this.maskEntries.clear();
		this.atlasAllocator = new MaskAtlasAllocator(
			this.atlasSize,
			this.atlasSize,
		);
		this.freeAtlasDescriptorIndices.length = 0;
		this.nextAtlasDescriptorIndex = 0;
	}

	/**
	 * Drop only the masks whose source closure intersects a tracked document
	 * change. Unchanged masks keep their texture AND their bind group, so
	 * downstream caches keyed on bind-group identity (the masked-bake hash)
	 * stay hot across content frames.
	 */
	public invalidateChanged(changedIds: ReadonlySet<string>): void {
		for (const [key, cached] of this.maskCache) {
			let hit = false;
			for (const id of changedIds) {
				if (cached.dependencyIds.has(id)) {
					hit = true;
					break;
				}
			}
			if (!hit) continue;
			this.releaseCachedMask(key, cached);
		}
	}

	public destroy(): void {
		this.invalidateAll();
		if (this.atlasTexture) this.deps.deferDestroy(this.atlasTexture);
		this.atlasTexture = null;
		this.atlasTextureView = null;
		this.atlasBindGroup = null;
		this.atlasClearTexture?.destroy();
		this.atlasClearTexture = null;
		this.atlasDescriptorBuffer.destroy();
	}

	private releaseStaleEntries(activeIds: Set<string>): void {
		for (const [id, cached] of this.maskCache) {
			if (!activeIds.has(id)) {
				this.releaseCachedMask(id, cached);
			}
		}
	}

	private releaseCachedMask(key: string, cached: CachedMask): void {
		if (cached.texture) this.deps.deferDestroy(cached.texture.texture);
		if (cached.atlasRect) {
			this.atlasAllocator.release(cached.atlasRect);
			this.freeAtlasDescriptorIndices.push(cached.entry.layerIndex);
		}
		this.maskCache.delete(key);
		this.maskEntries.delete(key);
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private computeMaskFingerprint(
		mask: MaskRenderRequest,
		texWidth: number,
		texHeight: number,
		effectiveZoom: number,
		coverageBounds: BoundingBox,
		elementsMap: Map<string, AnyArtObject>,
	): string {
		const b = coverageBounds;
		// A silhouette is flat white whatever the source looks like, so only its
		// identity matters. An appearance mask is the source's actual paint, so
		// recolouring it — or editing the pattern def it samples — has to miss
		// the cache, or the mask keeps the look it had when first baked.
		const sources = mask.sources
			.map((s) =>
				mask.mode === "appearance"
					? `${s.id}@${this.deps.paintHash(s, elementsMap)}`
					: s.id,
			)
			.join(",");
		return `${mask.key}:${sources}:${texWidth}:${texHeight}:${Math.round(effectiveZoom * 1000)}:${Math.round(b.minX * 100)}:${Math.round(b.minY * 100)}:${Math.round(b.maxX * 100)}:${Math.round(b.maxY * 100)}`;
	}

	private renderMask(
		encoder: GPUCommandEncoder,
		mask: MaskRenderRequest,
		index: number,
		elementsMap: Map<string, AnyArtObject>,
		coverage: MaskCoverage,
		fingerprint: string,
		parent: MaskEntry | null,
		isParent: boolean,
	): RenderedMask | null {
		const {
			logicalWidth,
			logicalHeight,
			effectiveZoom,
			coverageBounds,
			texWidth,
			texHeight,
		} = coverage;

		let atlasRect =
			logicalWidth <= MAX_ATLASED_MASK_DIM &&
			logicalHeight <= MAX_ATLASED_MASK_DIM
				? this.atlasAllocator.allocate(logicalWidth, logicalHeight)
				: null;
		const atlasDescriptorIndex = atlasRect
			? this.allocateAtlasDescriptor(atlasRect)
			: null;
		if (atlasRect && atlasDescriptorIndex === null) {
			this.atlasAllocator.release(atlasRect);
			atlasRect = null;
		}
		// The atlas batch is drawn after every staged mask and straight into the
		// atlas, so a nested silhouette (which samples its parent) and any mask
		// that is itself a parent take the staging route below.
		if (
			atlasRect &&
			atlasDescriptorIndex !== null &&
			mask.mode === "silhouette" &&
			!parent &&
			!isParent
		) {
			const atlas = this.ensureAtlasResources();
			return {
				entry: {
					fingerprint,
					layerIndex: atlasDescriptorIndex,
					bounds: maskBoundsForCoverage(coverage),
					atlasRect,
					bindGroup: atlas.bindGroup,
					textureView: atlas.textureView,
				},
				texture: null,
				atlasRect,
				batchItem: { mask, coverage, atlasRect },
			};
		}
		const maskTexture = atlasRect
			? this.deps.texturePool.acquireExact(
					logicalWidth,
					logicalHeight,
					this.deps.canvasFormat,
					1,
					GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
					`Clip Mask Staging [${index}] - ${mask.key}`,
				)
			: this.deps.device.createTexture({
					label: `Clip Mask [${index}] - ${mask.key}`,
					size: [texWidth, texHeight],
					format: this.deps.canvasFormat,
					usage:
						GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
				});
		const passEncoder = encoder.beginRenderPass({
			label: `Clip Mask Pass [${index}] - ${mask.key}`,
			colorAttachments: [
				{
					view: maskTexture.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});

		// Set up a per-mask viewport centred on the coverage bounds.
		const tempViewport = {
			x: (coverageBounds.minX + coverageBounds.maxX) / 2,
			y: (coverageBounds.minY + coverageBounds.maxY) / 2,
			zoom: effectiveZoom,
			rotation: 0,
		};

		const entry = this.deps.uniformScope.acquire(
			tempViewport,
			logicalWidth,
			logicalHeight,
		);
		this.deps.setActiveBindGroup(entry);
		this.deps.viewportState.bounds = null;

		// Pipeline and bind groups — same layout as the main geometry passes.
		// Drawing the sources with the parent mask in their transform slots
		// clips them by it, so the texture holds the intersection.
		const inheritedMask = parent?.bindGroup ?? this.deps.dummyMaskBindGroup;
		if (parent) {
			this.deps.writeMaskInfo(
				new Map(mask.sources.map((source) => [source.id, parent])),
			);
		}
		passEncoder.setPipeline(this.deps.strokePipeline);
		passEncoder.setBindGroup(0, entry.bindGroup);
		passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
		passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
		passEncoder.setBindGroup(3, inheritedMask);

		switch (mask.mode) {
			case "silhouette": {
				this.deps.renderState.currentMaskBindGroup = inheritedMask;
				for (const source of mask.sources) {
					this.deps.renderState.currentTransformIndex =
						this.deps.getTransformIndex(source.id);
					this.deps.renderElementToMask(passEncoder, source, elementsMap);
				}
				this.unbindMaskForMaskPass();
				passEncoder.end();
				break;
			}
			case "appearance": {
				// Draw the sources as they really look so gradients and partial
				// opacity carry into the mask's luminance. No composite context is
				// supplied, so blend modes *within* the mask content are ignored —
				// what a mask needs is the shape's coverage, not how its parts
				// would have blended against the document underneath.
				const finalPass = this.deps.renderElements(
					passEncoder,
					mask.sources,
					this.sourceFilteredTextures,
					elementsMap,
					1.0,
					null,
					undefined,
					"offscreen",
				);
				finalPass.end();
				break;
			}
			default:
				neverReached(mask.mode, "unhandled mask render mode");
		}

		// Pop the viewport binding pushed by setActiveBindGroup above.
		this.deps.setActiveBindGroup(null);

		const maskBounds = maskBoundsForCoverage(coverage);

		if (atlasRect && atlasDescriptorIndex !== null) {
			const atlas = this.ensureAtlasResources();
			encoder.copyTextureToTexture(
				{ texture: maskTexture },
				{ texture: atlas.texture, origin: [atlasRect.x, atlasRect.y] },
				[atlasRect.width, atlasRect.height],
			);
			this.deps.texturePool.release(maskTexture);
			return {
				entry: {
					fingerprint,
					layerIndex: atlasDescriptorIndex,
					bounds: maskBounds,
					atlasRect,
					bindGroup: atlas.bindGroup,
					textureView: atlas.textureView,
				},
				texture: null,
				atlasRect,
			};
		}

		const textureView = maskTexture.createView();
		return {
			entry: {
				fingerprint,
				layerIndex: 0,
				bounds: maskBounds,
				bindGroup: this.deps.device.createBindGroup({
					label: `Clip Mask Bind Group [${index}]`,
					layout: this.deps.maskBindGroupLayout,
					entries: [
						{ binding: 0, resource: textureView },
						{ binding: 1, resource: this.sampler },
						{ binding: 2, resource: { buffer: this.atlasDescriptorBuffer } },
					],
				}),
				textureView,
			},
			texture: createBorrowedTextureRef(maskTexture, "mask-atlas"),
			atlasRect: null,
		};
	}

	private ensureAtlasResources(): {
		texture: GPUTexture;
		textureView: GPUTextureView;
		bindGroup: GPUBindGroup;
	} {
		if (this.atlasTexture && this.atlasTextureView && this.atlasBindGroup) {
			return {
				texture: this.atlasTexture,
				textureView: this.atlasTextureView,
				bindGroup: this.atlasBindGroup,
			};
		}

		this.atlasTexture = this.deps.device.createTexture({
			label: "Clip Mask Shared Atlas",
			size: [this.atlasSize, this.atlasSize],
			format: this.deps.canvasFormat,
			usage:
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});
		this.atlasTextureView = this.atlasTexture.createView();
		this.atlasBindGroup = this.deps.device.createBindGroup({
			label: "Clip Mask Shared Atlas Bind Group",
			layout: this.deps.maskBindGroupLayout,
			entries: [
				{ binding: 0, resource: this.atlasTextureView },
				{ binding: 1, resource: this.sampler },
				{ binding: 2, resource: { buffer: this.atlasDescriptorBuffer } },
			],
		});
		return {
			texture: this.atlasTexture,
			textureView: this.atlasTextureView,
			bindGroup: this.atlasBindGroup,
		};
	}

	private renderSilhouetteAtlasBatch(
		encoder: GPUCommandEncoder,
		items: readonly AtlasSilhouetteBatchItem[],
		elementsMap: Map<string, AnyArtObject>,
	): void {
		if (items.length === 0) return;
		const atlas = this.ensureAtlasResources();
		const clearTexture = this.ensureAtlasClearTexture();
		for (const { atlasRect } of items) {
			encoder.copyTextureToTexture(
				{ texture: clearTexture },
				{ texture: atlas.texture, origin: [atlasRect.x, atlasRect.y] },
				[atlasRect.width, atlasRect.height],
			);
		}

		const transformsBindGroup = this.deps.getTransformsBindGroup();
		if (!transformsBindGroup) return;
		const pass = encoder.beginRenderPass({
			label: `Clip Mask Atlas Batch [${items.length}]`,
			colorAttachments: [
				{
					view: atlas.textureView,
					loadOp: "load",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(this.deps.strokePipeline);
		pass.setBindGroup(1, transformsBindGroup);
		pass.setBindGroup(2, this.deps.dummyGradientBindGroup);
		pass.setBindGroup(3, this.deps.dummyMaskBindGroup);
		this.unbindMaskForMaskPass();
		this.deps.viewportState.bounds = null;

		for (const { mask, coverage, atlasRect } of items) {
			pass.setViewport(
				atlasRect.x,
				atlasRect.y,
				atlasRect.width,
				atlasRect.height,
				0,
				1,
			);
			pass.setScissorRect(
				atlasRect.x,
				atlasRect.y,
				atlasRect.width,
				atlasRect.height,
			);
			const tempViewport = {
				x: (coverage.coverageBounds.minX + coverage.coverageBounds.maxX) / 2,
				y: (coverage.coverageBounds.minY + coverage.coverageBounds.maxY) / 2,
				zoom: coverage.effectiveZoom,
				rotation: 0,
			};
			const entry = this.deps.uniformScope.acquire(
				tempViewport,
				coverage.logicalWidth,
				coverage.logicalHeight,
			);
			this.deps.setActiveBindGroup(entry);
			pass.setBindGroup(0, entry.bindGroup);
			for (const source of mask.sources) {
				this.deps.renderState.currentTransformIndex =
					this.deps.getTransformIndex(source.id);
				this.deps.renderElementToMask(pass, source, elementsMap);
			}
			this.deps.setActiveBindGroup(null);
		}

		pass.end();
	}

	/**
	 * Point renderState at the dummy mask before a mask pass draws its sources.
	 * Element renderers rebind BG3 from renderState.currentMaskBindGroup, which
	 * still holds the last main-pass mask. When that mask lives in the shared
	 * atlas and the atlas is the pass's color attachment, rebinding it makes
	 * WebGPU reject the whole command buffer.
	 */
	private unbindMaskForMaskPass(): void {
		this.deps.renderState.currentMaskBindGroup = this.deps.dummyMaskBindGroup;
	}

	private ensureAtlasClearTexture(): GPUTexture {
		this.atlasClearTexture ??= this.deps.device.createTexture({
			label: "Clip Mask Atlas Clear Texture",
			size: [MAX_ATLASED_MASK_DIM, MAX_ATLASED_MASK_DIM],
			format: this.deps.canvasFormat,
			usage: GPUTextureUsage.COPY_SRC,
		});
		return this.atlasClearTexture;
	}

	private allocateAtlasDescriptor(rect: MaskAtlasRect): number | null {
		const index =
			this.freeAtlasDescriptorIndices.pop() ?? this.nextAtlasDescriptorIndex++;
		if (index >= MAX_MASK_ATLAS_ENTRIES) {
			this.nextAtlasDescriptorIndex = MAX_MASK_ATLAS_ENTRIES;
			return null;
		}

		const offset = index * MASK_ATLAS_DESCRIPTOR_U32_COUNT;
		this.atlasDescriptors[offset] = rect.x;
		this.atlasDescriptors[offset + 1] = rect.y;
		this.atlasDescriptors[offset + 2] = rect.width;
		this.atlasDescriptors[offset + 3] = rect.height;
		this.atlasDescriptorsDirty = true;
		return index;
	}

	private flushAtlasDescriptors(): void {
		if (!this.atlasDescriptorsDirty) return;
		this.deps.device.queue.writeBuffer(
			this.atlasDescriptorBuffer,
			0,
			this.atlasDescriptors,
			0,
			this.nextAtlasDescriptorIndex *
				MASK_ATLAS_DESCRIPTOR_U32_COUNT *
				Uint32Array.BYTES_PER_ELEMENT,
		);
		this.atlasDescriptorsDirty = false;
	}
}

/**
 * A mask is sampled at the size it appears on screen, so it is drawn at the
 * viewport zoom. R is for kernels — a mask has none, and baking one at a
 * fixed scale only costs its edge the resolution the screen is showing it
 * at. Growth is bounded by shrinking what the texture covers instead.
 */
export function computeMaskCoverage(
	maskBounds: BoundingBox,
	renderTargetCoverage: BoundingBox | null,
	zoom: number,
	maxDim: number,
): MaskCoverage | null {
	const coverageBounds = renderTargetCoverage
		? boundsIntersectionBox(maskBounds, renderTargetCoverage)
		: maskBounds;
	if (
		!coverageBounds ||
		coverageBounds.width <= 0 ||
		coverageBounds.height <= 0
	) {
		return null;
	}

	const effectiveZoom = Math.min(
		zoom,
		maxDim / coverageBounds.width,
		maxDim / coverageBounds.height,
	);
	if (!Number.isFinite(effectiveZoom) || effectiveZoom <= 0) return null;

	const logicalWidth = Math.min(
		Math.ceil(coverageBounds.width * effectiveZoom),
		maxDim,
	);
	const logicalHeight = Math.min(
		Math.ceil(coverageBounds.height * effectiveZoom),
		maxDim,
	);
	if (logicalWidth <= 0 || logicalHeight <= 0) return null;

	return {
		logicalWidth,
		logicalHeight,
		effectiveZoom,
		coverageBounds,
		texWidth: Math.min(quantizeSize(logicalWidth), maxDim),
		texHeight: Math.min(quantizeSize(logicalHeight), maxDim),
	};
}

/** Nesting depth encoded in a mask key — see clipMaskKey. */
function nestingDepth(key: string): number {
	return key.split("|").length;
}

/** Mask sources are drawn straight from their geometry, never from a filter cache. */
const EMPTY_FILTERED_TEXTURES: Map<string, FilteredTextureInfo> = new Map();

const MASK_ATLAS_SIZE = 4096;
const MAX_ATLASED_MASK_DIM = 256;
const MAX_MASK_ATLAS_ENTRIES = 16_384;
const MASK_ATLAS_DESCRIPTOR_U32_COUNT = 4;

function maskBoundsForCoverage(coverage: MaskCoverage): BoundingBox {
	const centerX =
		(coverage.coverageBounds.minX + coverage.coverageBounds.maxX) / 2;
	const centerY =
		(coverage.coverageBounds.minY + coverage.coverageBounds.maxY) / 2;
	const halfW = coverage.logicalWidth / (2 * coverage.effectiveZoom);
	const halfH = coverage.logicalHeight / (2 * coverage.effectiveZoom);
	return {
		minX: centerX - halfW,
		minY: centerY - halfH,
		maxX: centerX + halfW,
		maxY: centerY + halfH,
		width: halfW * 2,
		height: halfH * 2,
	};
}

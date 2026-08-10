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
import {
	type FilteredTextureInfo,
	type GPUCoreResources,
	MSAA_SAMPLE_COUNT,
	type RenderElementsFn,
	type RenderElementToMaskFn,
	type RenderState,
	type ViewportState,
} from "../CanvasLayerTypes";
import { createPassLocalStencilAttachment } from "./PassLocalStencil";
import { createBorrowedTextureRef, type TextureRef } from "./RenderSurface";
import { quantizeSize, type TexturePool } from "./TexturePool";
import type { UniformScope } from "./UniformScope";

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
}

/** Result of looking up a pre-rendered mask. */
export interface MaskEntry {
	/** Always 0 for per-mask 2D textures. Kept for GPU transforms buffer compatibility. */
	layerIndex: number;
	/** World-space region covered by this mask texture. */
	bounds: BoundingBox;
	/** BG3 bind group for this mask's texture_2d + sampler. */
	bindGroup: GPUBindGroup;
	/** View of the mask texture, for multi-mask chain bind groups. */
	textureView: GPUTextureView;
}

/** Cache key for the mask a clip path produces. */
export function clipMaskKey(clipPathId: string): string {
	return `clip:${clipPathId}`;
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
	setActiveBindGroup: (
		bindGroup: GPUBindGroup | null,
		uniformBuffer?: GPUBuffer | null,
		replace?: boolean,
	) => void;
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
	texture: TextureRef;
	entry: MaskEntry;
}

export class ClipMaskAtlas {
	private deps: ClipMaskAtlasDeps;
	private maskTextures: GPUTexture[] = [];
	private maskEntries = new Map<string, MaskEntry>();
	private maskCache = new Map<string, CachedMask>();
	private sampler: GPUSampler;
	/** Set for the duration of each preRender; see its parameter. */
	private sourceFilteredTextures: Map<string, FilteredTextureInfo> =
		EMPTY_FILTERED_TEXTURES;

	public constructor(deps: ClipMaskAtlasDeps) {
		this.deps = deps;
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

		const masks = Array.from(uniqueMasks.values());
		const zoom = this.deps.viewportState.current?.zoom ?? 1;
		const maxDim = this.deps.device.limits.maxTextureDimension2D;
		const savedBounds = this.deps.viewportState.bounds;
		const activeKeys = new Set<string>();

		for (let i = 0; i < masks.length; i++) {
			const mask = masks[i];
			activeKeys.add(mask.key);

			const coverage = this.computeCoverage(mask.coverBounds, zoom, maxDim);
			if (!coverage) continue;

			const fingerprint = this.computeMaskFingerprint(
				mask,
				coverage.texWidth,
				coverage.texHeight,
				coverage.effectiveZoom,
				coverage.coverageBounds,
				elementsMap,
			);

			const cached = this.maskCache.get(mask.key);
			if (cached && cached.fingerprint === fingerprint) {
				this.maskEntries.set(mask.key, cached.entry);
				continue;
			}

			if (cached) {
				this.deps.deferDestroy(cached.texture.texture);
				this.maskCache.delete(mask.key);
			}

			this.renderMask(encoder, mask, i, elementsMap, coverage);

			const entry = this.maskEntries.get(mask.key);
			const texture = this.maskTextures[this.maskTextures.length - 1];
			if (entry && texture) {
				this.maskCache.set(mask.key, {
					fingerprint,
					texture: createBorrowedTextureRef(texture, "mask-atlas"),
					entry,
				});
			}
		}

		this.deps.viewportState.bounds = savedBounds;
		this.releaseStaleEntries(activeKeys);
	}

	public invalidateAll(): void {
		for (const cached of this.maskCache.values()) {
			this.deps.deferDestroy(cached.texture.texture);
		}
		this.maskCache.clear();
		this.maskTextures = [];
		this.maskEntries.clear();
	}

	public destroy(): void {
		this.invalidateAll();
	}

	private releaseStaleEntries(activeIds: Set<string>): void {
		for (const [id, cached] of this.maskCache) {
			if (!activeIds.has(id)) {
				this.deps.deferDestroy(cached.texture.texture);
				this.maskCache.delete(id);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	/**
	 * A mask is sampled at the size it appears on screen, so it is drawn at the
	 * viewport zoom. R is for kernels — a mask has none, and baking one at a
	 * fixed scale only costs its edge the resolution the screen is showing it
	 * at. Growth is bounded by shrinking what the texture covers instead.
	 */
	private computeCoverage(
		bounds: BoundingBox,
		zoom: number,
		maxDim: number,
	): MaskCoverage | null {
		return computeMaskCoverage(
			bounds,
			this.deps.viewportState.bounds,
			zoom,
			maxDim,
		);
	}

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
	): void {
		const {
			logicalWidth,
			logicalHeight,
			effectiveZoom,
			coverageBounds,
			texWidth,
			texHeight,
		} = coverage;

		const maskTexture = this.deps.device.createTexture({
			label: `Clip Mask [${index}] - ${mask.key}`,
			size: [texWidth, texHeight],
			format: this.deps.canvasFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.maskTextures.push(maskTexture);

		// Acquire temporary stencil texture from pool.
		const stencilTexture = this.deps.texturePool.acquire(
			texWidth,
			texHeight,
			"depth24plus-stencil8",
			MSAA_SAMPLE_COUNT,
			GPUTextureUsage.RENDER_ATTACHMENT,
			`Clip Mask Stencil [${index}]`,
		);

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
			depthStencilAttachment: createPassLocalStencilAttachment(
				stencilTexture.createView(),
			),
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
		this.deps.setActiveBindGroup(entry.bindGroup, entry.buffer);
		this.deps.viewportState.bounds = null;

		// Pipeline and bind groups — same layout as the main geometry passes.
		passEncoder.setPipeline(this.deps.strokePipeline);
		passEncoder.setBindGroup(0, entry.bindGroup);
		passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
		passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
		passEncoder.setBindGroup(3, this.deps.dummyMaskBindGroup);

		switch (mask.mode) {
			case "silhouette": {
				for (const source of mask.sources) {
					this.deps.renderState.currentTransformIndex =
						this.deps.getTransformIndex(source.id);
					this.deps.renderElementToMask(passEncoder, source, elementsMap);
				}
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

		// Return stencil texture to the pool.
		this.deps.texturePool.release(stencilTexture);

		// Compute the actual world-space region covered by this mask texture.
		const centerX = (coverageBounds.minX + coverageBounds.maxX) / 2;
		const centerY = (coverageBounds.minY + coverageBounds.maxY) / 2;
		const halfW = logicalWidth / (2 * effectiveZoom);
		const halfH = logicalHeight / (2 * effectiveZoom);
		const maskBounds: BoundingBox = {
			minX: centerX - halfW,
			minY: centerY - halfH,
			maxX: centerX + halfW,
			maxY: centerY + halfH,
			width: halfW * 2,
			height: halfH * 2,
		};

		// Create BG3 bind group for this mask.
		const textureView = maskTexture.createView();
		const bindGroup = this.deps.device.createBindGroup({
			label: `Clip Mask Bind Group [${index}]`,
			layout: this.deps.maskBindGroupLayout,
			entries: [
				{ binding: 0, resource: textureView },
				{ binding: 1, resource: this.sampler },
			],
		});

		this.maskEntries.set(mask.key, {
			layerIndex: 0,
			bounds: maskBounds,
			bindGroup,
			textureView,
		});
	}
}

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

/** Mask sources are drawn straight from their geometry, never from a filter cache. */
const EMPTY_FILTERED_TEXTURES: Map<string, FilteredTextureInfo> = new Map();

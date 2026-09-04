import type {
	AnyArtObject,
	BlendMode,
	BlendObject,
	BoundingBox,
	CompositionMode,
	CompoundPath,
	Document,
	ElementTransform,
	EmbeddedFile,
	FillAppearance,
	FillColor,
	ImageObject,
	MeshArtObject,
	Path,
	Reference3DElement,
	TextElement,
} from "../../../schema";
import { brandWorldBBox, type WorldBBox } from "../../../utils/geometry/bounds";
import type { MeshWarpResolution } from "../../../utils/geometry/meshWarp";
import {
	type AssetState,
	BLEND_MODE_ORDER,
	type BlitMeshToCanvasFn,
	type BlitQuadToCanvasFn,
	type BlitTextureToCanvasFn,
	COMPOSITION_MODE_ORDER,
	type GradientState,
	type PipelineType,
	type RenderState,
	type SharedRenderBindings,
	type TextState,
	type ViewportState,
} from "../CanvasLayerTypes";
import type { BlendCache } from "../caches/BlendCache";
import type { CompoundPathCache } from "../caches/CompoundPathCache";
import type { GeometryCache } from "../caches/GeometryCache";
import type { GradientCache } from "../caches/GradientCache";
import type { MeshWarpCache } from "../caches/MeshWarpCache";
import type { StencilFillCache } from "../caches/StencilFillCache";
import type { StrokeCache } from "../caches/StrokeCache";
import type { FilterRenderer } from "../pipeline/FilterRenderer";
import type { GeometryStore } from "../pipeline/GeometryStore";
import {
	type RunBatcher,
	transformFillBoundsToWorld,
} from "../pipeline/RunBatcher";
import type { StrokeBatchContext } from "../pipeline/stroke/StrokeBatchContext";
import type {
	DrawableSegments,
	ResolvedAppearancePass,
} from "./appearancePasses";
import { GradientRenderer } from "./GradientRenderer";
import { ImageElementRenderer } from "./ImageElementRenderer";
import { MeshElementRenderer } from "./MeshElementRenderer";
import { PathElementRenderer } from "./PathElementRenderer";
import {
	Reference3DElementRenderer,
	type Reference3DRenderContext,
} from "./Reference3DElementRenderer";
import { TextElementRenderer } from "./TextElementRenderer";

interface ElementRendererDeps extends SharedRenderBindings {
	strokePipeline: GPURenderPipeline;
	fillPipeline: GPURenderPipeline;
	dummyGradientBindGroup: GPUBindGroup;
	dummyMaskBindGroup: GPUBindGroup;
	getMaskBindGroup: () => GPUBindGroup;
	/** Clip mask reserved for a mesh warp transient, or null when it has none. */
	getTransientMaskBindGroup: (transientId: string) => GPUBindGroup | null;
	/** An element's transform composed with its ancestors' (identity if none). */
	getComposedTransform: (elementId: string) => ElementTransform;
	/** The local bounds the element's GPU transform entry takes its origin from. */
	getLocalBounds: (elementId: string) => BoundingBox | null;
	stencilFanWritePipeline: GPURenderPipeline;
	stencilCoverPipeline: GPURenderPipeline;
	/** First-fragment-wins / stencil-restore pair for semi-transparent strokes. */
	strokeUnionPipeline: GPURenderPipeline;
	stencilZeroPipeline: GPURenderPipeline;
	/** Vertex-pulling variants used by the run batcher's merged draws. */
	pulledGeometryPipeline: GPURenderPipeline;
	pulledStencilFanWritePipeline: GPURenderPipeline;
	filterRenderer: FilterRenderer;
	/** Document rasterization scale R (rasterizationDpi / 72). */
	getRasterScale: () => number;
	// Mutable shared state (by reference)
	viewportState: ViewportState;
	renderState: RenderState;
	assetState: AssetState;
	textState: TextState;
	gradient: GradientState;
	strokeBatchContext: StrokeBatchContext;
	getCompoundPathGeometryCache: () => CompoundPathCache;
	getBlendCache: () => BlendCache;
	getMeshWarpCache: () => MeshWarpCache;
	// Externally-owned caches (managed by RenderCacheManager)
	geometryCache: GeometryCache;
	strokeCache: StrokeCache;
	stencilFillCache: StencilFillCache;
	gradientCache: GradientCache;
	/** Persistent shared vertex buffer the caches lease ranges from (one per
	 *  canvas target, document-scope agnostic — plain value, not an accessor). */
	geometryStore: GeometryStore;
	/** Merges consecutive same-state solid draws into one drawIndexed. Every
	 *  draw issued through any OTHER path must flush() it first (see
	 *  RunBatcher's ordering contract). Plain value, one per canvas target. */
	runBatcher: RunBatcher;
	// Lookup transform index for an element (from CanvasLayer.transformIndexMap)
	getTransformIndex: (elementId: string) => number;
	// Callback: blit texture (from CompositeRenderer, injected later)
	blitTextureToCanvas: BlitTextureToCanvasFn;
	// Callback: blit texture onto a deformed 4-corner quad.
	blitQuadToCanvas: BlitQuadToCanvasFn;
	// Callback: blit texture onto a tessellated warp mesh.
	blitMeshToCanvas: BlitMeshToCanvasFn;
	// Lookup cached child→parent group mapping (from ViewportManager)
	getParentGroupMap: () => ReadonlyMap<string, string>;
	/**
	 * Resolve a pattern def to its rasterized tile texture + world-space tile
	 * size + per-def revision counter. Returns null when the def is unknown,
	 * outside the def cache, or rasterization failed. Used by the gradient
	 * renderer's pattern dispatch (case 5 in unified.wgsl).
	 */
	resolvePatternTexture?: (defId: string) => {
		texture: GPUTexture;
		tileWorldSize: { width: number; height: number };
		revision: number;
	} | null;
	/**
	 * Reference3D subsystem access (lazy three.js service + shared scene defs).
	 * Wired by the Paplico facade; while absent or returning null, reference3d
	 * elements are skipped.
	 */
	getReference3DContext?: () => Reference3DRenderContext | null;
}

export class ElementRenderer {
	private readonly deps: ElementRendererDeps;
	private readonly gradientRenderer: GradientRenderer;
	private readonly imageRenderer: ImageElementRenderer;
	private readonly textRenderer: TextElementRenderer;
	private readonly meshRenderer: MeshElementRenderer;
	private readonly reference3dRenderer: Reference3DElementRenderer;
	private readonly pathRenderer: PathElementRenderer;

	public constructor(deps: ElementRendererDeps) {
		this.deps = deps;
		this.gradientRenderer = new GradientRenderer({
			device: deps.device,
			gradient: deps.gradient,
			// Accessor, not a snapshot: deps.gradientCache itself resolves the
			// cache manager's active document scope per access, and this chain
			// must not collapse it into a fixed instance.
			get gradientCache() {
				return deps.gradientCache;
			},
			getMaskBindGroup: deps.getMaskBindGroup,
			getBindGroup: deps.getBindGroup,
			getTransformsBindGroup: deps.getTransformsBindGroup,
		});
		// Constructed after gradientRenderer — the path fill/stroke chain routes
		// gradient and pattern draws through that shared instance.
		this.pathRenderer = new PathElementRenderer({
			device: deps.device,
			strokePipeline: deps.strokePipeline,
			stencilFanWritePipeline: deps.stencilFanWritePipeline,
			stencilCoverPipeline: deps.stencilCoverPipeline,
			strokeUnionPipeline: deps.strokeUnionPipeline,
			stencilZeroPipeline: deps.stencilZeroPipeline,
			pulledGeometryPipeline: deps.pulledGeometryPipeline,
			pulledStencilFanWritePipeline: deps.pulledStencilFanWritePipeline,
			dummyGradientBindGroup: deps.dummyGradientBindGroup,
			getBindGroup: deps.getBindGroup,
			getTransformsBindGroup: deps.getTransformsBindGroup,
			getMaskBindGroup: deps.getMaskBindGroup,
			resolveWorldFillBounds: (elementId, bounds) => {
				const localBounds = deps.getLocalBounds(elementId);
				if (
					!localBounds ||
					deps.getTransformIndex(elementId) !==
						deps.renderState.currentTransformIndex
				) {
					return null;
				}
				return transformFillBoundsToWorld(
					bounds,
					deps.getComposedTransform(elementId),
					localBounds,
				);
			},
			renderState: deps.renderState,
			assetState: deps.assetState,
			filterRenderer: deps.filterRenderer,
			strokeBatchContext: deps.strokeBatchContext,
			// Accessors, not snapshots: deps.<cache> resolves the cache manager's
			// active document scope per access; collapsing them into fixed
			// instances here would break document switching.
			get geometryCache() {
				return deps.geometryCache;
			},
			get strokeCache() {
				return deps.strokeCache;
			},
			get stencilFillCache() {
				return deps.stencilFillCache;
			},
			getCompoundPathGeometryCache: deps.getCompoundPathGeometryCache,
			getBlendCache: deps.getBlendCache,
			geometryStore: deps.geometryStore,
			runBatcher: deps.runBatcher,
			gradientRenderer: this.gradientRenderer,
			resolvePatternTexture: deps.resolvePatternTexture,
			ensureBrushTexture: (uid, files) => this.ensureBrushTexture(uid, files),
		});
		this.imageRenderer = new ImageElementRenderer({
			device: deps.device,
			strokePipeline: deps.strokePipeline,
			dummyGradientBindGroup: deps.dummyGradientBindGroup,
			getMaskBindGroup: deps.getMaskBindGroup,
			assetState: deps.assetState,
			blitTextureToCanvas: deps.blitTextureToCanvas,
			blitQuadToCanvas: deps.blitQuadToCanvas,
			blitMeshToCanvas: deps.blitMeshToCanvas,
			filterRenderer: deps.filterRenderer,
			getBindGroup: deps.getBindGroup,
			getTransformsBindGroup: deps.getTransformsBindGroup,
			getParentGroupMap: deps.getParentGroupMap,
		});
		this.textRenderer = new TextElementRenderer({
			textState: deps.textState,
			renderState: deps.renderState,
			filterRenderer: deps.filterRenderer,
			renderPath: (pass, path, alpha, pt) =>
				this.pathRenderer.renderPath(pass, path, alpha, pt),
		});
		this.meshRenderer = new MeshElementRenderer({
			getMeshWarpCache: deps.getMeshWarpCache,
			dispatchElement: (pass, el, map, alpha, pt) =>
				this.dispatchElementDirect(pass, el, map, alpha, pt),
			renderWarpedImage: (pass, image, alpha, grid) =>
				this.imageRenderer.renderImageWarped(
					pass,
					image,
					this.deps.assetState.currentFiles,
					alpha,
					grid,
				),
			getTextGlyphPaths: (el) => this.textRenderer.getWarpGlyphPaths(el),
			getComposedTransform: (id) => deps.getComposedTransform(id),
			getLocalBounds: (id) => deps.getLocalBounds(id),
			getTransformIndex: (id) => deps.getTransformIndex(id),
			getTransientMask: (id) => {
				const bindGroup = deps.getTransientMaskBindGroup(id);
				if (!bindGroup) return null;
				return { bindGroup, transformIndex: deps.getTransformIndex(id) };
			},
			renderState: deps.renderState,
		});
		this.reference3dRenderer = new Reference3DElementRenderer({
			device: deps.device,
			strokePipeline: deps.strokePipeline,
			dummyGradientBindGroup: deps.dummyGradientBindGroup,
			getMaskBindGroup: deps.getMaskBindGroup,
			assetState: deps.assetState,
			getRasterScale: deps.getRasterScale,
			blitTextureToCanvas: deps.blitTextureToCanvas,
			blitQuadToCanvas: deps.blitQuadToCanvas,
			getBindGroup: deps.getBindGroup,
			getTransformsBindGroup: deps.getTransformsBindGroup,
			getParentGroupMap: deps.getParentGroupMap,
			getReference3DContext: () => deps.getReference3DContext?.() ?? null,
		});
	}

	/** Reset per-frame pool indices. Call at the start of each render frame. */
	public beginFrame(): void {
		// The fill-vertex batch machinery lives in the path renderer.
		this.pathRenderer.beginFrame();
	}

	/**
	 * Upload all accumulated fill vertex data to the GPU in a single
	 * writeBuffer call.  Must be called after the render pass ends but
	 * before queue.submit().
	 */
	public flushFillBatch(): void {
		this.pathRenderer.flushFillBatch();
	}

	// ── Pure utility methods ──────────────────────────────────────────────

	public getBlendModeIndex(blendMode: BlendMode): number {
		const index = BLEND_MODE_ORDER.indexOf(blendMode);
		return index >= 0 ? index : 0;
	}

	public getCompositionModeIndex(compositionMode: CompositionMode): number {
		const index = COMPOSITION_MODE_ORDER.indexOf(compositionMode);
		return index >= 0 ? index : 0;
	}

	public getCurrentRenderTargetBounds(): WorldBBox | null {
		if (this.deps.viewportState.bounds) {
			// CanvasLayer writes the current render target's world coverage here for
			// prebuf/offscreen passes. Using that value keeps composite and blit
			// bounds aligned with the texture we are actually drawing into, instead
			// of reconstructing bounds from viewportState.current and accidentally
			// snapping back to the final rotated viewport.
			return brandWorldBBox(this.deps.viewportState.bounds);
		}

		if (
			!this.deps.viewportState.current ||
			this.deps.viewportState.width <= 0 ||
			this.deps.viewportState.height <= 0
		) {
			return null;
		}

		const halfW =
			this.deps.viewportState.width /
			(2 * this.deps.viewportState.current.zoom);
		const halfH =
			this.deps.viewportState.height /
			(2 * this.deps.viewportState.current.zoom);
		return brandWorldBBox({
			minX: this.deps.viewportState.current.x - halfW,
			minY: this.deps.viewportState.current.y - halfH,
			maxX: this.deps.viewportState.current.x + halfW,
			maxY: this.deps.viewportState.current.y + halfH,
			width: halfW * 2,
			height: halfH * 2,
		});
	}

	// ── Element dispatch ──────────────────────────────────────────────────
	public dispatchElementDirect(
		passEncoder: GPURenderPassEncoder,
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
		alpha: number,
		pipelineType: PipelineType,
	): void {
		const handler = this.elementDispatchTable[element.type];
		if (handler) {
			handler(passEncoder, element, elementsMap, alpha, pipelineType);
		}
	}

	private readonly elementDispatchTable: Partial<
		Record<
			AnyArtObject["type"],
			(
				passEncoder: GPURenderPassEncoder,
				element: AnyArtObject,
				elementsMap: Map<string, AnyArtObject>,
				alpha: number,
				pipelineType: PipelineType,
			) => void
		>
	> = {
		path: (pass, el, _map, alpha, pt) => {
			return this.pathRenderer.renderPath(pass, el as Path, alpha, pt);
		},
		image: (pass, el, map, alpha) => {
			return this.imageRenderer.renderImage(
				pass,
				el as ImageObject,
				this.deps.assetState.currentFiles,
				map,
				alpha,
			);
		},
		"compound-path": (pass, el, map, alpha, pt) => {
			return this.pathRenderer.renderCompoundPath(
				pass,
				el as CompoundPath,
				map,
				alpha,
				pt,
			);
		},
		text: (pass, el, _map, alpha, pt) => {
			return this.textRenderer.renderText(pass, el as TextElement, alpha, pt);
		},
		mesh: (pass, el, map, alpha, pt) => {
			return this.meshRenderer.render(
				pass,
				el as MeshArtObject,
				map,
				alpha,
				pt,
			);
		},
		blend: (pass, el, map, alpha, pt) => {
			return this.pathRenderer.renderBlend(
				pass,
				el as BlendObject,
				map,
				alpha,
				pt,
			);
		},
		reference3d: (pass, el, map, alpha) => {
			// 3D scenes are draft references: excluded from image export unless
			// the element opts in.
			if (
				this.deps.renderState.isExport &&
				(el as Reference3DElement).includeInExport !== true
			) {
				return;
			}
			return this.reference3dRenderer.renderReference3D(
				pass,
				el as Reference3DElement,
				map,
				alpha,
			);
		},
	};

	// ── Path rendering (delegated to PathElementRenderer) ─────────────────

	public renderPath(
		passEncoder: GPURenderPassEncoder,
		path: Path,
		alphaMultiplier: number = 1.0,
		pipelineType: PipelineType = "main",
	): void {
		this.pathRenderer.renderPath(
			passEncoder,
			path,
			alphaMultiplier,
			pipelineType,
		);
	}

	public renderAppearancePasses(
		passEncoder: GPURenderPassEncoder,
		path: Path,
		passes: readonly ResolvedAppearancePass[],
		alphaMultiplier: number = 1.0,
		pipelineType: PipelineType = "main",
	): void {
		this.pathRenderer.renderAppearancePasses(
			passEncoder,
			path,
			passes,
			alphaMultiplier,
			pipelineType,
		);
	}

	public renderPathFill(
		passEncoder: GPURenderPassEncoder,
		segments: DrawableSegments,
		fill: FillColor,
		alphaMultiplier: number,
		pipelineType: PipelineType = "main",
		elementId?: string,
	): void {
		this.pathRenderer.renderPathFill(
			passEncoder,
			segments,
			fill,
			alphaMultiplier,
			pipelineType,
			elementId,
		);
	}

	/**
	 * Warp resolution of a mesh container (cached). The mask pass reads it to
	 * pick up clip groups that live inside the mesh: their clip path warps with
	 * the members, so the mask has to come from the warped geometry.
	 */
	public resolveMeshWarp(
		mesh: MeshArtObject,
		elementsMap: Map<string, AnyArtObject>,
	): MeshWarpResolution {
		return this.meshRenderer.resolve(mesh, elementsMap);
	}

	/**
	 * Render an element shape to a mask texture.
	 * The element is rendered with a white solid fill so that the mask texture
	 * has white (1.0) pixels in the element shape and black (0.0) elsewhere.
	 * Used by clip group masking and backdrop filter clipping.
	 */
	public renderElementToMask(
		passEncoder: GPURenderPassEncoder,
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
	): void {
		this.deps.renderState.currentTransformIndex = this.deps.getTransformIndex(
			element.id,
		);

		const whiteFillFilter: FillAppearance = {
			uid: "__mask__",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "solid",
						color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
					},
				},
			},
		};

		switch (element.type) {
			case "path": {
				const maskPath: Path = {
					...element,
					filters: [whiteFillFilter],
				};
				this.pathRenderer.renderPath(
					passEncoder,
					maskPath,
					1.0,
					"offscreen",
					"mask",
				);
				break;
			}

			case "text": {
				if (!this.deps.textState.renderer) return;

				const cacheKey =
					this.deps.textState.renderer.computeTextCacheKey(element);
				const cachedText = this.deps.textState.pathCache.get(cacheKey);

				if (!cachedText) {
					this.requestTextPathCache(cacheKey, element);
					return;
				}

				this.syncTextBoundsIfNeeded(element, cachedText.localBounds);

				const ox = element.x;
				const oy = element.y;

				for (const path of cachedText.paths) {
					const offsetPath: Path = {
						...path,
						filters: [whiteFillFilter],
						segments: path.segments.map((seg) => ({
							...seg,
							start: seg.start
								? {
										...seg.start,
										x: seg.start.x + ox,
										y: seg.start.y + oy,
									}
								: undefined,
							cp1: seg.cp1,
							cp2: seg.cp2,
							end: {
								...seg.end,
								x: seg.end.x + ox,
								y: seg.end.y + oy,
							},
						})),
					};
					this.pathRenderer.renderPath(
						passEncoder,
						offsetPath,
						1.0,
						"offscreen",
						"mask",
					);
				}
				break;
			}

			case "compound-path": {
				// Force white fill for mask rendering, same as path case.
				// isMaskRender=true makes createCompoundPathRenderPath
				// skip the default black stroke and apply fill-only.
				const maskCompound: CompoundPath = {
					...element,
					filters: [whiteFillFilter],
				};
				this.pathRenderer.renderCompoundPath(
					passEncoder,
					maskCompound,
					elementsMap,
					1.0,
					"offscreen",
					true,
				);
				break;
			}

			case "group": {
				const childElements = element.childIds
					.map((id) => elementsMap.get(id))
					.filter((el): el is AnyArtObject => el !== undefined);
				for (const child of childElements) {
					this.renderElementToMask(passEncoder, child, elementsMap);
				}
				break;
			}

			case "mesh": {
				// Warped transient paths (incl. text glyph outlines) fill the mask;
				// non-path transients contribute nothing to the silhouette.
				const { transients } = this.meshRenderer.resolve(element, elementsMap);
				for (const transient of transients) {
					if (transient.type !== "path") continue;
					this.pathRenderer.renderPath(
						passEncoder,
						{ ...transient, filters: [whiteFillFilter] },
						1.0,
						"offscreen",
						"mask",
					);
				}
				break;
			}
		}
	}

	// ── Asset/text helpers ─────────────────────────────────────────────────

	/**
	 * Ensure brush texture is loaded. Returns true if ready, false if loading.
	 * Async loading triggers re-render on completion.
	 */
	public ensureBrushTexture(
		textureFileUid: string,
		files: EmbeddedFile[],
	): boolean {
		const textureManager = this.deps.strokeBatchContext.getTextureManager();
		// Def-rasterized textures live only in the texture manager (there is no
		// embedded file to load them from) — presence is managed by
		// CanvasLayer.preRenderBrushDefs.
		if (textureFileUid.startsWith("def:")) {
			return textureManager.hasTexture(textureFileUid);
		}
		if (textureManager.hasTexture(textureFileUid)) return true;

		if (this.deps.assetState.pendingBrushTextureLoads.has(textureFileUid))
			return false;

		const file = files.find((f) => f.uid === textureFileUid);
		if (!file) {
			console.warn(`Brush texture file not found: ${textureFileUid}`);
			return true;
		}

		this.deps.assetState.pendingBrushTextureLoads.add(textureFileUid);
		textureManager
			.loadFromEmbeddedFile(
				textureFileUid,
				file.bin as Uint8Array<ArrayBuffer>,
				file.type,
			)
			.then(() => {
				this.deps.assetState.pendingBrushTextureLoads.delete(textureFileUid);
				this.deps.textState.onRequestRender?.();
			})
			.catch((err) => {
				console.error(`Failed to load brush texture ${textureFileUid}:`, err);
				this.deps.assetState.pendingBrushTextureLoads.delete(textureFileUid);
			});

		return false;
	}

	private requestTextPathCache(cacheKey: string, element: TextElement): void {
		this.textRenderer.requestTextPathCache(cacheKey, element);
	}

	private syncTextBoundsIfNeeded(
		element: TextElement,
		localBounds: BoundingBox,
	): void {
		this.textRenderer.syncTextBoundsIfNeeded(element, localBounds);
	}

	public invalidateTextCache(elementId?: string): void {
		this.textRenderer.invalidateTextCache(elementId);
	}

	public async ensureTextPaths(element: TextElement): Promise<void> {
		return this.textRenderer.ensureTextPaths(element);
	}

	/**
	 * Fire-and-forget: warm the glyph-outline cache for a Text element and
	 * request a re-render once it resolves (async font/layout loading). Unlike
	 * ensureTextPaths (an awaited pre-warm with no render trigger, used for
	 * export), this also de-dupes concurrent loads for the same element and
	 * calls onRequestRender on completion — the same cache-miss handling
	 * renderElementToMask/renderText already use.
	 */
	public requestTextOutline(element: TextElement): void {
		if (!this.deps.textState.renderer) return;
		const cacheKey = this.deps.textState.renderer.computeTextCacheKey(element);
		this.textRenderer.requestTextPathCache(cacheKey, element);
	}

	/**
	 * Pre-warm image textures for an export pass. Loading is async, so images
	 * must be decoded before the synchronous render or they render as holes.
	 */
	public async ensureImageTextures(
		document: Document,
		elementFilter?: ReadonlySet<string>,
	): Promise<void> {
		const imageElements = Object.values(document.objects).filter(
			(el): el is ImageObject =>
				el.type === "image" && (!elementFilter || elementFilter.has(el.id)),
		);

		await Promise.all(
			imageElements.map((image) => {
				const file = document.files.find((f) => f.uid === image.fileUid);
				return file ? this.imageRenderer.ensureImageTexture(file) : null;
			}),
		);
	}

	/**
	 * Pre-warm Reference3D textures at the document rasterization scale (export
	 * path). No-op while the Reference3D context is not wired.
	 */
	public async ensureReference3DTextures(
		document: Document,
		elementFilter?: ReadonlySet<string>,
	): Promise<void> {
		await this.reference3dRenderer.ensureTextures(document, elementFilter);
	}

	/**
	 * Destroy all cached Reference3D textures. Called by RenderOrchestrator on
	 * teardown and device loss, alongside CanvasLayer's asset cache cleanup.
	 */
	public destroyReference3DTextures(): void {
		this.reference3dRenderer.destroyTextures();
	}
}

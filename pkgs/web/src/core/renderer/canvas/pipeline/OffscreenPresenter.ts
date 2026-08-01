/**
 * Offscreen rendering infrastructure extracted from CanvasLayer.
 *
 * Handles creating temporary offscreen textures and render passes for:
 * - Filter pre-processing (element → texture → filter → blit)
 * - Group compositing (group children → texture → composite)
 * - Clip group stencil masking (children → texture → stencil → blit)
 */

import {
	type AnyArtObject,
	type BoundingBox,
	type ElementTransform,
	type Filter,
	type Group,
	getTransform,
	isGroup,
	isIdentityTransform,
	type Path,
	type StrokeAppearance,
} from "../../../schema";
import {
	boundsIntersect,
	boundsIntersectionBox,
	brandWorldBBox,
	calculateElementBounds,
	expandBounds,
	type LocalBoundsCache,
	type WorldBBox,
} from "../../../utils/geometry/bounds";
import {
	applyTransformToBounds,
	composeTransforms,
} from "../../../utils/geometry/geometry";
import { capFilterBakeDensity } from "../CanvasLayer.helpers";
import {
	type BlitQuadToCanvasFn,
	type BlitTextureToCanvasFn,
	type BlitUVRect,
	type CompositeRenderContext,
	type CompositeState,
	type DispatchElementDirectFn,
	type FilteredTextureInfo,
	FULL_BLIT_UV_RECT,
	MSAA_SAMPLE_COUNT,
	type RenderElementsFn,
	type RenderElementToMaskFn,
	type RenderState,
	type SharedRenderBindings,
	type ViewportState,
} from "../CanvasLayerTypes";
import { MaskedBlitBindGroupCache } from "../caches/BindGroupCache";
import type { FilterRenderer } from "./FilterRenderer";
import { FrameUniformPool } from "./FrameUniformPool";
import { createPassLocalStencilAttachment } from "./PassLocalStencil";
import { calculatePreFilteredElementBounds } from "./RenderPlanner";
import {
	type ColorRenderSurface,
	createFrameTextureRef,
	createRenderSurface,
	type RasterizedRenderSurface,
	type RenderSurface,
	releaseRenderSurface,
	replaceRenderSurface,
} from "./RenderSurface";
import type { TexturePool } from "./TexturePool";
import type { UniformEntry, UniformScope } from "./UniformScope";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

interface OffscreenPresenterDeps extends SharedRenderBindings {
	strokePipeline: GPURenderPipeline;
	blitWithMaskPipeline: GPURenderPipeline;
	blitWithEraseMaskPipeline: GPURenderPipeline;
	blitWithMaskBindGroupLayout: GPUBindGroupLayout;
	dummyGradientBindGroup: GPUBindGroup;
	dummyMaskBindGroup: GPUBindGroup;

	viewportState: ViewportState;
	renderState: RenderState;
	compositeState: CompositeState;

	filterRenderer: FilterRenderer;
	uniformScope: UniformScope;

	getTransformIndex: (elementId: string) => number;
	setActiveBindGroup: (
		bindGroup: GPUBindGroup | null,
		uniformBuffer?: GPUBuffer | null,
		replace?: boolean,
	) => void;

	texturePool: TexturePool;

	renderElements: RenderElementsFn;
	dispatchElementDirect: DispatchElementDirectFn;
	blitTextureToCanvas: BlitTextureToCanvasFn;
	renderElementToMask: RenderElementToMaskFn;
	blitQuadToCanvas: BlitQuadToCanvasFn;
	/** The inline mask assigned to an element this frame, or the dummy when none. */
	getElementMaskBindGroup: (elementId: string) => GPUBindGroup;
	/** The ordered post-mask stack assigned to an element. Group
	 *  children are baked into the group's texture through their own path, which
	 *  the main pass's inline BG3 and applyPostMasks both miss — so a masked
	 *  child needs its mask multiplied in here, or a filter on the group (a drop
	 *  shadow) reads the child before the mask removed anything. */
	getElementPostMasks: (elementId: string) => readonly {
		bindGroup: GPUBindGroup;
		bounds: BoundingBox;
		inverted?: boolean;
	}[];
	/** The document rasterization scale R (see references/rasterization-dpi.md).
	 *  A dep rather than a `rasterScale` argument so that a pass re-baking an
	 *  R-rasterized intermediary cannot fall back to the zoom by omission. */
	getRasterScale: () => number;
}

export interface WorldMaskAssignment {
	bindGroup: GPUBindGroup;
	bounds: BoundingBox;
	inverted?: boolean;
}

// ---------------------------------------------------------------------------
// OffscreenPresenter
// ---------------------------------------------------------------------------

/** Float32 element count for clip blit uniforms.
 * 20 floats = 80 bytes to accommodate outer mask bounds (4 extra floats). */
const CLIP_BLIT_F32_COUNT = 20;
const CLIP_BLIT_BUFFER_SIZE = CLIP_BLIT_F32_COUNT * 4;

export class OffscreenPresenter {
	private readonly clipBlitF32 = new Float32Array(CLIP_BLIT_F32_COUNT);
	private readonly clipBlitPool: FrameUniformPool;
	private clipBlitBGCache = new MaskedBlitBindGroupCache();
	private whiteMaskTexture: GPUTexture | null = null;
	/** Textures whose destroy must be deferred until after queue.submit(). */
	private deferredDestroys: GPUTexture[] = [];

	public constructor(private readonly deps: OffscreenPresenterDeps) {
		this.clipBlitPool = new FrameUniformPool(
			deps.device,
			"Clip Blit Uniform Buffer",
		);
	}

	/** Reset pool indices and flush deferred destroys from the previous frame. */
	public resetFrame(): void {
		this.clipBlitPool.beginFrame();
		// Destroy textures deferred during the previous frame.  By deferring
		// to the next frame's start (instead of right after queue.submit),
		// the GPU has had time to finish executing the previous command buffer.
		for (const tex of this.deferredDestroys) tex.destroy();
		this.deferredDestroys.length = 0;
	}

	/** Destroy all textures that were deferred during the frame. Call after submit. */
	public flushDeferredDestroys(): void {
		for (const tex of this.deferredDestroys) tex.destroy();
		this.deferredDestroys.length = 0;
	}

	/**
	 * Save the current deferred destroy list and replace it with an empty one.
	 * Use at the start of an isolated export render to prevent flushDeferredDestroys
	 * from destroying textures belonging to the main canvas frame.
	 * Must be paired with restoreDeferredList().
	 */
	public saveAndClearDeferredList(): GPUTexture[] {
		const saved = this.deferredDestroys.slice();
		this.deferredDestroys.length = 0;
		return saved;
	}

	/**
	 * Restore a previously saved deferred destroy list.
	 * Call after the export render has fully flushed its own deferred items.
	 */
	public restoreDeferredList(saved: GPUTexture[]): void {
		this.deferredDestroys.push(...saved);
	}

	/**
	 * Release a texture.  If it belongs to the pool it is returned for reuse;
	 * otherwise it is scheduled for destruction after the next queue.submit().
	 */
	public deferDestroy(texture: GPUTexture | null | undefined): void {
		if (!texture) return;
		if (this.deps.texturePool.release(texture)) return;
		this.deferredDestroys.push(texture);
	}

	/** Release all pooled GPU resources. */
	public destroy(): void {
		this.clipBlitPool.destroy();
		this.whiteMaskTexture?.destroy();
		this.whiteMaskTexture = null;
	}

	/**
	 * Multiply a world-space mask into an already-rendered texture, returning a
	 * fresh texture with the mask applied.
	 *
	 * This is how `ArtObject.mask` reaches elements that cannot take the inline
	 * BG3 path: the element (or its filter output) is baked first, then masked
	 * here. Doing it as a separate step is what puts the mask *after* filters —
	 * blurring an element no longer smears its mask edge outward.
	 *
	 * Returns null when the source is fully culled.
	 */
	public applyWorldMaskToTexture(
		encoder: GPUCommandEncoder,
		source: RenderSurface,
		mask: { bindGroup: GPUBindGroup; bounds: BoundingBox; inverted?: boolean },
		/** Texels per world px that `source` already holds. The result is baked at
		 *  this, or at R when it is finer — masking must not be the step that puts
		 *  an element below the document's rasterization resolution. */
		sourceScale: number,
		/** Limit the result to this region of `sourceBounds`. A source covering
		 *  more than the element it belongs to (the glass composite spans the whole
		 *  viewport) would otherwise be re-baked whole, which costs
		 *  `viewportWorldWidth x scale` — unbounded as the viewport zooms out. */
		coverBounds?: BoundingBox,
	): ColorRenderSurface | null {
		const sourceBounds = brandWorldBBox(source.placement.bounds);
		const sourceUvRect = source.placement.uvRect;
		let bakeBounds = sourceBounds;
		let bakeUvRect = sourceUvRect;
		if (coverBounds) {
			const clipped = boundsIntersectionBox(sourceBounds, coverBounds);
			if (!clipped) return null;
			bakeBounds = brandWorldBBox(clipped);
			bakeUvRect = subUvRect(sourceBounds, sourceUvRect, clipped);
		}

		// skipCull: the caller already decided this element is on screen, and
		// culling again here would drop masks during offscreen bakes.
		const ctx = this.createOffscreenPass(
			encoder,
			"Object Mask",
			bakeBounds,
			Math.max(sourceScale, this.deps.getRasterScale()),
			true,
		);
		if (!ctx) return null;

		const b = ctx.coverageBounds;
		const f = this.clipBlitF32;
		f[0] = b.minX;
		f[1] = b.minY;
		f[2] = b.maxX;
		f[3] = b.maxY;
		f[4] = 1.0; // opacity is applied later, by whoever composites this
		f[5] = mask.inverted ? 1 : 0;
		f[6] = 0;
		f[7] = 0;
		f[8] = bakeUvRect.minU;
		f[9] = bakeUvRect.minV;
		f[10] = bakeUvRect.maxU;
		f[11] = bakeUvRect.maxV;
		f[12] = mask.bounds.minX;
		f[13] = mask.bounds.minY;
		f[14] = mask.bounds.maxX;
		f[15] = mask.bounds.maxY;

		const blitUniformBuffer = this.clipBlitPool.acquire(CLIP_BLIT_BUFFER_SIZE);
		this.deps.device.queue.writeBuffer(blitUniformBuffer, 0, f);

		const blitBindGroup = this.deps.device.createBindGroup({
			label: "Object Mask Blit Bind Group",
			layout: this.deps.blitWithMaskBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: blitUniformBuffer } },
				{ binding: 1, resource: this.deps.sampler },
				{ binding: 2, resource: source.texture.texture.createView() },
				// The UV-aligned mask slot is unused here — the mask arrives
				// through the world-space outer slot instead — so feed it an
				// opaque white texture, which multiplies by 1.
				{ binding: 3, resource: this.getWhiteMaskTexture().createView() },
			],
		});

		const pass = ctx.passEncoder;
		pass.setPipeline(this.deps.blitWithMaskPipeline);
		pass.setBindGroup(0, ctx.entry.bindGroup);
		pass.setBindGroup(1, blitBindGroup);
		pass.setBindGroup(2, mask.bindGroup);
		pass.draw(6);
		pass.end();

		this.deferDestroy(ctx.offscreenStencilTexture);
		this.deps.setActiveBindGroup(null);
		this.deps.viewportState.bounds = ctx.savedViewportBounds;

		return createRenderSurface(
			createFrameTextureRef(ctx.offscreenTexture, (texture) =>
				this.deferDestroy(texture),
			),
			{
				kind: "world-aabb",
				bounds: ctx.coverageBounds,
				uvRect: ctx.blitUvRect,
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
	}

	/**
	 * Flatten a quad-mapped layer into a texture covering its world AABB.
	 *
	 * A quad layer's texture maps to four arbitrary corners, not to a rectangle,
	 * so a world-space mask cannot be multiplied into it as-is. Drawing it once
	 * through its own quad blit puts it back on a world-aligned rectangle, which
	 * {@link applyWorldMaskToTexture} can then mask like any other.
	 */
	public bakeQuadToTexture(
		encoder: GPUCommandEncoder,
		source: RenderSurface,
	): ColorRenderSurface | null {
		if (source.placement.kind !== "world-quad") return null;
		const ctx = this.createOffscreenPass(
			encoder,
			"Quad Flatten",
			brandWorldBBox(source.placement.bounds),
			this.deps.getRasterScale(),
			true,
		);
		if (!ctx) return null;

		this.deps.blitQuadToCanvas(
			ctx.passEncoder,
			source.texture.texture,
			source.placement.quad,
			1,
			source.placement.uvRect,
		);
		ctx.passEncoder.end();

		this.deferDestroy(ctx.offscreenStencilTexture);
		this.deps.setActiveBindGroup(null);
		this.deps.viewportState.bounds = ctx.savedViewportBounds;

		return createRenderSurface(
			createFrameTextureRef(ctx.offscreenTexture, (texture) =>
				this.deferDestroy(texture),
			),
			{
				kind: "world-aabb",
				bounds: ctx.coverageBounds,
				uvRect: ctx.blitUvRect,
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
	}

	/** 1x1 opaque white, used to no-op the UV-aligned mask slot. */
	private getWhiteMaskTexture(): GPUTexture {
		if (this.whiteMaskTexture) return this.whiteMaskTexture;
		const texture = this.deps.device.createTexture({
			label: "White Mask (no-op)",
			size: [1, 1],
			format: this.deps.canvasFormat,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		this.deps.device.queue.writeTexture(
			{ texture },
			new Uint8Array([255, 255, 255, 255]),
			{ bytesPerRow: 4 },
			{ width: 1, height: 1 },
		);
		this.whiteMaskTexture = texture;
		return texture;
	}
	/**
	 * Render a single element to an offscreen texture.
	 * Groups are rendered by recursing into their children via renderElements.
	 */
	public renderElementToTexture(
		encoder: GPUCommandEncoder,
		element: AnyArtObject,
		textureBounds: WorldBBox,
		elementsMap?: Map<string, AnyArtObject>,
		rasterScale?: number,
		/** Skip viewport culling — see createOffscreenPass. */
		skipCull = false,
		/** Opt-in output clamp margin — see createOffscreenPass (null = no clamp). */
		filterMargin: number | null = null,
		/**
		 * Pre-baked filtered textures for the element / its children. The repeat
		 * source bake passes them so an absorbed source with a 3D solid or other
		 * postProcess filter renders its filtered result, not the flat geometry.
		 */
		filteredTextures?: Map<string, FilteredTextureInfo>,
	): RasterizedRenderSurface | null {
		const ctx = this.createOffscreenPass(
			encoder,
			"Element",
			textureBounds,
			rasterScale,
			skipCull,
			filterMargin,
		);
		if (!ctx) return null;

		const {
			offscreenTexture,
			offscreenStencilTexture,
			passEncoder: offscreenPassEncoder,
			savedViewportBounds,
			effectiveZoom,
			blitUvRect,
		} = ctx;

		// Set transform index so the GPU shader applies the correct element transform
		this.deps.renderState.currentTransformIndex = this.deps.getTransformIndex(
			element.id,
		);
		// ...and the matching mask. The GPU transform entry still carries this
		// element's maskIndex, so leaving BG3 on whatever the previous draw bound
		// would clip the bake against an unrelated mask texture.
		this.deps.renderState.currentMaskBindGroup =
			this.deps.getElementMaskBindGroup(element.id);

		// Render element based on type
		let activePass = offscreenPassEncoder;
		if (isGroup(element)) {
			if (elementsMap) {
				activePass = this.deps.renderElements(
					activePass,
					[element],
					filteredTextures ?? new Map(),
					elementsMap,
					1.0,
					null,
					undefined,
					"offscreen",
				);
			} else {
				console.warn("Group rendering to texture requires elementsMap");
			}
		} else {
			this.deps.dispatchElementDirect(
				offscreenPassEncoder,
				element,
				elementsMap ?? new Map(),
				1.0,
				"offscreen",
			);
		}

		activePass.end();
		this.deferDestroy(offscreenStencilTexture);
		this.deps.setActiveBindGroup(null);
		this.deps.viewportState.bounds = savedViewportBounds;

		return {
			...createRenderSurface(
				createFrameTextureRef(offscreenTexture, (texture) =>
					this.deferDestroy(texture),
				),
				{
					kind: "world-aabb",
					bounds: ctx.coverageBounds,
					uvRect: blitUvRect,
				},
				{
					role: "color",
					alphaMode: "premultiplied",
					opacityState: "intrinsic",
				},
			),
			effectiveZoom,
		};
	}

	/**
	 * Render a path element with erase masks applied.
	 *
	 * Three-pass pipeline:
	 *   1. Render the path to an offscreen texture (normal rendering)
	 *   2. Render all eraseMasks to a mask texture (using brush renderer)
	 *   3. Blit with alpha subtraction: finalAlpha = src * (1 - mask.a * opacity)
	 *
	 * Each eraseMask with opacity < 1 has its opacity baked into the mask
	 * rendering (stamp opacity scaled by mask.opacity).
	 */
	public renderWithEraseMasks(
		encoder: GPUCommandEncoder,
		passEncoder: GPURenderPassEncoder,
		path: Path,
		elementsMap: Map<string, AnyArtObject>,
		_alphaMultiplier: number,
		elementBounds: WorldBBox,
		compositeContext?: CompositeRenderContext,
	): GPURenderPassEncoder {
		const eraseMasks = path.eraseMasks;
		if (!eraseMasks || eraseMasks.length === 0 || !compositeContext) {
			return passEncoder;
		}

		if (
			Math.ceil(elementBounds.width) <= 0 ||
			Math.ceil(elementBounds.height) <= 0
		) {
			return passEncoder;
		}

		// End the active pass before starting offscreen passes
		passEncoder.end();

		// Step 1: Render the path element to offscreen texture
		const sourceResult = this.renderElementToTexture(
			encoder,
			path,
			elementBounds,
			elementsMap,
		);
		if (!sourceResult) {
			return compositeContext.restartPass();
		}
		const sourceTexture = sourceResult.texture.texture;

		// Step 2: Render all eraseMasks to a mask texture
		const maskCtx = this.createOffscreenPass(
			encoder,
			"Erase Mask",
			elementBounds,
		);
		if (!maskCtx) {
			releaseRenderSurface(sourceResult);
			return compositeContext.restartPass();
		}

		// Create temporary Path objects for each eraseMask and render them
		for (const mask of eraseMasks) {
			const maskPath: Path = {
				type: "path",
				id: `__erase_mask_${mask.uid}`,
				segments: mask.segments,
				opacity: mask.opacity,
				blendMode: "normal",
				transform: path.transform,
				filters: [
					{
						uid: `__erase_mask_filter_${mask.uid}`,
						processor: "stroke",
						enabled: true,
						opacity: 1,
						blendMode: "normal",
						paramData: {
							version: "1",
							params: {
								strokeColor: mask.strokeColor,
								brushSettings: mask.brushSettings,
							},
						},
					} satisfies StrokeAppearance,
				],
			};

			this.deps.renderState.currentTransformIndex = this.deps.getTransformIndex(
				path.id,
			);
			this.deps.dispatchElementDirect(
				maskCtx.passEncoder,
				maskPath,
				elementsMap,
				mask.opacity,
				"offscreen",
			);
		}

		maskCtx.passEncoder.end();
		this.deferDestroy(maskCtx.offscreenStencilTexture);
		this.deps.setActiveBindGroup(null);
		this.deps.viewportState.bounds = maskCtx.savedViewportBounds;

		// Step 3: Blit source with erase mask (alpha subtraction)
		// Use coverageBounds (viewport intersection) for blit quad, not full elementBounds.
		// The offscreen textures only contain content within coverageBounds;
		// using elementBounds would stretch the texture and distort strokes.
		const blitBounds = sourceResult.placement.bounds;
		const srcUv = sourceResult.placement.uvRect;
		const maskUv = maskCtx.blitUvRect;
		const f = this.clipBlitF32;
		f[0] = blitBounds.minX;
		f[1] = blitBounds.minY;
		f[2] = blitBounds.maxX;
		f[3] = blitBounds.maxY;
		f[4] = 1.0; // opacity already applied during mask rendering
		f[5] = 0;
		f[6] = 0;
		f[7] = 0;
		f[8] = srcUv.minU;
		f[9] = srcUv.minV;
		f[10] = srcUv.maxU;
		f[11] = srcUv.maxV;
		f[12] = maskUv.minU;
		f[13] = maskUv.minV;
		f[14] = maskUv.maxU;
		f[15] = maskUv.maxV;
		// No outer mask for erase paths — sentinel zeros
		f[16] = 0;
		f[17] = 0;
		f[18] = 0;
		f[19] = 0;

		const bufIdx = this.clipBlitPool.nextIndex;
		const blitUniformBuffer = this.clipBlitPool.acquire(CLIP_BLIT_BUFFER_SIZE);
		this.deps.device.queue.writeBuffer(blitUniformBuffer, 0, f);

		const blitBindGroup = this.clipBlitBGCache.getOrCreate(
			bufIdx,
			sourceTexture,
			maskCtx.offscreenTexture,
			() =>
				this.deps.device.createBindGroup({
					layout: this.deps.blitWithMaskBindGroupLayout,
					entries: [
						{ binding: 0, resource: { buffer: blitUniformBuffer } },
						{ binding: 1, resource: this.deps.sampler },
						{ binding: 2, resource: sourceTexture.createView() },
						{
							binding: 3,
							resource: maskCtx.offscreenTexture.createView(),
						},
					],
				}),
		);

		const blitPass = compositeContext.restartPass();
		blitPass.setPipeline(this.deps.blitWithEraseMaskPipeline);
		blitPass.setBindGroup(0, this.deps.getBindGroup());
		blitPass.setBindGroup(1, blitBindGroup);
		blitPass.setBindGroup(2, this.deps.dummyMaskBindGroup);
		blitPass.draw(6);
		blitPass.end();

		releaseRenderSurface(sourceResult);
		this.deferDestroy(maskCtx.offscreenTexture);

		return compositeContext.restartPass();
	}

	/**
	 * Render a Group element to an offscreen texture, pre-processing child
	 * filters and compositing the result.
	 */
	public renderGroupToTexture(
		encoder: GPUCommandEncoder,
		group: Group,
		textureBounds: WorldBBox,
		elementsMap: Map<string, AnyArtObject>,
		localBoundsCache?: LocalBoundsCache,
		rasterScale?: number,
		/** Opt-in output clamp margin — see createOffscreenPass (null = no clamp). */
		filterMargin: number | null = null,
	): RasterizedRenderSurface | null {
		if (
			Math.ceil(textureBounds.width) <= 0 ||
			Math.ceil(textureBounds.height) <= 0
		)
			return null;

		// First, collect and apply filters for child elements
		const childFilteredTextures = new Map<string, RenderSurface>();

		const childElements = group.childIds
			.filter((id) => id !== group.clipPathId)
			.map((id) => elementsMap.get(id))
			.filter((el): el is AnyArtObject => el !== undefined);

		// Group-level pre-filters deform every child at render time; extract
		// them up front so pre-rasterized children keep the deformation too.
		const groupPreFilters = (group.filters ?? []).filter((f) => {
			const handler = this.deps.filterRenderer.getHandler(f.processor);
			return f.enabled !== false && !!handler?.preProcess;
		});

		// Pre-rasterize only children whose own filters need a post-process
		// pass; everything else renders inline in renderGroupChildrenToTexture,
		// which merges the group pre-filters into each child.
		for (const child of childElements) {
			const childNeedsPostPass = (child.filters ?? []).some(
				(f) =>
					f.enabled !== false &&
					!!this.deps.filterRenderer.getHandler(f.processor)?.postProcess,
			);
			// A masked child is pre-rasterized even without a filter of its own:
			// the inline draw below never applies the mask, so a filter on the
			// group would read the child before the mask removed anything.
			const childMasks = this.deps.getElementPostMasks(child.id);
			if (!childNeedsPostPass && childMasks.length === 0) continue;

			const effectiveChild = groupPreFilters.length
				? ({
						...child,
						filters: [...(child.filters ?? []), ...groupPreFilters],
					} as AnyArtObject)
				: child;
			const childBounds = calculatePreFilteredElementBounds(
				effectiveChild,
				elementsMap,
				this.deps.filterRenderer,
				localBoundsCache,
			);
			const childExpansion = this.deps.filterRenderer.calculateExpansion(
				child.filters ?? [],
				childBounds,
			);
			const childTextureBounds = expandBounds(childBounds, childExpansion);

			const childOffscreenTexture = isGroup(effectiveChild)
				? this.renderGroupToTexture(
						encoder,
						effectiveChild,
						childTextureBounds,
						elementsMap,
						localBoundsCache,
						rasterScale,
						childExpansion,
					)
				: this.renderElementToTexture(
						encoder,
						effectiveChild,
						childTextureBounds,
						elementsMap,
						rasterScale,
						false,
						childExpansion,
					);
			if (!childOffscreenTexture) continue;

			// Filters first, then the mask on their result — a mask before a blur
			// would have its edge smeared outward.
			let childSurface: ColorRenderSurface = childOffscreenTexture;
			if (childNeedsPostPass) {
				const filteredTexture = this.deps.filterRenderer.applyFilters(
					childSurface.texture.texture,
					child.filters ?? [],
					encoder,
					undefined,
					childOffscreenTexture.effectiveZoom,
					// The bake may be clamped smaller than childTextureBounds, so
					// the filter must scale against the actual baked coverage.
					brandWorldBBox(childOffscreenTexture.placement.bounds),
					undefined,
					undefined,
					undefined,
					// Full child rect + the clamped bake's offset within it, so
					// world-anchoring filters stay fixed to the element.
					{
						worldSize: {
							width: childTextureBounds.width,
							height: childTextureBounds.height,
						},
						sourceOffset: {
							x:
								childOffscreenTexture.placement.bounds.minX -
								childTextureBounds.minX,
							y:
								childTextureBounds.maxY -
								childOffscreenTexture.placement.bounds.maxY,
						},
					},
				).texture;
				childSurface = replaceRenderSurface(childSurface, {
					texture: createFrameTextureRef(filteredTexture, (texture) =>
						this.deferDestroy(texture),
					),
					placement: childSurface.placement,
				});
			}
			for (const childMask of childMasks) {
				const masked = this.applyWorldMaskToTexture(
					encoder,
					childSurface,
					childMask,
					this.deps.getRasterScale(),
				);
				if (masked) {
					childSurface = replaceRenderSurface(childSurface, {
						texture: masked.texture,
						placement: masked.placement,
					});
				}
			}

			childFilteredTextures.set(child.id, childSurface);
		}

		const ctx = this.createOffscreenPass(
			encoder,
			"Group",
			textureBounds,
			rasterScale,
			false,
			filterMargin,
		);
		if (!ctx) return null;

		const {
			offscreenTexture,
			offscreenStencilTexture,
			entry,
			passEncoder: offscreenPassEncoder,
			savedViewportBounds,
			effectiveZoom: groupEffectiveZoom,
			blitUvRect: groupBlitUvRect,
		} = ctx;

		const {
			stencilTex: groupStencilTex,
			compositeContext: groupCompositeContext,
		} = this.buildOffscreenCompositeContext(encoder, offscreenTexture, entry);

		const { savedCaptureTexture, offscreenCaptureTexture } =
			this.swapCaptureTexture(offscreenTexture.width, offscreenTexture.height);

		const finalPassEncoder = this.renderGroupChildrenToTexture(
			encoder,
			offscreenPassEncoder,
			childElements,
			elementsMap,
			childFilteredTextures,
			1.0,
			groupCompositeContext,
			undefined,
			groupPreFilters.length > 0 ? groupPreFilters : undefined,
		);

		finalPassEncoder.end();

		// Release child filtered textures now that they've been blitted.
		for (const surface of childFilteredTextures.values()) {
			releaseRenderSurface(surface);
		}

		this.deps.compositeState.captureTexture = savedCaptureTexture;
		this.deferDestroy(offscreenCaptureTexture);

		this.deferDestroy(groupStencilTex);
		this.deferDestroy(offscreenStencilTexture);
		this.deps.setActiveBindGroup(null);
		this.deps.viewportState.bounds = savedViewportBounds;

		return {
			...createRenderSurface(
				createFrameTextureRef(offscreenTexture, (texture) =>
					this.deferDestroy(texture),
				),
				{
					kind: "world-aabb",
					bounds: ctx.coverageBounds,
					uvRect: groupBlitUvRect,
				},
				{
					role: "color",
					alphaMode: "premultiplied",
					opacityState: "intrinsic",
				},
			),
			effectiveZoom: groupEffectiveZoom,
		};
	}

	/**
	 * Render a clip group: render children offscreen, render clip path to
	 * a mask texture, blit with mask.
	 */
	public renderClipGroup(
		encoder: GPUCommandEncoder,
		passEncoder: GPURenderPassEncoder,
		group: Group,
		children: AnyArtObject[],
		filteredTextures: Map<string, FilteredTextureInfo>,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number,
		parentTransform: ElementTransform,
		ancestorTransform: ElementTransform | null,
		skipElementIds?: ReadonlySet<string>,
		compositeContext?: CompositeRenderContext,
		localBoundsCache?: LocalBoundsCache,
		outerMasks: readonly WorldMaskAssignment[] = [],
	): GPURenderPassEncoder {
		if (!group.clipPathId || !compositeContext) {
			return passEncoder;
		}
		passEncoder.end();
		const clipped = this.renderClipGroupToTexture(
			encoder,
			group,
			children,
			filteredTextures,
			elementsMap,
			parentTransform,
			ancestorTransform,
			skipElementIds,
			localBoundsCache,
			outerMasks,
		);
		const blitPass = compositeContext.restartPass();
		if (!clipped) return blitPass;
		this.deps.blitTextureToCanvas(
			blitPass,
			clipped.texture.texture,
			clipped.placement.bounds,
			alphaMultiplier,
			clipped.placement.uvRect,
		);
		releaseRenderSurface(clipped);
		return blitPass;
	}

	/**
	 * Render a clip group to an offscreen texture and return it.
	 * Used when a group has both clipPathId and a non-normal blendMode:
	 * the clip is applied here; the blend mode is applied during compositing.
	 */
	public renderClipGroupToTexture(
		encoder: GPUCommandEncoder,
		group: Group,
		children: AnyArtObject[],
		filteredTextures: Map<string, FilteredTextureInfo>,
		elementsMap: Map<string, AnyArtObject>,
		parentTransform: ElementTransform,
		ancestorTransform: ElementTransform | null,
		skipElementIds?: ReadonlySet<string>,
		localBoundsCache?: LocalBoundsCache,
		outerMasks: readonly WorldMaskAssignment[] = [],
	): ColorRenderSurface | null {
		if (!group.clipPathId) return null;

		const clipPath = elementsMap.get(group.clipPathId);
		if (!clipPath) return null;
		if (children.length === 0) return null;

		let groupBounds = calculateElementBounds(
			group,
			elementsMap,
			localBoundsCache,
		);
		if (ancestorTransform && !isIdentityTransform(ancestorTransform)) {
			groupBounds = brandWorldBBox(
				applyTransformToBounds(groupBounds, ancestorTransform),
			);
		}
		if (Math.ceil(groupBounds.width) <= 0 || Math.ceil(groupBounds.height) <= 0)
			return null;

		// Step 1: Render children to offscreen texture
		const sourceResult = this.renderElementsToOffscreenTexture(
			encoder,
			children,
			groupBounds,
			filteredTextures,
			elementsMap,
			1,
			parentTransform,
			skipElementIds,
			undefined,
			localBoundsCache,
		);
		if (!sourceResult) return null;
		const sourceTexture = sourceResult.texture.texture;

		// Step 2: Render clip path to mask texture
		const maskCtx = this.createOffscreenPass(
			encoder,
			"Clip Mask",
			groupBounds,
			undefined,
			false,
			// No spreading filter on the clip shape: clamp to the visible output
			// so the mask is not allocated to the full (off-screen) group bounds.
			0,
		);
		if (!maskCtx) {
			releaseRenderSurface(sourceResult);
			return null;
		}

		this.deps.renderState.currentTransformIndex = this.deps.getTransformIndex(
			clipPath.id,
		);
		this.deps.renderElementToMask(maskCtx.passEncoder, clipPath, elementsMap);
		maskCtx.passEncoder.end();
		this.deferDestroy(maskCtx.offscreenStencilTexture);
		this.deps.setActiveBindGroup(null);
		this.deps.viewportState.bounds = maskCtx.savedViewportBounds;

		// Step 3: Blit source × mask to a final offscreen texture
		const finalCtx = this.createOffscreenPass(
			encoder,
			"Clipped Blend",
			groupBounds,
			undefined,
			false,
			// Content composited from already-baked source × mask at world
			// positions; clamp to the visible output.
			0,
		);
		if (!finalCtx) {
			releaseRenderSurface(sourceResult);
			this.deferDestroy(maskCtx.offscreenTexture);
			return null;
		}

		const srcUvRect = sourceResult.placement.uvRect;
		const srcBlitBounds = sourceResult.placement.bounds;
		const f = this.clipBlitF32;
		f[0] = srcBlitBounds.minX;
		f[1] = srcBlitBounds.minY;
		f[2] = srcBlitBounds.maxX;
		f[3] = srcBlitBounds.maxY;
		f[4] = 1.0;
		f[5] = 0;
		f[6] = 0;
		f[7] = 0;
		f[8] = srcUvRect.minU;
		f[9] = srcUvRect.minV;
		f[10] = srcUvRect.maxU;
		f[11] = srcUvRect.maxV;
		f[12] = 0;
		f[13] = 0;
		f[14] = 0;
		f[15] = 0;

		const bufIdx = this.clipBlitPool.nextIndex;
		const blitUniformBuffer = this.clipBlitPool.acquire(CLIP_BLIT_BUFFER_SIZE);
		this.deps.device.queue.writeBuffer(blitUniformBuffer, 0, f);

		const blitBindGroup = this.clipBlitBGCache.getOrCreate(
			bufIdx,
			sourceTexture,
			maskCtx.offscreenTexture,
			() =>
				this.deps.device.createBindGroup({
					layout: this.deps.blitWithMaskBindGroupLayout,
					entries: [
						{ binding: 0, resource: { buffer: blitUniformBuffer } },
						{ binding: 1, resource: this.deps.sampler },
						{ binding: 2, resource: sourceTexture.createView() },
						{
							binding: 3,
							resource: maskCtx.offscreenTexture.createView(),
						},
					],
				}),
		);

		finalCtx.passEncoder.setPipeline(this.deps.blitWithMaskPipeline);
		finalCtx.passEncoder.setBindGroup(0, finalCtx.entry.bindGroup);
		finalCtx.passEncoder.setBindGroup(1, blitBindGroup);
		finalCtx.passEncoder.setBindGroup(2, this.deps.dummyMaskBindGroup);
		finalCtx.passEncoder.draw(6);
		finalCtx.passEncoder.end();

		releaseRenderSurface(sourceResult);
		this.deferDestroy(maskCtx.offscreenTexture);
		this.deferDestroy(finalCtx.offscreenStencilTexture);
		this.deps.setActiveBindGroup(null);
		this.deps.viewportState.bounds = finalCtx.savedViewportBounds;

		let surface = createRenderSurface(
			createFrameTextureRef(finalCtx.offscreenTexture, (texture) =>
				this.deferDestroy(texture),
			),
			{
				kind: "world-aabb",
				bounds: finalCtx.coverageBounds,
				uvRect: finalCtx.blitUvRect,
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
		for (const outerMask of outerMasks) {
			const masked = this.applyWorldMaskToTexture(
				encoder,
				surface,
				outerMask,
				this.deps.getRasterScale(),
			);
			if (!masked) continue;
			surface = replaceRenderSurface(surface, {
				texture: masked.texture,
				placement: masked.placement,
			});
		}
		return surface;
	}

	/**
	 * Build a CompositeRenderContext for an offscreen pass, enabling
	 * mask-based clip group masking within it.
	 *
	 * The caller is responsible for calling `stencilTex?.destroy()` after
	 * the render pass ends.
	 */
	private buildOffscreenCompositeContext(
		encoder: GPUCommandEncoder,
		offscreenTexture: GPUTexture,
		entry: UniformEntry,
	): {
		stencilTex: GPUTexture | null;
		compositeContext: CompositeRenderContext | undefined;
	} {
		const stencilTex = this.deps.texturePool.acquire(
			offscreenTexture.width,
			offscreenTexture.height,
			"depth24plus-stencil8",
			MSAA_SAMPLE_COUNT,
			GPUTextureUsage.RENDER_ATTACHMENT,
			"Offscreen Composite Stencil",
		);

		const offscreenView = offscreenTexture.createView();
		const stencilView = stencilTex.createView();

		const colorAttachment: GPURenderPassColorAttachment = {
			view: offscreenView,
			loadOp: "load",
			storeOp: "store",
		};

		return {
			stencilTex,
			compositeContext: {
				encoder,
				targetTexture: offscreenTexture,
				restartPass: () => {
					this.deps.setActiveBindGroup(entry.bindGroup, entry.buffer, true);
					const p = encoder.beginRenderPass({
						label: `${offscreenTexture.label || "Offscreen"} Composite Pass`,
						colorAttachments: [colorAttachment],
						depthStencilAttachment:
							createPassLocalStencilAttachment(stencilView),
					});
					p.setPipeline(this.deps.strokePipeline);
					p.setBindGroup(0, entry.bindGroup);
					p.setBindGroup(1, this.deps.getTransformsBindGroup()!);
					p.setBindGroup(2, this.deps.dummyGradientBindGroup);
					p.setBindGroup(3, this.deps.dummyMaskBindGroup);
					return p;
				},
			},
		};
	}

	/**
	 * Creates a render pass targeting an offscreen texture that covers the
	 * full textureBounds. The texture always represents the complete element
	 * region (element bounds + filter expansion margin) so that downstream
	 * filters receive a stable UV space independent of viewport position
	 * and canvas size.
	 *
	 * Returns null only when the element is completely off-screen (culled).
	 */
	private createOffscreenPass(
		encoder: GPUCommandEncoder,
		label: string,
		textureBounds: WorldBBox,
		rasterScale?: number,
		/** Skip viewport culling — for callers whose textureBounds is not in
		 *  world space (e.g. an element-local bake of a transformed element). */
		skipCull = false,
		/** Opt-in output clamp. When non-null, the baked region is clamped to
		 *  (visible viewport + this world-unit filter margin), so a filter's
		 *  bleed from just off-screen is kept while an offscreen covering a large
		 *  world area is not allocated far larger than the screen. Pass 0 for
		 *  callers with no spreading filter (clip groups/masks); pass the filter
		 *  margin for a filtered bake; leave null to disable clamping (paths whose
		 *  coordinate space must span the full textureBounds, e.g. the
		 *  per-appearance accumulator). */
		filterMargin: number | null = null,
	): {
		offscreenTexture: GPUTexture;
		offscreenStencilTexture: GPUTexture;
		entry: UniformEntry;
		coverageBounds: BoundingBox;
		passEncoder: GPURenderPassEncoder;
		savedViewportBounds: BoundingBox | null;
		effectiveZoom: number;
		blitUvRect: BlitUVRect;
	} | null {
		const vp = this.deps.viewportState.current;
		const zoom = vp?.zoom ?? 1.0;
		const rasterZoom = rasterScale ?? zoom;
		const maxDim = this.deps.device.limits.maxTextureDimension2D;

		// Cull passes whose world bounds fall entirely outside the current render
		// target region. `viewportState.bounds` is that region: the viewport for
		// the main pass, or the enclosing offscreen's clamped coverage for a
		// nested pass (set below), so a nested offscreen culls against its parent
		// target, not the main viewport. A null bounds (export / culling-disabled)
		// means "do not cull".
		if (
			!skipCull &&
			this.deps.viewportState.bounds != null &&
			!boundsIntersect(textureBounds, this.deps.viewportState.bounds)
		) {
			return null;
		}

		// Clamp the baked region to at most the visible output, expanded by the
		// filter margin so blur/shadow bleed from just off-screen is preserved.
		// Content outside the viewport is invisible after compositing, so an
		// offscreen covering a large world area need not be allocated far larger
		// than the screen. Skipped for null-bounds passes (export / nested
		// offscreen), matching the cull guard above; everything below derives
		// from `effectiveBounds`, so the caller blits back the smaller region.
		const clampBounds =
			filterMargin != null && !skipCull ? this.deps.viewportState.bounds : null;
		const effectiveBounds: BoundingBox = clampBounds
			? (boundsIntersectionBox(
					textureBounds,
					expandBounds(brandWorldBBox(clampBounds), filterMargin ?? 0),
				) ?? textureBounds)
			: textureBounds;

		// Interactive bakes also cap their density to the display zoom bucket so
		// a zoomed-out viewport does not rasterize far denser than the screen.
		const bakeZoom = clampBounds
			? capFilterBakeDensity(rasterZoom, zoom)
			: rasterZoom;

		// Texture covers effectiveBounds, clamped only by GPU max.
		const width = Math.min(Math.ceil(effectiveBounds.width * bakeZoom), maxDim);
		const height = Math.min(
			Math.ceil(effectiveBounds.height * bakeZoom),
			maxDim,
		);
		if (width <= 0 || height <= 0) return null;

		let effectiveZoom = Math.min(
			width / effectiveBounds.width,
			height / effectiveBounds.height,
			bakeZoom,
		);
		const coverageBounds = effectiveBounds;

		const pool = this.deps.texturePool;
		const offscreenTexture = pool.acquire(
			width,
			height,
			this.deps.canvasFormat,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			`Offscreen ${label} Texture`,
		);

		// Texture may be larger than requested due to POT quantization in pool.
		// All attachments and viewport must use the actual texture dimensions.
		const texW = offscreenTexture.width;
		const texH = offscreenTexture.height;

		const offscreenStencilTexture = pool.acquire(
			texW,
			texH,
			"depth24plus-stencil8",
			MSAA_SAMPLE_COUNT,
			GPUTextureUsage.RENDER_ATTACHMENT,
			`Offscreen ${label} Stencil Texture`,
		);

		const passEncoder = encoder.beginRenderPass({
			label: `Offscreen ${label} Pass`,
			colorAttachments: [
				{
					view: offscreenTexture.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
			depthStencilAttachment: createPassLocalStencilAttachment(
				offscreenStencilTexture.createView(),
			),
		});

		// Recompute effective zoom against actual texture size.
		// Clamp to the rasterization scale (viewport zoom for non-filter
		// passes, fixed rasterization scale R for filter passes) so rendering
		// resolution stays consistent (stroke width, filter kernels, etc.).
		// When the pool quantises the texture larger than requested, the excess
		// area is transparent margin and blitUvRect below crops it out during
		// blit.
		effectiveZoom = Math.min(
			texW / coverageBounds.width,
			texH / coverageBounds.height,
			bakeZoom,
		);

		const tempViewport = {
			x: (coverageBounds.minX + coverageBounds.maxX) / 2,
			y: (coverageBounds.minY + coverageBounds.maxY) / 2,
			zoom: effectiveZoom,
			rotation: 0,
		};

		const entry = this.deps.uniformScope.acquire(tempViewport, texW, texH);

		// Switch the active bind group so that all sub-modules (ElementRenderer,
		// CompositeRenderer, StrokeBatchContext) use the per-pass uniform buffer
		// instead of the main one.
		this.deps.setActiveBindGroup(entry.bindGroup, entry.buffer);

		// Sub-content of this offscreen is culled/clamped against THIS pass's
		// region, not the main viewport: nested offscreens then size to what
		// actually shows here and the output clamp propagates through nesting.
		// Content outside coverageBounds is not captured by the texture anyway, so
		// culling it is a pure saving. A null bounds (export / culling-disabled)
		// stays null so those paths keep rendering everything.
		const savedViewportBounds = this.deps.viewportState.bounds;
		this.deps.viewportState.bounds =
			savedViewportBounds != null ? coverageBounds : null;

		passEncoder.setPipeline(this.deps.strokePipeline);
		passEncoder.setBindGroup(0, entry.bindGroup);
		passEncoder.setBindGroup(1, this.deps.getTransformsBindGroup()!);
		passEncoder.setBindGroup(2, this.deps.dummyGradientBindGroup);
		passEncoder.setBindGroup(3, this.deps.dummyMaskBindGroup);

		// When the pool quantises textures larger than requested, the
		// rendered content occupies a centred sub-region. Compute UV rect
		// to crop out the margin during blit.
		const usedW = coverageBounds.width * effectiveZoom;
		const usedH = coverageBounds.height * effectiveZoom;
		const uHalf = usedW / (2 * texW);
		const vHalf = usedH / (2 * texH);
		const blitUvRect: BlitUVRect =
			usedW >= texW && usedH >= texH
				? FULL_BLIT_UV_RECT
				: {
						minU: 0.5 - uHalf,
						minV: 0.5 - vHalf,
						maxU: 0.5 + uHalf,
						maxV: 0.5 + vHalf,
					};

		return {
			offscreenTexture,
			offscreenStencilTexture,
			entry,
			passEncoder,
			savedViewportBounds,
			effectiveZoom,
			blitUvRect,
			coverageBounds,
		};
	}

	/**
	 * Render group children into an active offscreen pass encoder,
	 * blitting pre-filtered textures for children that have filters.
	 */
	private renderGroupChildrenToTexture(
		encoder: GPUCommandEncoder,
		passEncoder: GPURenderPassEncoder,
		children: AnyArtObject[],
		elementsMap: Map<string, AnyArtObject>,
		childFilteredTextures: Map<string, RenderSurface>,
		alphaMultiplier: number = 1.0,
		compositeContext?: CompositeRenderContext,
		ancestorTransform?: ElementTransform | null,
		parentPreFilters?: Filter[],
	): GPURenderPassEncoder {
		// activePass tracks the current render pass encoder. renderClipGroup may end the
		// current pass and open new passes (stencil write → stencil blit → restart), so
		// we use its return value for subsequent iterations.
		let activePass = passEncoder;
		for (const child of children) {
			// Set transform index so the GPU shader applies the correct child transform
			this.deps.renderState.currentTransformIndex = this.deps.getTransformIndex(
				child.id,
			);

			const childAlpha = alphaMultiplier * child.opacity;
			// Check if this child has a pre-filtered texture
			const filteredData = childFilteredTextures.get(child.id);
			if (filteredData) {
				// Blit the filtered texture
				this.deps.blitTextureToCanvas(
					activePass,
					filteredData.texture.texture,
					filteredData.placement.bounds,
					childAlpha,
					filteredData.placement.uvRect,
				);
				activePass.setPipeline(this.deps.strokePipeline);
				activePass.setBindGroup(0, this.deps.getBindGroup());
				activePass.setBindGroup(1, this.deps.getTransformsBindGroup()!);
				activePass.setBindGroup(2, this.deps.dummyGradientBindGroup);
				activePass.setBindGroup(3, this.deps.dummyMaskBindGroup);
			} else if (isGroup(child)) {
				if (child.clipPathId != null && compositeContext != null) {
					// Nested ClipGroup: render with stencil masking
					const clipChildren = child.childIds
						.filter((id) => id !== child.clipPathId)
						.map((id) => elementsMap.get(id))
						.filter((el): el is AnyArtObject => el !== undefined);
					const childWorldTransform = ancestorTransform
						? composeTransforms(ancestorTransform, getTransform(child))
						: getTransform(child);
					activePass = this.renderClipGroup(
						encoder,
						activePass,
						child,
						clipChildren,
						// Filter pre-processing for this ClipGroup's children has not been
						// performed in this context. Elements with filters will have them
						// applied via the standard pipeline inside renderElements.
						new Map(),
						elementsMap,
						childAlpha,
						childWorldTransform,
						ancestorTransform ?? null,
						undefined,
						compositeContext,
					);
				} else {
					// Nested groups: render their children recursively,
					// propagating pre-filters (parent→child order, outermost first).
					const nestedChildren = child.childIds
						.filter((id) => id !== child.clipPathId)
						.map((id) => elementsMap.get(id))
						.filter((el): el is AnyArtObject => el !== undefined);
					const childGroupPreFilters = (child.filters ?? []).filter((f) => {
						const handler = this.deps.filterRenderer.getHandler(f.processor);
						return f.enabled !== false && !!handler?.preProcess;
					});
					const nestedPreFilters =
						childGroupPreFilters.length > 0 || parentPreFilters?.length
							? [...childGroupPreFilters, ...(parentPreFilters ?? [])]
							: undefined;
					activePass = this.renderGroupChildrenToTexture(
						encoder,
						activePass,
						nestedChildren,
						elementsMap,
						childFilteredTextures,
						childAlpha,
						compositeContext,
						ancestorTransform,
						nestedPreFilters,
					);
				}
			} else {
				const effectiveChild = parentPreFilters?.length
					? {
							...child,
							filters: [...(child.filters ?? []), ...parentPreFilters],
						}
					: child;
				this.deps.dispatchElementDirect(
					activePass,
					effectiveChild as AnyArtObject,
					elementsMap,
					childAlpha,
					"offscreen",
				);
			}
		}
		return activePass;
	}

	/**
	 * Render an array of elements to an offscreen texture using the
	 * full renderElements pipeline.
	 */
	private renderElementsToOffscreenTexture(
		encoder: GPUCommandEncoder,
		elements: AnyArtObject[],
		textureBounds: WorldBBox,
		filteredTextures: Map<string, FilteredTextureInfo>,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number,
		parentTransform: ElementTransform | null,
		skipElementIds?: ReadonlySet<string>,
		_compositeContext?: CompositeRenderContext,
		localBoundsCache?: LocalBoundsCache,
	): ColorRenderSurface | null {
		const ctx = this.createOffscreenPass(
			encoder,
			"Clip Group",
			textureBounds,
			undefined,
			false,
			// Children are pre-baked (with their own filter margins) and blitted
			// at world positions, so clamping the group content to the visible
			// output only drops fully off-screen pixels.
			0,
		);
		if (!ctx) return null;

		const {
			offscreenTexture,
			offscreenStencilTexture,
			entry,
			passEncoder: offscreenPassEncoder,
			savedViewportBounds,
		} = ctx;

		const {
			stencilTex: clipStencilTex,
			compositeContext: offscreenCompositeContext,
		} = this.buildOffscreenCompositeContext(encoder, offscreenTexture, entry);

		// Swap captureTexture to offscreen-sized one so that blend mode
		// compositing inside this offscreen pass uses the correct dimensions.
		const { savedCaptureTexture, offscreenCaptureTexture } =
			this.swapCaptureTexture(offscreenTexture.width, offscreenTexture.height);

		const finalPassEncoder = this.deps.renderElements(
			offscreenPassEncoder,
			elements,
			filteredTextures,
			elementsMap,
			alphaMultiplier,
			parentTransform,
			skipElementIds,
			"offscreen",
			offscreenCompositeContext,
			localBoundsCache,
		);

		finalPassEncoder.end();

		this.deps.compositeState.captureTexture = savedCaptureTexture;
		this.deferDestroy(offscreenCaptureTexture);

		this.deferDestroy(clipStencilTex);
		this.deferDestroy(offscreenStencilTexture);
		this.deps.setActiveBindGroup(null);
		this.deps.viewportState.bounds = savedViewportBounds;
		return createRenderSurface(
			createFrameTextureRef(offscreenTexture, (texture) =>
				this.deferDestroy(texture),
			),
			{
				kind: "world-aabb",
				bounds: ctx.coverageBounds,
				uvRect: ctx.blitUvRect,
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
	}

	/**
	 * Temporarily replace compositeState.captureTexture with one matching
	 * the offscreen dimensions, so blend mode compositing works correctly.
	 */
	private swapCaptureTexture(
		width: number,
		height: number,
	): {
		savedCaptureTexture: GPUTexture | null;
		offscreenCaptureTexture: GPUTexture | null;
	} {
		const saved = this.deps.compositeState.captureTexture;
		if (!saved)
			return { savedCaptureTexture: null, offscreenCaptureTexture: null };

		const tex = this.deps.texturePool.acquire(
			width,
			height,
			this.deps.canvasFormat,
			1,
			GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			"Offscreen Capture Texture",
		);
		this.deps.compositeState.captureTexture = tex;
		return { savedCaptureTexture: saved, offscreenCaptureTexture: tex };
	}
}

/**
 * The part of `uvRect` covering `part` of `whole`.
 *
 * The blit maps world X onto U in the same direction and world Y onto V in the
 * opposite one (world Y points up, V points down), so the vertical ends swap.
 */
function subUvRect(
	whole: BoundingBox,
	uvRect: BlitUVRect,
	part: BoundingBox,
): BlitUVRect {
	if (whole.width <= 0 || whole.height <= 0) return uvRect;
	const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
	return {
		minU: lerp(
			uvRect.minU,
			uvRect.maxU,
			(part.minX - whole.minX) / whole.width,
		),
		maxU: lerp(
			uvRect.minU,
			uvRect.maxU,
			(part.maxX - whole.minX) / whole.width,
		),
		minV: lerp(
			uvRect.minV,
			uvRect.maxV,
			(whole.maxY - part.maxY) / whole.height,
		),
		maxV: lerp(
			uvRect.minV,
			uvRect.maxV,
			(whole.maxY - part.minY) / whole.height,
		),
	};
}

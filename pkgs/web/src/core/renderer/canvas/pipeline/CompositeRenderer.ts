import type { BlendMode, BoundingBox, CompositionMode } from "../../../schema";
import { computeQuadProjectiveWeights } from "../../../utils/geometry/quadProjection";
import {
	type BlitUVRect,
	FULL_BLIT_UV_RECT,
	type SharedRenderBindings,
	type ViewportState,
	type WriteViewportUniformsFn,
} from "../CanvasLayerTypes";
import {
	BlitBindGroupCache,
	TripleTextureBindGroupCache,
} from "../caches/BindGroupCache";
import type { DocumentCache } from "./DocumentCache";
import { FrameUniformPool } from "./FrameUniformPool";
import {
	createBorrowedTextureRef,
	createRenderSurface,
	type PlacementOpacity,
	type RenderSurface,
	type RenderSurfaceOpacity,
	type SurfacePlacement,
} from "./RenderSurface";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Float32 element count shared by blit uniform buffers (12 floats = 48 bytes). */
const BLIT_F32_COUNT = 12;
/** Byte size of a blit uniform buffer. */
const BLIT_BUFFER_SIZE = BLIT_F32_COUNT * 4;

/** Float32 element count for quad-blit uniform buffers
 *  (4 corners ×2 + opacity + 3 pad + 4 uv + 4 projective q = 20 floats = 80 bytes). */
const QUAD_BLIT_F32_COUNT = 20;
/** Byte size of a quad-blit uniform buffer. */
const QUAD_BLIT_BUFFER_SIZE = QUAD_BLIT_F32_COUNT * 4;

/** Float32/Uint32 element count shared by composite uniform buffers (12 = 48 bytes). */
const COMPOSITE_ELEM_COUNT = 12;
/** Byte size of a composite uniform buffer. */
const COMPOSITE_BUFFER_SIZE = COMPOSITE_ELEM_COUNT * 4;

/** Float32 element count for mesh-blit uniform buffers
 *  (opacity + 3 pad + 4 uv = 8 floats = 32 bytes). */
const MESH_BLIT_F32_COUNT = 8;
/** Byte size of a mesh-blit uniform buffer. */
const MESH_BLIT_BUFFER_SIZE = MESH_BLIT_F32_COUNT * 4;
/** Floats per mesh-blit vertex (x, y, u, v). */
const MESH_BLIT_FLOATS_PER_VERTEX = 4;

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

interface CompositeRendererDeps extends SharedRenderBindings {
	nearestSampler: GPUSampler;
	blitPipeline: GPURenderPipeline;
	blitGlassPunchPipeline: GPURenderPipeline;
	compositePipeline: GPURenderPipeline;
	quadBlitPipeline: GPURenderPipeline;
	meshBlitPipeline: GPURenderPipeline;
	compositeBindGroupLayout: GPUBindGroupLayout;
	blitWithMaskBindGroupLayout: GPUBindGroupLayout;
	dummyGradientBindGroup: GPUBindGroup;
	dummyMaskBindGroup: GPUBindGroup;
	// Mutable shared state
	viewportState: ViewportState;
	// Getters for dynamic/cross-module deps
	getCache: () => DocumentCache;
	// Callbacks for cross-module operations
	writeViewportUniformsToGPU: WriteViewportUniformsFn;
	getBlendModeIndex: (blendMode: BlendMode) => number;
	getCompositionModeIndex: (compositionMode: CompositionMode) => number;
	deferDestroy: (texture: GPUTexture | null | undefined) => void;
}

export type PremultipliedColorSurface<
	Opacity extends RenderSurfaceOpacity = "intrinsic",
> = RenderSurface<"color", "premultiplied", Opacity>;

export type CompositeSourceSurface = PremultipliedColorSurface<"intrinsic">;

export type DestinationSnapshotSurface = RenderSurface<
	"destination-snapshot",
	"premultiplied",
	"placement-baked"
>;

export type ParentBackdropSurface = RenderSurface<
	"parent-backdrop",
	"premultiplied",
	"placement-baked"
>;

export type BlendBackdrop =
	| {
			isolation: "isolated";
			destination: DestinationSnapshotSurface;
	  }
	| {
			isolation: "pass-through";
			destination: DestinationSnapshotSurface;
			parent: ParentBackdropSurface;
	  };

export interface CompositeSurfaceRequest {
	passEncoder: GPURenderPassEncoder;
	source: CompositeSourceSurface;
	backdrop: BlendBackdrop;
	blendMode: BlendMode;
	placementOpacity: PlacementOpacity;
	pipeline?: GPURenderPipeline;
	compositionMode?: CompositionMode;
}

type CompositeSourcePlacement = Extract<
	SurfacePlacement,
	{ kind: "world-aabb" }
>;

export function createCompositeSourceSurface(
	texture: GPUTexture,
	placement: CompositeSourcePlacement,
): CompositeSourceSurface {
	return createRenderSurface(
		createBorrowedTextureRef(texture, "external"),
		placement,
		{
			role: "color",
			alphaMode: "premultiplied",
			opacityState: "intrinsic",
		},
	);
}

export function createBlendBackdrop(
	destinationTexture: GPUTexture,
	parentTexture: GPUTexture | undefined,
	placement: SurfacePlacement,
): BlendBackdrop {
	const destination = createRenderSurface(
		createBorrowedTextureRef(destinationTexture, "external"),
		placement,
		{
			role: "destination-snapshot",
			alphaMode: "premultiplied",
			opacityState: "placement-baked",
		},
	);
	if (!parentTexture) {
		return { isolation: "isolated", destination };
	}
	return {
		isolation: "pass-through",
		destination,
		parent: createRenderSurface(
			createBorrowedTextureRef(parentTexture, "external"),
			placement,
			{
				role: "parent-backdrop",
				alphaMode: "premultiplied",
				opacityState: "placement-baked",
			},
		),
	};
}

// ---------------------------------------------------------------------------
// CompositeRenderer class
// ---------------------------------------------------------------------------

export class CompositeRenderer {
	// -- Scratch buffers (reused every call, zero allocation) --
	private readonly blitF32 = new Float32Array(BLIT_F32_COUNT);
	private readonly quadBlitF32 = new Float32Array(QUAD_BLIT_F32_COUNT);
	private readonly meshBlitF32 = new Float32Array(MESH_BLIT_F32_COUNT);
	private readonly compositeAB = new ArrayBuffer(COMPOSITE_BUFFER_SIZE);
	private readonly compositeF32 = new Float32Array(this.compositeAB);
	private readonly compositeU32 = new Uint32Array(this.compositeAB);

	// -- GPU buffer pools (grow once, reused every frame) --
	private readonly blitPool: FrameUniformPool;
	private readonly quadBlitPool: FrameUniformPool;
	private readonly compositePool: FrameUniformPool;
	private readonly meshBlitUniformPool: FrameUniformPool;
	/** Vertex buffers vary in size; each slot grows to the largest draw seen.
	 *  Not a FrameUniformPool: that one hands out UNIFORM buffers. */
	private meshBlitVertexPool: GPUBuffer[] = [];
	private meshBlitVertexPoolIdx = 0;

	// -- Bind group caches (parallel to buffer pools, keyed by texture identity) --
	private blitBGCache = new BlitBindGroupCache();
	/** Separate cache for nearest-sampled blits: BlitBindGroupCache keys on
	 *  (poolIndex, texture) only, so sharing one cache across samplers would
	 *  return a bind group built with the wrong sampler. */
	private blitNearestBGCache = new BlitBindGroupCache();
	private quadBlitBGCache = new BlitBindGroupCache();
	private meshBlitBGCache = new BlitBindGroupCache();
	private compositeBGCache = new TripleTextureBindGroupCache();

	/** 1x1 transparent texture used as default baseTexture when no canvas
	 *  snapshot is needed (normal non-offscreen compositing). */
	private dummyBaseTexture: GPUTexture | null = null;

	public constructor(private readonly deps: CompositeRendererDeps) {
		this.blitPool = new FrameUniformPool(deps.device, "Blit Uniform Buffer");
		this.quadBlitPool = new FrameUniformPool(
			deps.device,
			"Quad Blit Uniform Buffer",
		);
		this.compositePool = new FrameUniformPool(
			deps.device,
			"Composite Uniform Buffer",
		);
		this.meshBlitUniformPool = new FrameUniformPool(
			deps.device,
			"Mesh Blit Uniform Buffer",
		);
		this.dummyBaseTexture = deps.device.createTexture({
			label: "Composite Dummy Base (1x1 transparent)",
			size: { width: 1, height: 1 },
			format: deps.canvasFormat,
			usage: GPUTextureUsage.TEXTURE_BINDING,
		});
	}

	/** Reset pool indices at the start of each frame. */
	public resetFrame(): void {
		this.blitPool.beginFrame();
		this.quadBlitPool.beginFrame();
		this.compositePool.beginFrame();
		this.meshBlitUniformPool.beginFrame();
		this.meshBlitVertexPoolIdx = 0;
	}

	/** Release all pooled GPU resources. */
	public destroy(): void {
		this.blitPool.destroy();
		this.quadBlitPool.destroy();
		this.compositePool.destroy();
		this.meshBlitUniformPool.destroy();
		for (const buf of this.meshBlitVertexPool) buf.destroy();
		this.meshBlitVertexPool.length = 0;
		this.dummyBaseTexture?.destroy();
		this.dummyBaseTexture = null;
	}

	/** Pooled vertex buffer with capacity >= byteLength; slots grow in place. */
	private acquireMeshBlitVertexBuffer(byteLength: number): GPUBuffer {
		const idx = this.meshBlitVertexPoolIdx++;
		const existing = this.meshBlitVertexPool[idx];
		if (existing && existing.size >= byteLength) return existing;
		existing?.destroy();
		const buf = this.deps.device.createBuffer({
			label: `Mesh Blit Vertex Buffer [pool ${idx}]`,
			size: byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		this.meshBlitVertexPool[idx] = buf;
		return buf;
	}

	public blitTextureToCanvas(
		passEncoder: GPURenderPassEncoder,
		texture: GPUTexture,
		bounds: BoundingBox,
		opacity: number = 1.0,
		uvRect: BlitUVRect = FULL_BLIT_UV_RECT,
		pipeline: GPURenderPipeline = this.deps.blitPipeline,
		sampling: "linear" | "nearest" = "linear",
	): void {
		const f = this.blitF32;
		f[0] = bounds.minX;
		f[1] = bounds.minY;
		f[2] = bounds.maxX;
		f[3] = bounds.maxY;
		f[4] = opacity;
		f[5] = 0;
		f[6] = 0;
		f[7] = 0;
		f[8] = uvRect.minU;
		f[9] = uvRect.minV;
		f[10] = uvRect.maxU;
		f[11] = uvRect.maxV;

		const bufIdx = this.blitPool.nextIndex;
		const blitUniformBuffer = this.blitPool.write(f);

		const sampler =
			sampling === "nearest" ? this.deps.nearestSampler : this.deps.sampler;
		const bgCache =
			sampling === "nearest" ? this.blitNearestBGCache : this.blitBGCache;
		const blitBindGroup = bgCache.getOrCreate(bufIdx, texture, () =>
			this.deps.device.createBindGroup({
				label: "Blit Bind Group",
				layout: this.deps.blitBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: blitUniformBuffer } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: texture.createView() },
				],
			}),
		);

		passEncoder.setPipeline(pipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup()); // Restore bind group 0
		passEncoder.setBindGroup(1, blitBindGroup);
		passEncoder.draw(6, 1, 0, 0);
	}

	/**
	 * Destination punch for a glass intermediate blit: scales the destination
	 * so the following `blitTextureToCanvas` src-over totals a
	 * (1 − coverage·opacity) destination weight — replace within the solid,
	 * plain over where downstream filters spread past it. Call with the same
	 * bounds/opacity/uvRect as the blit that follows in the same pass.
	 */
	public punchGlassCoverage(
		passEncoder: GPURenderPassEncoder,
		texture: GPUTexture,
		coverage: GPUTexture,
		bounds: BoundingBox,
		opacity: number = 1.0,
		uvRect: BlitUVRect = FULL_BLIT_UV_RECT,
	): void {
		const f = this.blitF32;
		f[0] = bounds.minX;
		f[1] = bounds.minY;
		f[2] = bounds.maxX;
		f[3] = bounds.maxY;
		f[4] = opacity;
		f[5] = 0;
		f[6] = 0;
		f[7] = 0;
		f[8] = uvRect.minU;
		f[9] = uvRect.minV;
		f[10] = uvRect.maxU;
		f[11] = uvRect.maxV;

		const blitUniformBuffer = this.blitPool.write(f);

		const bindGroup = this.deps.device.createBindGroup({
			label: "Glass Punch Bind Group",
			layout: this.deps.blitWithMaskBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: blitUniformBuffer } },
				{ binding: 1, resource: this.deps.sampler },
				{ binding: 2, resource: texture.createView() },
				{ binding: 3, resource: coverage.createView() },
			],
		});

		passEncoder.setPipeline(this.deps.blitGlassPunchPipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, bindGroup);
		passEncoder.draw(6, 1, 0, 0);
	}

	/**
	 * Blit `texture` onto an arbitrary 4-corner quadrilateral in world space.
	 * Corners are ordered TL → TR → BR → BL, matching UVs (0,0)/(1,0)/(1,1)/(0,1).
	 *
	 * Used by ImageElementRenderer when an image's preProcess filters (e.g.
	 * 3d-rotate) warp the 4 corners into a non-AABB quad.
	 */
	public blitQuadToCanvas(
		passEncoder: GPURenderPassEncoder,
		texture: GPUTexture,
		corners: readonly [
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
		],
		opacity: number = 1.0,
		uvRect: BlitUVRect = FULL_BLIT_UV_RECT,
	): void {
		const f = this.quadBlitF32;
		const q = computeQuadProjectiveWeights(corners);
		f[0] = corners[0].x;
		f[1] = corners[0].y;
		f[2] = corners[1].x;
		f[3] = corners[1].y;
		f[4] = corners[2].x;
		f[5] = corners[2].y;
		f[6] = corners[3].x;
		f[7] = corners[3].y;
		f[8] = opacity;
		f[9] = 0;
		f[10] = 0;
		f[11] = 0;
		f[12] = uvRect.minU;
		f[13] = uvRect.minV;
		f[14] = uvRect.maxU;
		f[15] = uvRect.maxV;
		f[16] = q[0];
		f[17] = q[1];
		f[18] = q[2];
		f[19] = q[3];

		const bufIdx = this.quadBlitPool.nextIndex;
		const quadUniformBuffer = this.quadBlitPool.write(f);

		const quadBindGroup = this.quadBlitBGCache.getOrCreate(
			bufIdx,
			texture,
			() =>
				this.deps.device.createBindGroup({
					label: "Quad Blit Bind Group",
					layout: this.deps.blitBindGroupLayout,
					entries: [
						{ binding: 0, resource: { buffer: quadUniformBuffer } },
						{ binding: 1, resource: this.deps.sampler },
						{ binding: 2, resource: texture.createView() },
					],
				}),
		);

		passEncoder.setPipeline(this.deps.quadBlitPipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, quadBindGroup);
		passEncoder.draw(6, 1, 0, 0);
	}

	/**
	 * Blit `texture` onto a tessellated triangle mesh in world space. Vertices
	 * are interleaved (x, y, u, v) triangle-list data — positions pre-warped on
	 * the CPU, UVs in 0..1 image space (mapped through `uvRect` in the shader).
	 *
	 * Used by the mesh warp container to bend an image child's interior along
	 * the Coons cage.
	 */
	public blitMeshToCanvas(
		passEncoder: GPURenderPassEncoder,
		texture: GPUTexture,
		vertexData: Float32Array,
		opacity: number = 1.0,
		uvRect: BlitUVRect = FULL_BLIT_UV_RECT,
	): void {
		const vertexCount = vertexData.length / MESH_BLIT_FLOATS_PER_VERTEX;
		if (vertexCount < 3) return;

		const f = this.meshBlitF32;
		f[0] = opacity;
		f[1] = 0;
		f[2] = 0;
		f[3] = 0;
		f[4] = uvRect.minU;
		f[5] = uvRect.minV;
		f[6] = uvRect.maxU;
		f[7] = uvRect.maxV;

		const bufIdx = this.meshBlitUniformPool.nextIndex;
		const uniformBuffer = this.meshBlitUniformPool.acquire(
			MESH_BLIT_BUFFER_SIZE,
		);
		this.deps.device.queue.writeBuffer(uniformBuffer, 0, f);

		const vertexBuffer = this.acquireMeshBlitVertexBuffer(
			vertexData.byteLength,
		);
		this.deps.device.queue.writeBuffer(vertexBuffer, 0, vertexData);

		const bindGroup = this.meshBlitBGCache.getOrCreate(bufIdx, texture, () =>
			this.deps.device.createBindGroup({
				label: "Mesh Blit Bind Group",
				layout: this.deps.blitBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: this.deps.sampler },
					{ binding: 2, resource: texture.createView() },
				],
			}),
		);

		passEncoder.setPipeline(this.deps.meshBlitPipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, bindGroup);
		passEncoder.setVertexBuffer(0, vertexBuffer, 0, vertexData.byteLength);
		passEncoder.draw(vertexCount, 1, 0, 0);
	}

	public compositeSurfaceToCanvas({
		passEncoder,
		source,
		backdrop,
		blendMode,
		placementOpacity,
		pipeline,
		compositionMode,
	}: CompositeSurfaceRequest): void {
		if (source.placement.kind !== "world-aabb") {
			throw new Error("Composite source must use world-aabb placement");
		}
		this.compositeTextureInternal(
			passEncoder,
			source.texture.texture,
			backdrop.destination.texture.texture,
			source.placement.bounds,
			blendMode,
			placementOpacity,
			pipeline,
			source.placement.uvRect,
			compositionMode,
			backdrop.isolation === "pass-through"
				? backdrop.parent.texture.texture
				: undefined,
		);
	}

	/**
	 * @internal Positional migration adapter. Remove after CanvasLayer and
	 * OffscreenPresenter construct typed surfaces and call compositeSurfaceToCanvas.
	 */
	private compositeTextureInternal(
		passEncoder: GPURenderPassEncoder,
		sourceTexture: GPUTexture,
		destTexture: GPUTexture,
		bounds: BoundingBox,
		blendMode: BlendMode,
		opacity: number,
		pipeline?: GPURenderPipeline,
		uvRect?: BlitUVRect,
		compositionMode?: CompositionMode,
		baseTexture?: GPUTexture,
	): void {
		const f = this.compositeF32;
		const u = this.compositeU32;

		f[0] = bounds.minX;
		f[1] = bounds.minY;
		f[2] = bounds.maxX;
		f[3] = bounds.maxY;
		u[4] = this.deps.getBlendModeIndex(blendMode);
		u[5] = this.deps.getCompositionModeIndex(compositionMode ?? "normal");
		f[6] = opacity;
		// uvScale: 1.0 = full texture, <1.0 = crop centred sub-region
		f[7] = uvRect ? uvRect.maxU - uvRect.minU : 1.0;
		f[8] = uvRect ? uvRect.maxV - uvRect.minV : 1.0;

		const compIdx = this.compositePool.nextIndex;
		const compositeUniformBuffer = this.compositePool.acquire(
			COMPOSITE_BUFFER_SIZE,
		);
		this.deps.device.queue.writeBuffer(
			compositeUniformBuffer,
			0,
			this.compositeAB,
		);

		const effectiveBase = baseTexture ?? this.dummyBaseTexture;
		if (!effectiveBase) {
			throw new Error("CompositeRenderer has been destroyed");
		}
		const compositeBindGroup = this.compositeBGCache.getOrCreate(
			compIdx,
			sourceTexture,
			destTexture,
			effectiveBase,
			() =>
				this.deps.device.createBindGroup({
					label: "Composite Bind Group",
					layout: this.deps.compositeBindGroupLayout,
					entries: [
						{
							binding: 0,
							resource: { buffer: compositeUniformBuffer },
						},
						{ binding: 1, resource: this.deps.sampler },
						{ binding: 2, resource: sourceTexture.createView() },
						{ binding: 3, resource: destTexture.createView() },
						{ binding: 4, resource: effectiveBase.createView() },
					],
				}),
		);

		passEncoder.setPipeline(pipeline ?? this.deps.compositePipeline);
		passEncoder.setBindGroup(0, this.deps.getBindGroup());
		passEncoder.setBindGroup(1, compositeBindGroup);
		passEncoder.draw(6, 1, 0, 0);
	}
}

/**
 * Offscreen rendering infrastructure extracted from CanvasLayer.
 *
 * Handles creating temporary offscreen textures and render passes for:
 * - Filter pre-processing (element → texture → filter → blit)
 * - Group compositing (group children → texture → composite)
 * - Clip group stencil masking (children → texture → stencil → blit)
 */

import { localAppearances } from "../../../document/appearancePresets";
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
import { interactiveBakeDensity } from "../CanvasLayer.helpers";
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
	type WorldMaskAssignment,
} from "../CanvasLayerTypes";
import { MaskedBlitBindGroupCache } from "../caches/BindGroupCache";
import type { FilterRenderer } from "./FilterRenderer";
import { FrameUniformPool } from "./FrameUniformPool";
import { MaskAtlasAllocator, type MaskAtlasRect } from "./MaskAtlasAllocator";
import { createPassLocalStencilAttachment } from "./PassLocalStencil";
import { calculatePreFilteredElementBounds } from "./RenderPlanner";
import {
	type ColorRenderSurface,
	createBorrowedTextureRef,
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
	viewportBindGroupLayout: GPUBindGroupLayout;
	strokePipeline: GPURenderPipeline;
	blitWithMaskPipeline: GPURenderPipeline;
	blitWithMaskChainPipeline: GPURenderPipeline;
	blitWithEraseMaskPipeline: GPURenderPipeline;
	blitWithMaskBindGroupLayout: GPUBindGroupLayout;
	maskChainBindGroupLayout: GPUBindGroupLayout;
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
	/** Per-appearance isolated render for wash strokes inside containers
	 *  (returns null when the element carries no wash appearance plan). */
	renderIsolatedWashAppearances?: (
		encoder: GPUCommandEncoder,
		elementId: string,
	) => RenderSurface | null;
	hasIsolatedWashAppearances?: (elementId: string) => boolean;
	getElementPostMasks: (elementId: string) => readonly {
		bindGroup: GPUBindGroup;
		textureView: GPUTextureView;
		bounds: BoundingBox;
		inverted?: boolean;
	}[];
	onBeforeDraw: () => void;
	/** The document rasterization scale R (see references/rasterization-dpi.md).
	 *  A dep rather than a `rasterScale` argument so that a pass re-baking an
	 *  R-rasterized intermediary cannot fall back to the zoom by omission. */
	getRasterScale: () => number;
}

// ---------------------------------------------------------------------------
// OffscreenPresenter
// ---------------------------------------------------------------------------

/** Float32 element count for clip blit uniforms.
 * 20 floats = 80 bytes to accommodate outer mask bounds (4 extra floats). */
const CLIP_BLIT_F32_COUNT = 20;
const CLIP_BLIT_BUFFER_SIZE = CLIP_BLIT_F32_COUNT * 4;

/** World-space masks applied per chain pass — matches the shader's slot count. */
const MASK_CHAIN_SLOTS = 4;
const ATLAS_MASK_SLOTS = 16;

interface GroupChildSurface {
	surface: RenderSurface;
	deferredMasks?: readonly WorldMaskAssignment[];
}

export interface ColorAtlasBakeReservation {
	bounds: WorldBBox;
	effectiveZoom: number;
	atlasRect: MaskAtlasRect;
}

export interface ColorAtlasBakeItem extends ColorAtlasBakeReservation {
	key: string;
	element: AnyArtObject;
	elementsMap: Map<string, AnyArtObject>;
}

export interface ColorAtlasCopyItem {
	key: string;
	surface: RenderSurface;
}

export interface AtlasMaskComputeItem {
	key: string;
	source: RenderSurface;
	masks: readonly WorldMaskAssignment[];
}

interface ColorBakeBatchItem extends ColorAtlasBakeItem {
	memoKey: string;
	deferredMasks: readonly WorldMaskAssignment[];
}
/** MaskChainUniforms: 4x bounds vec4f + inverts vec4f + 4x atlas rect vec4f. */
const MASK_CHAIN_F32_COUNT = 36;
const MASK_CHAIN_BUFFER_SIZE = MASK_CHAIN_F32_COUNT * 4;
const COLOR_BAKE_ATLAS_SIZE = 2048;
const MAX_COLOR_BAKE_DIM = 256;
const COLOR_ATLAS_MASK_DRAW_F32_COUNT = 12 + ATLAS_MASK_SLOTS * 9;
const MAX_COLOR_ATLAS_MASK_DRAWS = 16_384;
const ATLAS_MASK_COMPUTE_F32_COUNT = 16 + ATLAS_MASK_SLOTS * 9;

const COLOR_ATLAS_MASK_SHADER = /* wgsl */ `
	struct Uniforms {
		viewportX: f32,
		viewportY: f32,
		zoom: f32,
		canvasWidth: f32,
		canvasHeight: f32,
		rotSin: f32,
		rotCos: f32,
	}

	struct DrawData {
		bounds: vec4f,
		uvRect: vec4f,
		params: vec4f,
		maskBounds: array<vec4f, 16>,
		maskRects: array<vec4f, 16>,
		inverts: array<vec4f, 4>,
	}

	@group(0) @binding(0) var<uniform> uniforms: Uniforms;
	@group(1) @binding(0) var texSampler: sampler;
	@group(1) @binding(1) var sourceTexture: texture_2d<f32>;
	@group(1) @binding(2) var maskTexture: texture_2d<f32>;
	@group(1) @binding(3) var<storage, read> drawData: array<DrawData>;

	struct VertexOutput {
		@builtin(position) position: vec4f,
		@location(0) texCoord: vec2f,
		@location(1) worldPos: vec2f,
		@location(2) @interpolate(flat) drawIndex: u32,
	}

	fn maskUVFor(bounds: vec4f, rect: vec4f, textureSize: vec2f, worldPos: vec2f) -> vec2f {
		let safeSize = max(bounds.zw - bounds.xy, vec2f(1e-6));
		let rawUV = (worldPos - bounds.xy) / safeSize;
		let clampedUV = clamp(vec2f(rawUV.x, 1.0 - rawUV.y), vec2f(0.0), vec2f(1.0));
		return (rect.xy + vec2f(0.5) + clampedUV * max(rect.zw - vec2f(1.0), vec2f(0.0))) / textureSize;
	}

	fn maskCoverage(sampled: vec4f, bounds: vec4f, worldPos: vec2f, invert: f32) -> f32 {
		if (bounds.x == bounds.z && bounds.y == bounds.w) {
			return 1.0;
		}
		let rawUV = (worldPos - bounds.xy) / (bounds.zw - bounds.xy);
		let maskUV = vec2f(rawUV.x, 1.0 - rawUV.y);
		let inBounds = step(0.0, maskUV.x) * step(maskUV.x, 1.0)
		             * step(0.0, maskUV.y) * step(maskUV.y, 1.0);
		let covered = dot(sampled.rgb, vec3f(0.2126, 0.7152, 0.0722)) * inBounds;
		return mix(covered, 1.0 - covered, invert);
	}

	@vertex
	fn vertexMain(
		@builtin(vertex_index) vertexIndex: u32,
		@builtin(instance_index) instanceIndex: u32,
	) -> VertexOutput {
		var output: VertexOutput;
		var positions = array<vec2f, 6>(
			vec2f(-1.0, -1.0),
			vec2f(1.0, -1.0),
			vec2f(-1.0, 1.0),
			vec2f(-1.0, 1.0),
			vec2f(1.0, -1.0),
			vec2f(1.0, 1.0),
		);
		var texCoords = array<vec2f, 6>(
			vec2f(0.0, 1.0),
			vec2f(1.0, 1.0),
			vec2f(0.0, 0.0),
			vec2f(0.0, 0.0),
			vec2f(1.0, 1.0),
			vec2f(1.0, 0.0),
		);
		let draw = drawData[instanceIndex];
		let quadPos = positions[vertexIndex];
		let texCoord = texCoords[vertexIndex];
		let worldX = mix(draw.bounds.x, draw.bounds.z, (quadPos.x + 1.0) * 0.5);
		let worldY = mix(draw.bounds.y, draw.bounds.w, (quadPos.y + 1.0) * 0.5);
		let x = (worldX - uniforms.viewportX) * uniforms.zoom;
		let y = (worldY - uniforms.viewportY) * uniforms.zoom;
		let rotX = x * uniforms.rotCos - y * uniforms.rotSin;
		let rotY = x * uniforms.rotSin + y * uniforms.rotCos;
		output.position = vec4f(
			rotX / (uniforms.canvasWidth * 0.5),
			rotY / (uniforms.canvasHeight * 0.5),
			0.0,
			1.0,
		);
		output.texCoord = vec2f(
			mix(draw.uvRect.x, draw.uvRect.z, texCoord.x),
			mix(draw.uvRect.y, draw.uvRect.w, texCoord.y),
		);
		output.worldPos = vec2f(worldX, worldY);
		output.drawIndex = instanceIndex;
		return output;
	}

	@fragment
	fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
		let draw = drawData[input.drawIndex];
		let textureSize = vec2f(textureDimensions(maskTexture));
		var coverage = 1.0;
		for (var i = 0u; i < u32(draw.params.y); i++) {
			let sampled = textureSampleLevel(
				maskTexture,
				texSampler,
				maskUVFor(draw.maskBounds[i], draw.maskRects[i], textureSize, input.worldPos),
				0.0,
			);
			coverage *= maskCoverage(
				sampled,
				draw.maskBounds[i],
				input.worldPos,
				draw.inverts[i / 4u][i % 4u],
			);
		}
		return textureSample(sourceTexture, texSampler, input.texCoord) * (coverage * draw.params.x);
	}
`;

const ATLAS_MASK_COMPUTE_SHADER = /* wgsl */ `
	struct ComputeData {
		sourceRect: vec4f,
		destinationRect: vec4f,
		bounds: vec4f,
		params: vec4f,
		maskBounds: array<vec4f, 16>,
		maskRects: array<vec4f, 16>,
		inverts: array<vec4f, 4>,
	}

	@group(0) @binding(0) var texSampler: sampler;
	@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
	@group(0) @binding(2) var maskTexture: texture_2d<f32>;
	@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;
	@group(0) @binding(4) var<storage, read> computeData: array<ComputeData>;

	fn maskUVFor(bounds: vec4f, rect: vec4f, textureSize: vec2f, worldPos: vec2f) -> vec2f {
		let safeSize = max(bounds.zw - bounds.xy, vec2f(1e-6));
		let rawUV = (worldPos - bounds.xy) / safeSize;
		let clampedUV = clamp(vec2f(rawUV.x, 1.0 - rawUV.y), vec2f(0.0), vec2f(1.0));
		return (rect.xy + vec2f(0.5) + clampedUV * max(rect.zw - vec2f(1.0), vec2f(0.0))) / textureSize;
	}

	fn maskCoverage(sampled: vec4f, bounds: vec4f, worldPos: vec2f, invert: f32) -> f32 {
		let rawUV = (worldPos - bounds.xy) / max(bounds.zw - bounds.xy, vec2f(1e-6));
		let maskUV = vec2f(rawUV.x, 1.0 - rawUV.y);
		let inBounds = step(0.0, maskUV.x) * step(maskUV.x, 1.0)
		             * step(0.0, maskUV.y) * step(maskUV.y, 1.0);
		let covered = dot(sampled.rgb, vec3f(0.2126, 0.7152, 0.0722)) * inBounds;
		return mix(covered, 1.0 - covered, invert);
	}

	@compute @workgroup_size(8, 8, 1)
	fn computeMain(@builtin(global_invocation_id) invocation: vec3u) {
		let item = computeData[invocation.z];
		let size = vec2u(item.destinationRect.zw);
		if (invocation.x >= size.x || invocation.y >= size.y) {
			return;
		}
		let localPixel = invocation.xy;
		let position = (vec2f(localPixel) + vec2f(0.5)) / vec2f(size);
		let worldPos = vec2f(
			mix(item.bounds.x, item.bounds.z, position.x),
			mix(item.bounds.w, item.bounds.y, position.y),
		);
		let textureSize = vec2f(textureDimensions(maskTexture));
		var coverage = 1.0;
		for (var i = 0u; i < u32(item.params.x); i++) {
			let sampled = textureSampleLevel(
				maskTexture,
				texSampler,
				maskUVFor(item.maskBounds[i], item.maskRects[i], textureSize, worldPos),
				0.0,
			);
			coverage *= maskCoverage(
				sampled,
				item.maskBounds[i],
				worldPos,
				item.inverts[i / 4u][i % 4u],
			);
		}
		let sourcePixel = vec2i(vec2u(item.sourceRect.xy) + localPixel);
		let destinationPixel = vec2i(vec2u(item.destinationRect.xy) + localPixel);
		textureStore(
			outputTexture,
			destinationPixel,
			textureLoad(sourceTexture, sourcePixel, 0) * coverage,
		);
	}
`;

export class OffscreenPresenter {
	private readonly clipBlitF32 = new Float32Array(CLIP_BLIT_F32_COUNT);
	private readonly maskChainF32 = new Float32Array(MASK_CHAIN_F32_COUNT);
	private readonly clipBlitPool: FrameUniformPool;
	private clipBlitBGCache = new MaskedBlitBindGroupCache();
	private whiteMaskTexture: GPUTexture | null = null;
	private whiteMaskView: GPUTextureView | null = null;
	/** Textures whose destroy must be deferred until after queue.submit(). */
	private deferredDestroys: GPUTexture[] = [];
	/** Frame-local memo of pre-rasterized (filtered + masked) group children.
	 *  Nested group bakes request the same child once per ancestor bake, so
	 *  the memo rasterizes it once per frame, owns the texture for the frame
	 *  and hands out borrowed refs; consumers' releases stay no-ops and the
	 *  textures die at the next frame reset. */
	private childBakeMemo = new Map<
		string,
		{
			texture: GPUTexture;
			placement: RenderSurface["placement"];
			role: RenderSurface["role"];
			alphaMode: RenderSurface["alphaMode"];
			opacityState: RenderSurface["opacityState"];
		}
	>();
	private childBakeMemoTextures: GPUTexture[] = [];
	private colorBakeAtlasAllocator = new MaskAtlasAllocator(
		COLOR_BAKE_ATLAS_SIZE,
		COLOR_BAKE_ATLAS_SIZE,
	);
	private colorBakeAtlasTexture: GPUTexture | null = null;
	private colorBakeAtlasView: GPUTextureView | null = null;
	private colorBakeClearTexture: GPUTexture | null = null;
	private readonly textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();
	private readonly colorAtlasMaskDrawData = new Float32Array(
		MAX_COLOR_ATLAS_MASK_DRAWS * COLOR_ATLAS_MASK_DRAW_F32_COUNT,
	);
	private readonly colorAtlasMaskDrawBuffer: GPUBuffer;
	private readonly colorAtlasMaskBindGroupLayout: GPUBindGroupLayout;
	private readonly colorAtlasMaskPipeline: GPURenderPipeline;
	private readonly colorAtlasMaskBindGroupCache = new WeakMap<
		GPUTextureView,
		WeakMap<GPUTextureView, GPUBindGroup>
	>();
	private colorAtlasMaskDrawCount = 0;
	private atlasMaskOutputAllocator = new MaskAtlasAllocator(
		COLOR_BAKE_ATLAS_SIZE,
		COLOR_BAKE_ATLAS_SIZE,
	);
	private atlasMaskOutputTexture: GPUTexture | null = null;
	private atlasMaskOutputView: GPUTextureView | null = null;
	private readonly atlasMaskComputeData: Float32Array;
	private readonly atlasMaskComputeBuffer: GPUBuffer;
	private readonly atlasMaskComputeBindGroupLayout: GPUBindGroupLayout;
	private readonly atlasMaskComputePipeline: GPUComputePipeline;
	private readonly atlasMaskComputeBindGroupCache = new WeakMap<
		GPUTextureView,
		GPUBindGroup
	>();

	public constructor(private readonly deps: OffscreenPresenterDeps) {
		this.clipBlitPool = new FrameUniformPool(
			deps.device,
			"Clip Blit Uniform Buffer",
		);
		this.colorAtlasMaskDrawBuffer = deps.device.createBuffer({
			label: "Color Atlas Mask Draw Buffer",
			size: this.colorAtlasMaskDrawData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.colorAtlasMaskBindGroupLayout = deps.device.createBindGroupLayout({
			label: "Color Atlas Mask Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: {},
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {},
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {},
				},
				{
					binding: 3,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
			],
		});
		const shader = deps.device.createShaderModule({
			label: "Color Atlas Mask Shader",
			code: COLOR_ATLAS_MASK_SHADER,
		});
		this.colorAtlasMaskPipeline = deps.device.createRenderPipeline({
			label: "Color Atlas Mask Pipeline",
			layout: deps.device.createPipelineLayout({
				bindGroupLayouts: [
					deps.viewportBindGroupLayout,
					this.colorAtlasMaskBindGroupLayout,
				],
			}),
			vertex: { module: shader, entryPoint: "vertexMain" },
			fragment: {
				module: shader,
				entryPoint: "fragmentMain",
				targets: [
					{
						format: deps.canvasFormat,
						blend: {
							color: {
								srcFactor: "one",
								dstFactor: "one-minus-src-alpha",
								operation: "add",
							},
							alpha: {
								srcFactor: "one",
								dstFactor: "one-minus-src-alpha",
								operation: "add",
							},
						},
					},
				],
			},
			primitive: { topology: "triangle-list" },
			depthStencil: {
				format: "depth24plus-stencil8",
				depthWriteEnabled: false,
				depthCompare: "always",
				stencilFront: { compare: "always", passOp: "keep" },
				stencilBack: { compare: "always", passOp: "keep" },
			},
			multisample: { count: MSAA_SAMPLE_COUNT },
		});
		this.atlasMaskComputeData = new Float32Array(
			MAX_COLOR_ATLAS_MASK_DRAWS * ATLAS_MASK_COMPUTE_F32_COUNT,
		);
		this.atlasMaskComputeBuffer = deps.device.createBuffer({
			label: "Atlas Mask Compute Buffer",
			size: this.atlasMaskComputeData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.atlasMaskComputeBindGroupLayout = deps.device.createBindGroupLayout({
			label: "Atlas Mask Compute Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					sampler: {},
				},
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					texture: {},
				},
				{
					binding: 2,
					visibility: GPUShaderStage.COMPUTE,
					texture: {},
				},
				{
					binding: 3,
					visibility: GPUShaderStage.COMPUTE,
					storageTexture: {
						access: "write-only",
						format: "rgba8unorm",
					},
				},
				{
					binding: 4,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
			],
		});
		const computeShader = deps.device.createShaderModule({
			label: "Atlas Mask Compute Shader",
			code: ATLAS_MASK_COMPUTE_SHADER,
		});
		this.atlasMaskComputePipeline = deps.device.createComputePipeline({
			label: "Atlas Mask Compute Pipeline",
			layout: deps.device.createPipelineLayout({
				bindGroupLayouts: [this.atlasMaskComputeBindGroupLayout],
			}),
			compute: { module: computeShader, entryPoint: "computeMain" },
		});
	}

	/** Reset pool indices and flush deferred destroys from the previous frame. */
	public resetFrame(): void {
		this.clipBlitPool.beginFrame();
		this.colorAtlasMaskDrawCount = 0;
		// Destroy textures deferred during the previous frame.  By deferring
		// to the next frame's start (instead of right after queue.submit),
		// the GPU has had time to finish executing the previous command buffer.
		for (const tex of this.deferredDestroys) tex.destroy();
		this.deferredDestroys.length = 0;
		// Memoized child bakes live for exactly one frame; queue them behind the
		// same one-frame deferral so in-flight command buffers finish first.
		for (const tex of this.childBakeMemoTextures) {
			this.deferDestroy(tex);
		}
		this.childBakeMemoTextures.length = 0;
		this.childBakeMemo.clear();
		this.colorBakeAtlasAllocator = new MaskAtlasAllocator(
			COLOR_BAKE_ATLAS_SIZE,
			COLOR_BAKE_ATLAS_SIZE,
		);
		this.atlasMaskOutputAllocator = new MaskAtlasAllocator(
			COLOR_BAKE_ATLAS_SIZE,
			COLOR_BAKE_ATLAS_SIZE,
		);
	}

	/** Destroy all textures that were deferred during the frame. Call after submit. */
	public flushDeferredDestroys(): void {
		for (const tex of this.deferredDestroys) tex.destroy();
		this.deferredDestroys.length = 0;
	}

	/** Upload the frame's storage-backed atlas composite records before submit. */
	public finishFrame(): void {
		if (this.colorAtlasMaskDrawCount === 0) return;
		this.deps.device.queue.writeBuffer(
			this.colorAtlasMaskDrawBuffer,
			0,
			this.colorAtlasMaskDrawData.buffer,
			0,
			this.colorAtlasMaskDrawCount * COLOR_ATLAS_MASK_DRAW_F32_COUNT * 4,
		);
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
		this.colorAtlasMaskDrawBuffer.destroy();
		this.atlasMaskComputeBuffer.destroy();
		this.whiteMaskTexture?.destroy();
		this.whiteMaskTexture = null;
		this.colorBakeAtlasTexture?.destroy();
		this.colorBakeAtlasTexture = null;
		this.colorBakeAtlasView = null;
		this.colorBakeClearTexture?.destroy();
		this.colorBakeClearTexture = null;
		this.atlasMaskOutputTexture?.destroy();
		this.atlasMaskOutputTexture = null;
		this.atlasMaskOutputView = null;
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
	public applyWorldMasksToTexture(
		encoder: GPUCommandEncoder,
		source: RenderSurface,
		masks: readonly WorldMaskAssignment[],
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
		if (masks.length === 0) return null;
		let current: RenderSurface = source;
		let produced: ColorRenderSurface | null = null;
		for (let offset = 0; offset < masks.length; offset += MASK_CHAIN_SLOTS) {
			const chunk = masks.slice(offset, offset + MASK_CHAIN_SLOTS);
			const masked = this.applyMaskChainChunk(
				encoder,
				current,
				chunk,
				sourceScale,
				// The first chunk crops to coverBounds; later chunks re-mask the
				// already-cropped intermediate, so cropping again is a no-op.
				offset === 0 ? coverBounds : undefined,
			);
			// A failed chunk (zero-size crop) keeps the previous surface, matching
			// the skip-on-null behaviour of the per-mask loops this replaced.
			if (!masked) continue;
			if (produced) releaseRenderSurface(produced);
			produced = masked;
			current = masked;
		}
		return produced;
	}

	/**
	 * Multiply up to {@link MASK_CHAIN_SLOTS} world-space masks into an
	 * already-rendered texture in ONE pass, returning a fresh texture.
	 *
	 * This is how `ArtObject.mask` reaches elements that cannot take the inline
	 * BG3 path: the element (or its filter output) is baked first, then masked
	 * here. Doing it as a separate step is what puts the mask *after* filters —
	 * blurring an element cannot smear its mask edge outward. The chain shader
	 * samples each mask by world position, so a stacked clip chain of up to
	 * four masks multiplies in a single fragment invocation.
	 */
	private applyMaskChainChunk(
		encoder: GPUCommandEncoder,
		source: RenderSurface,
		masks: readonly WorldMaskAssignment[],
		sourceScale: number,
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

		const pass = ctx.passEncoder;
		this.drawSurfaceWithMaskChain(
			pass,
			source.texture.texture,
			ctx.coverageBounds,
			bakeUvRect,
			1,
			masks,
			ctx.entry.bindGroup,
		);
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

	private drawSurfaceWithMaskChain(
		pass: GPURenderPassEncoder,
		texture: GPUTexture,
		bounds: BoundingBox,
		uvRect: BlitUVRect,
		opacity: number,
		masks: readonly WorldMaskAssignment[],
		viewportBindGroup: GPUBindGroup,
	): void {
		this.deps.onBeforeDraw();
		if (
			this.tryDrawColorAtlasSurfaceWithMasks(
				pass,
				texture,
				bounds,
				uvRect,
				opacity,
				masks,
				viewportBindGroup,
			)
		) {
			return;
		}
		const f = this.clipBlitF32;
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
		f[12] = 0;
		f[13] = 0;
		f[14] = 0;
		f[15] = 0;

		const blitUniformBuffer = this.clipBlitPool.acquire(CLIP_BLIT_BUFFER_SIZE);
		this.deps.device.queue.writeBuffer(blitUniformBuffer, 0, f);

		const blitBindGroup = this.deps.device.createBindGroup({
			label: "Object Mask Blit Bind Group",
			layout: this.deps.blitWithMaskBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: blitUniformBuffer } },
				{ binding: 1, resource: this.deps.sampler },
				{ binding: 2, resource: this.getTextureView(texture) },
				{ binding: 3, resource: this.getWhiteMaskView() },
			],
		});

		const chain = this.maskChainF32;
		chain.fill(0);
		for (let i = 0; i < masks.length; i++) {
			const mask = masks[i];
			chain[i * 4] = mask.bounds.minX;
			chain[i * 4 + 1] = mask.bounds.minY;
			chain[i * 4 + 2] = mask.bounds.maxX;
			chain[i * 4 + 3] = mask.bounds.maxY;
			chain[16 + i] = mask.inverted ? 1 : 0;
			if (mask.atlasRect) {
				const rectOffset = 20 + i * 4;
				chain[rectOffset] = mask.atlasRect.x;
				chain[rectOffset + 1] = mask.atlasRect.y;
				chain[rectOffset + 2] = mask.atlasRect.width;
				chain[rectOffset + 3] = mask.atlasRect.height;
			}
		}
		const chainUniformBuffer = this.clipBlitPool.acquire(
			MASK_CHAIN_BUFFER_SIZE,
		);
		this.deps.device.queue.writeBuffer(chainUniformBuffer, 0, chain);

		const whiteView = this.getWhiteMaskView();
		const chainBindGroup = this.deps.device.createBindGroup({
			label: "Mask Chain Bind Group",
			layout: this.deps.maskChainBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: chainUniformBuffer } },
				{ binding: 1, resource: masks[0]?.textureView ?? whiteView },
				{ binding: 2, resource: masks[1]?.textureView ?? whiteView },
				{ binding: 3, resource: masks[2]?.textureView ?? whiteView },
				{ binding: 4, resource: masks[3]?.textureView ?? whiteView },
				{ binding: 5, resource: this.deps.sampler },
			],
		});

		pass.setPipeline(this.deps.blitWithMaskChainPipeline);
		pass.setBindGroup(0, viewportBindGroup);
		pass.setBindGroup(1, blitBindGroup);
		pass.setBindGroup(2, chainBindGroup);
		pass.draw(6);
	}

	public canDrawSurfaceWithAtlasMasks(
		surface: RenderSurface,
		masks: readonly WorldMaskAssignment[],
	): boolean {
		if (surface.placement.kind !== "world-aabb") return false;
		return this.isSharedAtlasMaskChain(masks);
	}

	private isSharedAtlasMaskChain(
		masks: readonly WorldMaskAssignment[],
	): boolean {
		if (masks.length === 0 || masks.length > ATLAS_MASK_SLOTS) return false;
		const maskView = masks[0]?.textureView;
		return Boolean(
			maskView &&
				masks.every((mask) => mask.atlasRect && mask.textureView === maskView),
		);
	}

	private canDeferWorldMasks(masks: readonly WorldMaskAssignment[]): boolean {
		return (
			masks.length <= MASK_CHAIN_SLOTS || this.isSharedAtlasMaskChain(masks)
		);
	}

	public drawSurfaceWithAtlasMasks(
		pass: GPURenderPassEncoder,
		surface: RenderSurface,
		opacity: number,
		masks: readonly WorldMaskAssignment[],
		viewportBindGroup: GPUBindGroup,
	): boolean {
		if (!this.canDrawSurfaceWithAtlasMasks(surface, masks)) return false;
		const placement = surface.placement;
		if (placement.kind !== "world-aabb") return false;
		this.deps.onBeforeDraw();
		return this.tryDrawColorAtlasSurfaceWithMasks(
			pass,
			surface.texture.texture,
			placement.bounds,
			placement.uvRect,
			opacity,
			masks,
			viewportBindGroup,
		);
	}

	private tryDrawColorAtlasSurfaceWithMasks(
		pass: GPURenderPassEncoder,
		texture: GPUTexture,
		bounds: BoundingBox,
		uvRect: BlitUVRect,
		opacity: number,
		masks: readonly WorldMaskAssignment[],
		viewportBindGroup: GPUBindGroup,
	): boolean {
		if (
			masks.length === 0 ||
			masks.length > ATLAS_MASK_SLOTS ||
			this.colorAtlasMaskDrawCount >= MAX_COLOR_ATLAS_MASK_DRAWS
		) {
			return false;
		}
		const sourceView = this.getTextureView(texture);
		const maskView = masks[0]?.textureView;
		if (
			!maskView ||
			masks.some((mask) => !mask.atlasRect || mask.textureView !== maskView)
		) {
			return false;
		}

		let bindGroupsByMask = this.colorAtlasMaskBindGroupCache.get(sourceView);
		if (!bindGroupsByMask) {
			bindGroupsByMask = new WeakMap();
			this.colorAtlasMaskBindGroupCache.set(sourceView, bindGroupsByMask);
		}
		let bindGroup = bindGroupsByMask.get(maskView);
		if (!bindGroup) {
			bindGroup = this.deps.device.createBindGroup({
				label: "Atlas Mask Bind Group",
				layout: this.colorAtlasMaskBindGroupLayout,
				entries: [
					{ binding: 0, resource: this.deps.sampler },
					{ binding: 1, resource: sourceView },
					{ binding: 2, resource: maskView },
					{
						binding: 3,
						resource: { buffer: this.colorAtlasMaskDrawBuffer },
					},
				],
			});
			bindGroupsByMask.set(maskView, bindGroup);
		}

		const drawIndex = this.colorAtlasMaskDrawCount++;
		const drawOffset = drawIndex * COLOR_ATLAS_MASK_DRAW_F32_COUNT;
		const data = this.colorAtlasMaskDrawData;
		data.fill(0, drawOffset, drawOffset + COLOR_ATLAS_MASK_DRAW_F32_COUNT);
		data.set([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY], drawOffset);
		data.set(
			[uvRect.minU, uvRect.minV, uvRect.maxU, uvRect.maxV],
			drawOffset + 4,
		);
		data[drawOffset + 8] = opacity;
		data[drawOffset + 9] = masks.length;
		const maskRectOffset = 12 + ATLAS_MASK_SLOTS * 4;
		const invertOffset = maskRectOffset + ATLAS_MASK_SLOTS * 4;
		for (let i = 0; i < masks.length; i++) {
			const mask = masks[i];
			const atlasRect = mask.atlasRect;
			if (!atlasRect) return false;
			data.set(
				[
					mask.bounds.minX,
					mask.bounds.minY,
					mask.bounds.maxX,
					mask.bounds.maxY,
				],
				drawOffset + 12 + i * 4,
			);
			data.set(
				[atlasRect.x, atlasRect.y, atlasRect.width, atlasRect.height],
				drawOffset + maskRectOffset + i * 4,
			);
			data[drawOffset + invertOffset + i] = mask.inverted ? 1 : 0;
		}

		pass.setPipeline(this.colorAtlasMaskPipeline);
		pass.setBindGroup(0, viewportBindGroup);
		pass.setBindGroup(1, bindGroup);
		pass.draw(6, 1, 0, drawIndex);
		return true;
	}

	/**
	 * Flatten a quad-mapped layer into a texture covering its world AABB.
	 *
	 * A quad layer's texture maps to four arbitrary corners, not to a rectangle,
	 * so a world-space mask cannot be multiplied into it as-is. Drawing it once
	 * through its own quad blit puts it back on a world-aligned rectangle, which
	 * {@link applyWorldMasksToTexture} can then mask like any other.
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

	/** Cached view of the white no-op mask. A mask-chain re-bake frame binds it
	 *  up to three times per chunk; in Chrome every createView is an IPC to the
	 *  GPU process, so thousands of fresh views per frame are real time. */
	private getWhiteMaskView(): GPUTextureView {
		this.whiteMaskView ??= this.getWhiteMaskTexture().createView();
		return this.whiteMaskView;
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
		/** Full-bounds bake at a caller-keyed density — see createOffscreenPass. */
		fullBoundsBake: { density: number } | null = null,
	): RasterizedRenderSurface | null {
		const ctx = this.createOffscreenPass(
			encoder,
			"Element",
			textureBounds,
			rasterScale,
			skipCull,
			filterMargin,
			fullBoundsBake,
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
		/** Full-bounds bake at a caller-keyed density — see createOffscreenPass. */
		fullBoundsBake: { density: number } | null = null,
	): RasterizedRenderSurface | null {
		if (
			Math.ceil(textureBounds.width) <= 0 ||
			Math.ceil(textureBounds.height) <= 0
		)
			return null;

		// First, collect and apply filters for child elements
		const childFilteredTextures = new Map<string, GroupChildSurface>();
		const colorBakeBatch: ColorBakeBatchItem[] = [];

		const childElements = group.childIds
			.filter((id) => id !== group.clipPathId)
			.map((id) => elementsMap.get(id))
			.filter((el): el is AnyArtObject => el !== undefined);

		// Group-level pre-filters deform every child at render time; extract
		// them up front so pre-rasterized children keep the deformation too.
		const groupPreFilters = localAppearances(group.filters).filter((f) => {
			const handler = this.deps.filterRenderer.getHandler(f.processor);
			return f.enabled !== false && !!handler?.preProcess;
		});

		// Pre-rasterize only children whose own filters need a post-process
		// pass; everything else renders inline in renderGroupChildrenToTexture,
		// which merges the group pre-filters into each child.
		for (const child of childElements) {
			const childMasks = this.deps.getElementPostMasks(child.id);
			const needsWashIsolation =
				this.deps.hasIsolatedWashAppearances?.(child.id) ?? false;
			// Wash strokes need their per-appearance isolation inside groups
			// too — without it the inline draw below renders them buildup-dark
			// with no strokeOpacity. Masked children take the inline draw
			// (mask-after-isolation is not wired yet); group pre-filters do not
			// reach the isolated render either (accepted limitation).
			if (
				this.deps.renderIsolatedWashAppearances &&
				needsWashIsolation &&
				childMasks.length === 0
			) {
				const isolated = this.deps.renderIsolatedWashAppearances(
					encoder,
					child.id,
				);
				if (isolated) {
					childFilteredTextures.set(child.id, { surface: isolated });
					continue;
				}
			}
			const childNeedsPostPass = localAppearances(child.filters).some(
				(f) =>
					f.enabled !== false &&
					!!this.deps.filterRenderer.getHandler(f.processor)?.postProcess,
			);
			// A masked child is pre-rasterized even without a filter of its own:
			// the inline draw below never applies the mask, so a filter on the
			// group would read the child before the mask removed anything.
			const hasInlineMask =
				childMasks.length === 1 &&
				this.deps.getElementMaskBindGroup(child.id) !==
					this.deps.dummyMaskBindGroup;
			if (
				!childNeedsPostPass &&
				!needsWashIsolation &&
				(childMasks.length === 0 || hasInlineMask)
			) {
				continue;
			}

			// One bake per (child, density, clamp context, parent deformation)
			// per frame. The clamp context is part of the key because interactive
			// bakes crop to the draw region, which differs between the element-
			// filter phase (real viewport) and the layer phase (prebuf store).
			const clampCtx =
				this.deps.viewportState.drawRegion ?? this.deps.viewportState.bounds;
			const memoKey = `${child.id}:${rasterScale ?? "R"}:${
				clampCtx
					? `${Math.round(clampCtx.minX)},${Math.round(clampCtx.minY)},${Math.round(clampCtx.maxX)},${Math.round(clampCtx.maxY)}`
					: "full"
			}:${groupPreFilters.map((f) => f.uid ?? f.processor).join(",")}`;
			const memoized = this.childBakeMemo.get(memoKey);
			if (memoized) {
				childFilteredTextures.set(child.id, {
					surface: createRenderSurface(
						createBorrowedTextureRef(memoized.texture, "child-bake-memo"),
						memoized.placement,
						{
							role: memoized.role,
							alphaMode: memoized.alphaMode,
							opacityState: memoized.opacityState,
						},
					),
					deferredMasks:
						this.canDeferWorldMasks(childMasks) && !needsWashIsolation
							? childMasks
							: undefined,
				});
				continue;
			}

			const effectiveChild = groupPreFilters.length
				? ({
						...child,
						filters: [...localAppearances(child.filters), ...groupPreFilters],
					} as AnyArtObject)
				: child;
			const childBounds = calculatePreFilteredElementBounds(
				effectiveChild,
				elementsMap,
				this.deps.filterRenderer,
				localBoundsCache,
			);
			const childExpansion = this.deps.filterRenderer.calculateExpansion(
				localAppearances(child.filters),
				childBounds,
			);
			const childTextureBounds = expandBounds(childBounds, childExpansion);
			const colorBakeReservation =
				child.type === "path" &&
				child.blendMode === "normal" &&
				!childNeedsPostPass &&
				groupPreFilters.length === 0 &&
				childMasks.length > 1 &&
				this.isSharedAtlasMaskChain(childMasks) &&
				!needsWashIsolation
					? this.reserveColorAtlasBake(childTextureBounds, rasterScale)
					: null;
			if (colorBakeReservation) {
				colorBakeBatch.push({
					key: child.id,
					element: child,
					elementsMap,
					bounds: colorBakeReservation.bounds,
					effectiveZoom: colorBakeReservation.effectiveZoom,
					atlasRect: colorBakeReservation.atlasRect,
					memoKey,
					deferredMasks: childMasks,
				});
				continue;
			}

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
					localAppearances(child.filters),
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
			const deferredMasks =
				this.canDeferWorldMasks(childMasks) && !needsWashIsolation
					? childMasks
					: undefined;
			if (childMasks.length > 0 && !deferredMasks) {
				const masked = this.applyWorldMasksToTexture(
					encoder,
					childSurface,
					childMasks,
					this.deps.getRasterScale(),
				);
				if (masked) {
					childSurface = replaceRenderSurface(childSurface, {
						texture: masked.texture,
						placement: masked.placement,
					});
				}
			}

			// Transfer ownership to the frame memo: the map receives a borrowed
			// ref, so the post-blit release loop below stays a no-op for the
			// shared texture, and the memo destroys it at the next frame reset.
			// Only frame-owned textures are memoizable — a borrowed source has
			// an owner with its own lifetime, and holding it for the frame would
			// be a use-after-destroy waiting to happen.
			if (childSurface.texture.kind !== "frame-owned") {
				childFilteredTextures.set(child.id, {
					surface: childSurface,
					deferredMasks,
				});
				continue;
			}
			this.childBakeMemo.set(memoKey, {
				texture: childSurface.texture.texture,
				placement: childSurface.placement,
				role: childSurface.role,
				alphaMode: childSurface.alphaMode,
				opacityState: childSurface.opacityState,
			});
			this.childBakeMemoTextures.push(childSurface.texture.texture);
			childFilteredTextures.set(child.id, {
				surface: createRenderSurface(
					createBorrowedTextureRef(
						childSurface.texture.texture,
						"child-bake-memo",
					),
					childSurface.placement,
					{
						role: childSurface.role,
						alphaMode: childSurface.alphaMode,
						opacityState: childSurface.opacityState,
					},
				),
				deferredMasks,
			});
		}
		this.renderColorBakeBatch(encoder, colorBakeBatch, childFilteredTextures);

		const ctx = this.createOffscreenPass(
			encoder,
			"Group",
			textureBounds,
			rasterScale,
			false,
			filterMargin,
			fullBoundsBake,
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
		for (const entry of childFilteredTextures.values()) {
			releaseRenderSurface(entry.surface);
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
		if (outerMasks.length > 0) {
			const masked = this.applyWorldMasksToTexture(
				encoder,
				surface,
				outerMasks,
				this.deps.getRasterScale(),
			);
			if (masked) {
				surface = replaceRenderSurface(surface, {
					texture: masked.texture,
					placement: masked.placement,
				});
			}
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
		/** Non-null bakes the full textureBounds (no viewport region clamp) at
		 *  exactly this density. A caller caching the result across frames keys
		 *  on that density, so it is passed in rather than re-derived here —
		 *  the hash and the texture can never disagree. */
		fullBoundsBake: { density: number } | null = null,
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
		// drawRegion narrows the clamp to what the frame actually renders (the
		// viewport on margined content frames, the dirty rect on partial
		// redraws) so the store margin never inflates bake areas.
		const interactiveBounds =
			filterMargin != null && !skipCull
				? (this.deps.viewportState.drawRegion ?? this.deps.viewportState.bounds)
				: null;
		const clampBounds = fullBoundsBake ? null : interactiveBounds;
		const effectiveBounds: BoundingBox = clampBounds
			? (boundsIntersectionBox(
					textureBounds,
					expandBounds(brandWorldBBox(clampBounds), filterMargin ?? 0),
				) ?? textureBounds)
			: textureBounds;

		// Interactive bakes follow the display zoom bucket — sharper zoomed in,
		// coarser zoomed out. Export frames keep the rasterizationDpi ceiling so
		// display-quality decisions never change exported pixels. A cached
		// full-bounds bake uses the caller-provided density verbatim (the caller
		// derived it from the same rule and keys its cache on it).
		const zoomBucket = interactiveBakeDensity(rasterZoom, zoom);
		const bakeZoom = fullBoundsBake
			? fullBoundsBake.density
			: interactiveBounds
				? this.deps.renderState.isExport
					? Math.min(rasterZoom, zoomBucket)
					: zoomBucket
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
		// CompositeRenderer, the brush draw bindings) use the per-pass uniform
		// buffer instead of the main one.
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
		childFilteredTextures: Map<string, GroupChildSurface>,
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
			this.deps.renderState.currentMaskBindGroup =
				this.deps.getElementMaskBindGroup(child.id);
			// Set transform index so the GPU shader applies the correct child transform
			this.deps.renderState.currentTransformIndex = this.deps.getTransformIndex(
				child.id,
			);

			const childAlpha = alphaMultiplier * child.opacity;
			// Check if this child has a pre-filtered texture
			const filteredData = childFilteredTextures.get(child.id);
			if (filteredData) {
				const surface = filteredData.surface;
				if (filteredData.deferredMasks?.length) {
					this.drawSurfaceWithMaskChain(
						activePass,
						surface.texture.texture,
						surface.placement.bounds,
						surface.placement.uvRect,
						childAlpha,
						filteredData.deferredMasks,
						this.deps.getBindGroup(),
					);
				} else {
					this.deps.blitTextureToCanvas(
						activePass,
						surface.texture.texture,
						surface.placement.bounds,
						childAlpha,
						surface.placement.uvRect,
					);
				}
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
					const childGroupPreFilters = localAppearances(child.filters).filter(
						(f) => {
							const handler = this.deps.filterRenderer.getHandler(f.processor);
							return f.enabled !== false && !!handler?.preProcess;
						},
					);
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
							filters: [
								...localAppearances(child.filters),
								...parentPreFilters,
							],
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
		this.deps.renderState.currentMaskBindGroup = this.deps.dummyMaskBindGroup;
		return activePass;
	}

	public reserveColorAtlasBake(
		textureBounds: WorldBBox,
		rasterScale?: number,
	): ColorAtlasBakeReservation | null {
		const viewportBounds = this.deps.viewportState.bounds;
		if (viewportBounds && !boundsIntersect(textureBounds, viewportBounds)) {
			return null;
		}
		const interactiveBounds =
			this.deps.viewportState.drawRegion ?? this.deps.viewportState.bounds;
		const bounds = interactiveBounds
			? (boundsIntersectionBox(textureBounds, interactiveBounds) ??
				textureBounds)
			: textureBounds;
		const zoom = this.deps.viewportState.current?.zoom ?? 1;
		const rasterZoom = rasterScale ?? zoom;
		const zoomBucket = interactiveBakeDensity(rasterZoom, zoom);
		const bakeZoom = interactiveBounds
			? this.deps.renderState.isExport
				? Math.min(rasterZoom, zoomBucket)
				: zoomBucket
			: rasterZoom;
		const width = Math.ceil(bounds.width * bakeZoom);
		const height = Math.ceil(bounds.height * bakeZoom);
		if (
			width <= 0 ||
			height <= 0 ||
			width > MAX_COLOR_BAKE_DIM ||
			height > MAX_COLOR_BAKE_DIM
		) {
			return null;
		}
		const atlasRect = this.colorBakeAtlasAllocator.allocate(width, height);
		if (!atlasRect) return null;
		return {
			bounds: brandWorldBBox(bounds),
			effectiveZoom: Math.min(
				width / bounds.width,
				height / bounds.height,
				bakeZoom,
			),
			atlasRect,
		};
	}

	private renderColorBakeBatch(
		encoder: GPUCommandEncoder,
		items: readonly ColorBakeBatchItem[],
		childFilteredTextures: Map<string, GroupChildSurface>,
	): void {
		const surfaces = this.renderColorAtlasBatch(encoder, items);
		for (const item of items) {
			const surface = surfaces.get(item.key);
			if (!surface) continue;
			this.childBakeMemo.set(item.memoKey, {
				texture: surface.texture.texture,
				placement: surface.placement,
				role: surface.role,
				alphaMode: surface.alphaMode,
				opacityState: surface.opacityState,
			});
			childFilteredTextures.set(item.element.id, {
				surface,
				deferredMasks: item.deferredMasks,
			});
		}
	}

	public renderColorAtlasBatch(
		encoder: GPUCommandEncoder,
		items: readonly ColorAtlasBakeItem[],
	): Map<string, ColorRenderSurface> {
		const surfaces = new Map<string, ColorRenderSurface>();
		if (items.length === 0) return surfaces;
		const transformsBindGroup = this.deps.getTransformsBindGroup();
		if (!transformsBindGroup) return surfaces;
		const atlas = this.ensureColorBakeAtlas();
		const clearTexture = this.ensureColorBakeClearTexture();
		this.deps.onBeforeDraw();
		for (const { atlasRect } of items) {
			encoder.copyTextureToTexture(
				{ texture: clearTexture },
				{ texture: atlas.texture, origin: [atlasRect.x, atlasRect.y] },
				[atlasRect.width, atlasRect.height],
			);
		}

		const stencilTexture = this.deps.texturePool.acquireExact(
			COLOR_BAKE_ATLAS_SIZE,
			COLOR_BAKE_ATLAS_SIZE,
			"depth24plus-stencil8",
			MSAA_SAMPLE_COUNT,
			GPUTextureUsage.RENDER_ATTACHMENT,
			"Color Bake Atlas Stencil",
		);
		const pass = encoder.beginRenderPass({
			label: `Color Bake Atlas Batch [${items.length}]`,
			colorAttachments: [
				{
					view: atlas.view,
					loadOp: "load",
					storeOp: "store",
				},
			],
			depthStencilAttachment: createPassLocalStencilAttachment(
				stencilTexture.createView(),
			),
		});
		const savedViewportBounds = this.deps.viewportState.bounds;

		for (const item of items) {
			this.deps.onBeforeDraw();
			pass.setViewport(
				item.atlasRect.x,
				item.atlasRect.y,
				item.atlasRect.width,
				item.atlasRect.height,
				0,
				1,
			);
			pass.setScissorRect(
				item.atlasRect.x,
				item.atlasRect.y,
				item.atlasRect.width,
				item.atlasRect.height,
			);
			const entry = this.deps.uniformScope.acquire(
				{
					x: (item.bounds.minX + item.bounds.maxX) / 2,
					y: (item.bounds.minY + item.bounds.maxY) / 2,
					zoom: item.effectiveZoom,
					rotation: 0,
				},
				item.atlasRect.width,
				item.atlasRect.height,
			);
			this.deps.setActiveBindGroup(entry.bindGroup, entry.buffer);
			this.deps.viewportState.bounds = item.bounds;
			this.deps.renderState.currentTransformIndex = this.deps.getTransformIndex(
				item.element.id,
			);
			this.deps.renderState.currentMaskBindGroup = this.deps.dummyMaskBindGroup;
			pass.setPipeline(this.deps.strokePipeline);
			pass.setBindGroup(0, entry.bindGroup);
			pass.setBindGroup(1, transformsBindGroup);
			pass.setBindGroup(2, this.deps.dummyGradientBindGroup);
			pass.setBindGroup(3, this.deps.dummyMaskBindGroup);
			this.deps.dispatchElementDirect(
				pass,
				item.element,
				item.elementsMap,
				1,
				"offscreen",
			);
			this.deps.onBeforeDraw();
			this.deps.setActiveBindGroup(null);

			const placement = {
				kind: "world-aabb" as const,
				bounds: item.bounds,
				uvRect: {
					minU: (item.atlasRect.x + 0.5) / COLOR_BAKE_ATLAS_SIZE,
					minV: (item.atlasRect.y + 0.5) / COLOR_BAKE_ATLAS_SIZE,
					maxU:
						(item.atlasRect.x + item.atlasRect.width - 0.5) /
						COLOR_BAKE_ATLAS_SIZE,
					maxV:
						(item.atlasRect.y + item.atlasRect.height - 0.5) /
						COLOR_BAKE_ATLAS_SIZE,
				},
			};
			const surface = {
				...createRenderSurface(
					createBorrowedTextureRef(atlas.texture, "child-bake-memo"),
					placement,
					{
						role: "color" as const,
						alphaMode: "premultiplied" as const,
						opacityState: "intrinsic" as const,
					},
				),
				effectiveZoom: item.effectiveZoom,
			};
			surfaces.set(item.key, surface);
		}

		pass.end();
		this.deps.viewportState.bounds = savedViewportBounds;
		this.deps.renderState.currentMaskBindGroup = this.deps.dummyMaskBindGroup;
		this.deps.texturePool.release(stencilTexture);
		return surfaces;
	}

	public copyColorSurfacesToAtlas(
		encoder: GPUCommandEncoder,
		items: readonly ColorAtlasCopyItem[],
	): Map<string, RenderSurface> {
		const surfaces = new Map<string, RenderSurface>();
		if (items.length === 0) return surfaces;
		const atlas = this.ensureColorBakeAtlas();
		for (const item of items) {
			const { surface } = item;
			if (surface.placement.kind !== "world-aabb") continue;
			const source = surface.texture.texture;
			const uvRect = surface.placement.uvRect;
			if (
				source.format !== this.deps.canvasFormat ||
				(source.usage & GPUTextureUsage.COPY_SRC) === 0 ||
				source.sampleCount !== 1 ||
				uvRect.minU !== 0 ||
				uvRect.minV !== 0 ||
				uvRect.maxU !== 1 ||
				uvRect.maxV !== 1 ||
				source.width > MAX_COLOR_BAKE_DIM ||
				source.height > MAX_COLOR_BAKE_DIM
			) {
				continue;
			}
			const atlasRect = this.colorBakeAtlasAllocator.allocate(
				source.width,
				source.height,
			);
			if (!atlasRect) continue;
			encoder.copyTextureToTexture(
				{ texture: source },
				{ texture: atlas.texture, origin: [atlasRect.x, atlasRect.y] },
				[source.width, source.height],
			);
			const bounds = surface.placement.bounds;
			surfaces.set(
				item.key,
				createRenderSurface(
					createBorrowedTextureRef(atlas.texture, "color-atlas"),
					{
						kind: "world-aabb",
						bounds,
						uvRect: {
							minU: (atlasRect.x + 0.5) / COLOR_BAKE_ATLAS_SIZE,
							minV: (atlasRect.y + 0.5) / COLOR_BAKE_ATLAS_SIZE,
							maxU:
								(atlasRect.x + atlasRect.width - 0.5) / COLOR_BAKE_ATLAS_SIZE,
							maxV:
								(atlasRect.y + atlasRect.height - 0.5) / COLOR_BAKE_ATLAS_SIZE,
						},
					},
					{
						role: surface.role,
						alphaMode: surface.alphaMode,
						opacityState: surface.opacityState,
					},
				),
			);
		}
		return surfaces;
	}

	public applyAtlasMasksComputeBatch(
		encoder: GPUCommandEncoder,
		items: readonly AtlasMaskComputeItem[],
	): Map<string, RenderSurface> {
		const surfaces = new Map<string, RenderSurface>();
		if (items.length === 0) return surfaces;
		const sourceTexture = this.colorBakeAtlasTexture;
		const sourceView = this.colorBakeAtlasView;
		if (!sourceTexture || !sourceView) return surfaces;
		const output = this.ensureAtlasMaskOutput();
		const data = this.atlasMaskComputeData;
		let count = 0;
		let maskView: GPUTextureView | null = null;

		for (const item of items) {
			if (
				count >= MAX_COLOR_ATLAS_MASK_DRAWS ||
				item.source.texture.texture !== sourceTexture ||
				item.source.placement.kind !== "world-aabb" ||
				!this.isSharedAtlasMaskChain(item.masks)
			) {
				continue;
			}
			const itemMaskView = item.masks[0]?.textureView;
			if (!itemMaskView || (maskView && itemMaskView !== maskView)) continue;
			maskView = itemMaskView;
			const uvRect = item.source.placement.uvRect;
			const sourceX = Math.round(uvRect.minU * COLOR_BAKE_ATLAS_SIZE - 0.5);
			const sourceY = Math.round(uvRect.minV * COLOR_BAKE_ATLAS_SIZE - 0.5);
			const sourceWidth =
				Math.round(uvRect.maxU * COLOR_BAKE_ATLAS_SIZE + 0.5) - sourceX;
			const sourceHeight =
				Math.round(uvRect.maxV * COLOR_BAKE_ATLAS_SIZE + 0.5) - sourceY;
			if (
				sourceWidth <= 0 ||
				sourceHeight <= 0 ||
				sourceWidth > MAX_COLOR_BAKE_DIM ||
				sourceHeight > MAX_COLOR_BAKE_DIM
			) {
				continue;
			}
			const destination = this.atlasMaskOutputAllocator.allocate(
				sourceWidth,
				sourceHeight,
			);
			if (!destination) continue;

			const offset = count * ATLAS_MASK_COMPUTE_F32_COUNT;
			data.fill(0, offset, offset + ATLAS_MASK_COMPUTE_F32_COUNT);
			data.set([sourceX, sourceY, sourceWidth, sourceHeight], offset);
			data.set(
				[destination.x, destination.y, destination.width, destination.height],
				offset + 4,
			);
			const bounds = item.source.placement.bounds;
			data.set(
				[bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
				offset + 8,
			);
			data[offset + 12] = item.masks.length;
			const maskRectOffset = 16 + ATLAS_MASK_SLOTS * 4;
			const invertOffset = maskRectOffset + ATLAS_MASK_SLOTS * 4;
			for (let i = 0; i < item.masks.length; i++) {
				const mask = item.masks[i];
				const atlasRect = mask.atlasRect;
				if (!atlasRect) continue;
				data.set(
					[
						mask.bounds.minX,
						mask.bounds.minY,
						mask.bounds.maxX,
						mask.bounds.maxY,
					],
					offset + 16 + i * 4,
				);
				data.set(
					[atlasRect.x, atlasRect.y, atlasRect.width, atlasRect.height],
					offset + maskRectOffset + i * 4,
				);
				data[offset + invertOffset + i] = mask.inverted ? 1 : 0;
			}
			surfaces.set(
				item.key,
				createRenderSurface(
					createBorrowedTextureRef(output.texture, "color-atlas"),
					{
						kind: "world-aabb",
						bounds,
						uvRect: {
							minU: (destination.x + 0.5) / COLOR_BAKE_ATLAS_SIZE,
							minV: (destination.y + 0.5) / COLOR_BAKE_ATLAS_SIZE,
							maxU:
								(destination.x + destination.width - 0.5) /
								COLOR_BAKE_ATLAS_SIZE,
							maxV:
								(destination.y + destination.height - 0.5) /
								COLOR_BAKE_ATLAS_SIZE,
						},
					},
					{
						role: item.source.role,
						alphaMode: item.source.alphaMode,
						opacityState: item.source.opacityState,
					},
				),
			);
			count++;
		}

		if (count === 0 || !maskView) return surfaces;
		this.deps.device.queue.writeBuffer(
			this.atlasMaskComputeBuffer,
			0,
			data.subarray(0, count * ATLAS_MASK_COMPUTE_F32_COUNT),
		);
		let bindGroup = this.atlasMaskComputeBindGroupCache.get(maskView);
		if (!bindGroup) {
			bindGroup = this.deps.device.createBindGroup({
				label: "Atlas Mask Compute Bind Group",
				layout: this.atlasMaskComputeBindGroupLayout,
				entries: [
					{ binding: 0, resource: this.deps.sampler },
					{ binding: 1, resource: sourceView },
					{ binding: 2, resource: maskView },
					{ binding: 3, resource: output.view },
					{
						binding: 4,
						resource: { buffer: this.atlasMaskComputeBuffer },
					},
				],
			});
			this.atlasMaskComputeBindGroupCache.set(maskView, bindGroup);
		}
		const pass = encoder.beginComputePass({
			label: `Atlas Mask Batch [${count}]`,
		});
		pass.setPipeline(this.atlasMaskComputePipeline);
		pass.setBindGroup(0, bindGroup);
		pass.dispatchWorkgroups(
			Math.ceil(MAX_COLOR_BAKE_DIM / 8),
			Math.ceil(MAX_COLOR_BAKE_DIM / 8),
			count,
		);
		pass.end();
		return surfaces;
	}

	private ensureAtlasMaskOutput(): {
		texture: GPUTexture;
		view: GPUTextureView;
	} {
		if (!this.atlasMaskOutputTexture || !this.atlasMaskOutputView) {
			this.atlasMaskOutputTexture = this.deps.device.createTexture({
				label: "Atlas Mask Compute Output",
				size: [COLOR_BAKE_ATLAS_SIZE, COLOR_BAKE_ATLAS_SIZE],
				format: "rgba8unorm",
				usage:
					GPUTextureUsage.STORAGE_BINDING |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC,
			});
			this.atlasMaskOutputView = this.atlasMaskOutputTexture.createView();
		}
		return {
			texture: this.atlasMaskOutputTexture,
			view: this.atlasMaskOutputView,
		};
	}

	private ensureColorBakeAtlas(): {
		texture: GPUTexture;
		view: GPUTextureView;
	} {
		if (this.colorBakeAtlasTexture && this.colorBakeAtlasView) {
			return {
				texture: this.colorBakeAtlasTexture,
				view: this.colorBakeAtlasView,
			};
		}
		this.colorBakeAtlasTexture = this.deps.device.createTexture({
			label: "Color Bake Atlas",
			size: [COLOR_BAKE_ATLAS_SIZE, COLOR_BAKE_ATLAS_SIZE],
			format: this.deps.canvasFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST,
		});
		this.colorBakeAtlasView = this.colorBakeAtlasTexture.createView();
		this.textureViewCache.set(
			this.colorBakeAtlasTexture,
			this.colorBakeAtlasView,
		);
		return {
			texture: this.colorBakeAtlasTexture,
			view: this.colorBakeAtlasView,
		};
	}

	private ensureColorBakeClearTexture(): GPUTexture {
		this.colorBakeClearTexture ??= this.deps.device.createTexture({
			label: "Color Bake Atlas Clear Texture",
			size: [MAX_COLOR_BAKE_DIM, MAX_COLOR_BAKE_DIM],
			format: this.deps.canvasFormat,
			usage: GPUTextureUsage.COPY_SRC,
		});
		return this.colorBakeClearTexture;
	}

	private getTextureView(texture: GPUTexture): GPUTextureView {
		let view = this.textureViewCache.get(texture);
		if (view) return view;
		view = texture.createView();
		this.textureViewCache.set(texture, view);
		return view;
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

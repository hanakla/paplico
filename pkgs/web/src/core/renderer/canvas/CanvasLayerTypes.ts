/**
 * Shared type definitions, constants, and callback types for the CanvasLayer
 * module family.  All sub-modules (Elements, Composite, Offscreen, Cache)
 * import from this file instead of from each other, preventing circular
 * imports.
 */

import type {
	AnyArtObject,
	BlendMode,
	BoundingBox,
	CompositionMode,
	CubicBezierSegment,
	ElementTransform,
	EmbeddedFile,
	Path,
	Viewport,
} from "../../schema";
import type { TextRenderer } from "../../typography/TextRenderer";
import type {
	LocalBBox,
	LocalBoundsCache,
	WorldBBox,
	WorldBoundsCache,
} from "../../utils/geometry/bounds";
import type { StructuredView } from "../../utils/wgpu-utils";
import type { GradientTextureGenerator } from "../generators/GradientTextureGenerator";
import type { MeshGradientTextureGenerator } from "../generators/MeshGradientTextureGenerator";
import type { RenderSurface, TextureRef } from "./pipeline/RenderSurface";

// ---------------------------------------------------------------------------
// State interfaces
// ---------------------------------------------------------------------------

/** Stencil texture state for backdrop filter clipping. */
export interface StencilState {
	texture: GPUTexture | null;
	width: number;
	height: number;
	/** Per-size textures kept alive so render targets whose sizes alternate
	 *  within a frame (canvas prebuf vs cache texture) don't recreate the
	 *  MSAA stencil on every switch. `texture` always points into this map. */
	pool?: Map<string, GPUTexture>;
}

export interface TextureState {
	texture: GPUTexture | null;
	width: number;
	height: number;
}

/** Gradient rendering state. */
export interface GradientState {
	pipeline: GPURenderPipeline;
	bindGroupLayout: GPUBindGroupLayout;
	textureGenerator: GradientTextureGenerator;
	meshTextureGenerator: MeshGradientTextureGenerator;
	placeholderTexture: GPUTexture;
	placeholderStorageBuffer: GPUBuffer;
	uniformView: StructuredView;
	stopsView: StructuredView;
	sampler: GPUSampler | null;
	bufferPool: Array<{
		uniformBuffer: GPUBuffer;
		stopsBuffer: GPUBuffer;
		vertexBuffer: GPUBuffer;
		vertexBufferSize: number;
	}>;
	drawIndex: number;
}

interface TextPathCacheEntry {
	paths: Path[];
	localBounds: BoundingBox;
}

export interface TextState {
	renderer: TextRenderer | null;
	pathCache: Map<string, TextPathCacheEntry>;
	pendingPathCacheKeys: Set<string>;
	/** Stale entries kept for rendering during async recomputation (flicker prevention). */
	stalePathCache: Map<string, TextPathCacheEntry>;
	onRequestRender?: () => void;
	onTextBoundsComputed?: (
		elementId: string,
		bounds: WorldBBox,
		localBounds: LocalBBox,
	) => void;
	onLocalBoundsChanged?: () => void;
}

export interface ViewportState {
	current: Viewport | null;
	width: number;
	height: number;
	/** Pre-computed viewport bounds for stamp culling (reused across all renderPath calls in a frame). */
	bounds: BoundingBox | null;
}

/** Cached Reference3D render result. The hash encodes every render input. */
export interface Reference3DTextureCacheEntry {
	texture: GPUTexture;
	hash: string;
}

export interface AssetState {
	textureCache: Map<string, GPUTexture>;
	imageTextureCache: Map<string, GPUTexture>;
	pendingImageLoads: Map<string, Promise<GPUTexture | null>>;
	currentFiles: EmbeddedFile[];
	pendingBrushTextureLoads: Set<string>;
	onRequestRender?: () => void;
	/**
	 * Reference3D textures keyed by element id. Lazily created by
	 * Reference3DElementRenderer; destroyed via ElementRenderer.destroyReference3DTextures
	 * (called from RenderOrchestrator destroy / releaseGPUResources).
	 */
	reference3dTextureCache?: Map<string, Reference3DTextureCacheEntry>;
}

export interface CompositeState {
	captureTexture: GPUTexture | null;
	layerTexture: GPUTexture | null;
	/** Main unrotated scene buffer. The final viewport rotation is applied only
	 *  when this texture is blitted to the framebuffer. */
	prebufTexture: GPUTexture | null;
	/** Canvas snapshot taken before an offscreen layer starts, used as
	 *  blend mode base for elements composited within that layer. */
	canvasBaseTexture: GPUTexture | null;
	finalBlitStencil: StencilState;
	backdropMask: TextureState;
	backdropMaskStencil: StencilState;
	width: number;
	height: number;
}

export interface RenderState {
	editingScopeStack: string[];
	/** Reference3D edit isolation: element kept at full opacity over the dim. */
	isolatedElementId: string | null;
	/** True during image export: gate reference3d elements on includeInExport. */
	isExport: boolean;
	/** Reference to SpatialIndex bounds cache to skip per-element bounds recomputation. */
	boundsCache: WorldBoundsCache | null;
	/**
	 * Ids (plus their ancestor groups) whose SpatialIndex entry in
	 * `boundsCache` is stale this frame because a tool preview override
	 * replaced their geometry without a document update. Bounds for these
	 * must be recomputed from the live (override) geometry — offscreen
	 * compositing textures sized from the stale entry clip the preview
	 * at the pre-drag bbox.
	 */
	staleWorldBoundsIds: ReadonlySet<string> | null;
	/**
	 * Path ids referenced by a text element's axisBinding this frame. These
	 * paths are guides (Illustrator-style): their fill/stroke is never painted,
	 * regardless of the opacity bookkeeping on the path element itself.
	 */
	textAxisPathIds: ReadonlySet<string> | null;
	/**
	 * Axis paths whose appearance underlay was already painted this frame
	 * (two texts can bind one path — the underlay must paint once).
	 */
	paintedAxisPathIds: Set<string> | null;
	/** Reference to ViewportManager's local bounds cache for rotation origin computation. */
	localBoundsCache: LocalBoundsCache | null;
	/** Current element's transform index in the GPU Storage Buffer. Set before rendering each element. */
	currentTransformIndex: number;
	/** Current element's clip mask bind group. Set before rendering each element. */
	currentMaskBindGroup: GPUBindGroup;
}

export interface CompositeRenderContext {
	encoder: GPUCommandEncoder;
	targetTexture: GPUTexture;
	restartPass: () => GPURenderPassEncoder;
	/** Canvas snapshot taken before an offscreen layer started rendering.
	 *  Used as blend mode base so that element-level blend modes produce
	 *  results identical to canvas-direct rendering. */
	baseTexture?: GPUTexture;
}

export interface BlitUVRect {
	minU: number;
	minV: number;
	maxU: number;
	maxV: number;
}

/** Four world-space corners (TL → TR → BR → BL) of a blit quad. */
export type BlitQuad = readonly [
	{ x: number; y: number },
	{ x: number; y: number },
	{ x: number; y: number },
	{ x: number; y: number },
];

/** One composited blit of a self-sized filter output (e.g. an extrude3d
 *  appearance's projected 3D solid). Blitted at `quad` when the element
 *  transform is non-identity, else at the axis-aligned `bounds`. */
export type BlitLayer = RenderSurface & {
	/** Per-layer opacity applied on blit; defaults to 1. */
	opacity?: number;
	/** Solid coverage (in alpha) sharing this layer's bounds/uvRect. Set by
	 *  the glass intermediate route: the texture content REPLACES the
	 *  backdrop within coverage, so the compositor punches the destination
	 *  by it before the src-over blit instead of keying on `texture`'s
	 *  alpha (which would leak the sharp backdrop through translucent
	 *  glass). */
	coverage?: TextureRef;
};

export interface CompoundPathGeometryCacheEntry {
	fingerprint: string;
	segments: CubicBezierSegment[];
}

export interface FilteredTextureInfo {
	source: RenderSurface;
	output: RenderSurface;
	elementBounds: BoundingBox;
	textureBounds: BoundingBox;
	/** Self-sized filter output layers (extrude3d appearances) to composite at
	 *  their own bounds/quad instead of the single filteredTexture. When set,
	 *  the main pass blits each layer in order and skips the normal blit. */
	overrideLayers?: BlitLayer[];
}

// ---------------------------------------------------------------------------
// Shared deps base interfaces
// ---------------------------------------------------------------------------

/** Immutable GPU device + format shared by all CanvasLayer sub-modules. */
export interface GPUCoreResources {
	device: GPUDevice;
	canvasFormat: GPUTextureFormat;
}

/** Shared bind state + sampler for modules that render elements directly. */
export interface SharedRenderBindings extends GPUCoreResources {
	sampler: GPUSampler;
	/** Returns the active viewport uniform bind group (may change per-pass via UniformScope). */
	getBindGroup: () => GPUBindGroup;
	blitBindGroupLayout: GPUBindGroupLayout;
	getTransformsBindGroup: () => GPUBindGroup | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sample count for render targets. Set to 1 (no MSAA) — AA is handled by fringe strips and analytical methods. */
export const RENDER_SAMPLE_COUNT = 1;

/** @deprecated Use `RENDER_SAMPLE_COUNT` instead. This alias is kept for backward compatibility. */
export const MSAA_SAMPLE_COUNT = RENDER_SAMPLE_COUNT;

/** Format of the secondary field attachment used by wet-ink stamp dynamics. */
export const LAYER_FIELD_FORMAT: GPUTextureFormat = "rgba16float";

export const FULL_BLIT_UV_RECT: BlitUVRect = {
	minU: 0,
	minV: 0,
	maxU: 1,
	maxV: 1,
};

export const BLEND_MODE_ORDER: readonly BlendMode[] = [
	"normal",
	"multiply",
	"screen",
	"overlay",
	"darken",
	"lighten",
	"color-dodge",
	"color-burn",
	"hard-light",
	"soft-light",
	"difference",
	"exclusion",
];

export const COMPOSITION_MODE_ORDER: readonly CompositionMode[] = [
	"normal",
	"alpha-lock",
];

// ---------------------------------------------------------------------------
// Callback types (for IoC cycle-breaking in later commits)
// ---------------------------------------------------------------------------

/** Signature of CanvasLayer.renderElements — injected into OffscreenPresenter. */
export type RenderElementsFn = (
	passEncoder: GPURenderPassEncoder,
	elements: AnyArtObject[],
	filteredTextures: Map<string, FilteredTextureInfo>,
	elementsMap: Map<string, AnyArtObject>,
	alphaMultiplier?: number,
	parentTransform?: ElementTransform | null,
	skipElementIds?: ReadonlySet<string>,
	pipelineType?: PipelineType,
	compositeContext?: CompositeRenderContext,
	localBoundsCache?: LocalBoundsCache,
) => GPURenderPassEncoder;

/** Signature of CanvasLayer.dispatchElementDirect — injected into OffscreenPresenter. */
export type DispatchElementDirectFn = (
	passEncoder: GPURenderPassEncoder,
	element: AnyArtObject,
	elementsMap: Map<string, AnyArtObject>,
	alpha: number,
	pipelineType: PipelineType,
) => void;

/** Signature of ElementRenderer.renderElementToMask — injected into OffscreenPresenter. */
export type RenderElementToMaskFn = (
	passEncoder: GPURenderPassEncoder,
	element: AnyArtObject,
	elementsMap: Map<string, AnyArtObject>,
) => void;

/** Signature of CanvasLayer.blitTextureToCanvas — injected into Elements/Offscreen. */
export type BlitTextureToCanvasFn = (
	passEncoder: GPURenderPassEncoder,
	texture: GPUTexture,
	bounds: BoundingBox,
	opacity?: number,
	uvRect?: BlitUVRect,
	pipeline?: GPURenderPipeline,
) => void;

/**
 * Signature of CompositeRenderer.blitQuadToCanvas — injected into
 * ImageElementRenderer to support preProcess filter deformation.
 * Corners are in world space, ordered TL → TR → BR → BL.
 */
export type BlitQuadToCanvasFn = (
	passEncoder: GPURenderPassEncoder,
	texture: GPUTexture,
	corners: BlitQuad,
	opacity?: number,
	uvRect?: BlitUVRect,
) => void;

/**
 * Signature of CompositeRenderer.blitMeshToCanvas — injected into
 * ImageElementRenderer for mesh-warped image children. `vertexData` is
 * interleaved (x, y, u, v) triangle-list data in world space.
 */
export type BlitMeshToCanvasFn = (
	passEncoder: GPURenderPassEncoder,
	texture: GPUTexture,
	vertexData: Float32Array,
	opacity?: number,
	uvRect?: BlitUVRect,
) => void;

/** Signature of CanvasLayer.renderPath — injected into CompositeRenderer. */
export type RenderPathFn = (
	passEncoder: GPURenderPassEncoder,
	path: Path,
	alphaMultiplier?: number,
	pipelineType?: PipelineType,
) => void;

/**
 * GPU-only viewport uniform write (does NOT update viewportState).
 * Injected into sub-modules that need temporary viewport overrides.
 */
export type WriteViewportUniformsFn = (
	viewport: Viewport,
	width: number,
	height: number,
) => void;

/** Pipeline type discriminator used across all renderers. */
export type PipelineType = "main" | "offscreen";

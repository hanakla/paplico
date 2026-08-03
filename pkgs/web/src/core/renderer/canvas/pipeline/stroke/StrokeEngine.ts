/**
 * StrokeEngine — per-brush-type stroke rendering interface.
 *
 * Each brush method (stroke / scatter / art / pattern / calligraphy) is owned
 * by exactly one StrokeEngine implementation. CanvasLayer dispatches via
 * StrokeEnginePicker (brush.type -> engine) and feeds the engine a fully
 * resource-resolved ResolvedStrokeStyle so the engine never has to look up
 * defs / EmbeddedFile / gradient textures itself.
 *
 * The stamp/ribbon engines drive the shared StrokeBatchContext (hosted in
 * the same `pipeline/stroke/` directory) which owns the WebGPU pipeline,
 * buffer pools, and PathMeta state. The geometric engine routes back to
 * ElementRenderer.renderGeometricStroke.
 */

import type {
	BrushSettings,
	BrushType,
	CubicBezierSegment,
	Path,
	StrokeColor,
	StrokeWidthPoint,
} from "../../../../schema";
import type { PipelineType } from "../../CanvasLayerTypes";

/**
 * Stroke-internal self-overlap blend semantics.
 *
 * - "over": premultiplied over — density accumulates as stamps overlap.
 * - "max": coverage max — uniform fill (required by the wet-ink diffusion
 *   input which assumes a single saturated alpha layer per stroke).
 * - "none": ignore self-overlap entirely.
 *
 * Only "over" is wired through the engines today; "max" / "none" are
 * declared so wet-ink and future blend modes can opt in without touching
 * the engine API.
 */
export type SelfOverlap = "none" | "over" | "max" | "wash";

/**
 * Resolved texture views that an engine consumes. The upstream resolver
 * (CanvasLayer / ElementRenderer) is responsible for turning BrushArtSource
 * (file/def) into ready-to-bind GPUTextureViews via BrushTextureManager.
 *
 * Optional / `null` today: the engines still delegate to StrokeBatchContext,
 * which resolves textures internally. The fields are populated when an
 * engine reads them directly so resolution moves out of brushSource.ts.
 */
export interface ResolvedTextureBindings {
	/** Main scatter / art / pattern source. null for stroke / calligraphy. */
	primary: GPUTextureView | null;
	/** Scatter variants packed as texture_2d_array. */
	scatterArray?: GPUTextureView;
	/** Optional first-stamp source (scatter). */
	start?: GPUTextureView;
	/** Optional last-stamp source (scatter). */
	end?: GPUTextureView;
}

/**
 * Resolved stroke color. `solid` carries straight numeric channels;
 * `gradient` and `pattern` carry a pre-baked sampler-ready texture view.
 *
 * Engines that still delegate to StrokeBatchContext read the unresolved
 * StrokeColor instead and let the batch build gradient stops on its own;
 * engines that own their own pipelines should consume the resolved form.
 */
export type ResolvedStrokeColor =
	| { kind: "solid"; r: number; g: number; b: number; a: number }
	| {
			kind: "gradient";
			textureView: GPUTextureView;
			boundsMin: [number, number];
			boundsMax: [number, number];
	  }
	| {
			kind: "pattern";
			textureView: GPUTextureView;
			boundsMin: [number, number];
			boundsMax: [number, number];
	  };

/**
 * Fully resource-resolved input to a StrokeEngine.
 *
 * Engines must NOT re-resolve resources from this struct. Everything they
 * need for pipeline binding (texture views, color buffers, alpha) is here.
 *
 * The original Path / StrokeColor are retained in `legacyPath` because the
 * StrokeBatchContext-backed engines still hand them to the shared batch.
 * An engine that owns its pipeline can render from segments + brush +
 * textures + color alone and ignore the legacy slot.
 */
export interface ResolvedStrokeStyle {
	/** Stroke geometry (already pre-filter-applied). */
	segments: CubicBezierSegment[];
	/** Optional variable stroke widths (eraser / path edit). */
	strokeWidths?: StrokeWidthPoint[];
	/** Path start fraction along the curve [0,1]. */
	pathStart?: number;
	/** Path end fraction along the curve [0,1]. */
	pathEnd?: number;

	/** Brush settings; engine matches on `type`. */
	brush: BrushSettings;
	/** Pre-resolved GPU texture views the engine should bind. */
	textures: ResolvedTextureBindings;
	/** Pre-resolved stroke color (solid value, or sampled texture). */
	color: ResolvedStrokeColor;

	/** Stroke-internal blend semantics; "over" preserves current behaviour. */
	selfOverlap: SelfOverlap;
	/** Combined element / appearance opacity multiplier. */
	alphaMultiplier: number;
	/** Transform buffer index for the owning element. */
	transformIndex: number;

	/**
	 * Legacy adapter slot — the original Path that owned this stroke.
	 *
	 * Engines forward this to StrokeBatchContext / ElementRenderer because
	 * those implementations still consume Path directly. A later refactor may
	 * remove this once the resolved input alone is sufficient.
	 */
	legacyPath: Path;
	/** Original StrokeColor — retained while ResolvedStrokeColor is wrapper-only. */
	legacyStrokeColor: StrokeColor;
}

/**
 * BindGroup layouts that are shared across all StrokeEngines.
 *
 * `group 0` and `group 1` are reserved engine-wide so multiple engines can
 * cooperate in a single render pass without rebuilding viewport state.
 * Engines own `group 2+` (textures, brush uniforms, optional field output).
 *
 * RenderOrchestrator builds these once and passes them to every engine.
 */
export interface SharedBindGroupLayouts {
	/** group 0: viewport uniform (world<->NDC, zoom, resolution). */
	viewport: GPUBindGroupLayout;
	/** group 1: transforms storage buffer + index. */
	transforms: GPUBindGroupLayout;
	/** group 3 (engine-side): per-element mask bind group layout. */
	mask: GPUBindGroupLayout;
}

/**
 * Engine pipeline construction context, supplied by CanvasLayer.
 */
export interface EnginePipelineContext {
	device: GPUDevice;
	/**
	 * Target color attachment format for the engine's pipeline. Equals
	 * canvasFormat today; once wet-ink switches the layer intermediate to
	 * rgba16float this becomes that intermediate's format.
	 */
	colorFormat: GPUTextureFormat;
	/** Format of the wet-ink dynamics field render target (rgba16float). */
	fieldFormat: GPUTextureFormat;
	/** MSAA sample count (currently 1 — see CanvasLayerTypes.RENDER_SAMPLE_COUNT). */
	sampleCount: number;
	/** Layouts shared across engines. */
	bindGroupLayouts: SharedBindGroupLayouts;
}

/**
 * Engine pipeline — owns GPU resources for one brush method.
 *
 * Engines that delegate to StrokeBatchContext / ElementRenderer keep this
 * record empty; engines that own their own pipeline create / destroy GPU
 * resources from createPipeline / destroy().
 */
export interface EnginePipeline {
	/**
	 * Render a single resolved stroke into the active render pass.
	 *
	 * For batch-capable engines this is also the entry point for immediate /
	 * offscreen / stencil fallbacks. Batched accumulation is driven through
	 * the StrokeEngineRegistry's beginBatch / addToBatch / flushBatch API.
	 */
	render(
		pass: GPURenderPassEncoder,
		style: ResolvedStrokeStyle,
		pipelineType: PipelineType,
		transformsBindGroup: GPUBindGroup,
	): void;

	/**
	 * Add the resolved stroke to the current batch accumulator. Returns
	 * `false` when the engine has no batching support (caller must fall back
	 * to render()).
	 */
	addToBatch?(style: ResolvedStrokeStyle, transformIndex: number): boolean;

	/** Free any owned GPU resources. */
	destroy(): void;
}

/**
 * StrokeEngine — registry-facing type. One engine per BrushType family.
 *
 * `ids` lists every BrushType this engine claims (stamp engine takes scatter
 * and calligraphy; ribbon engine takes art and pattern; geometric engine
 * takes stroke).
 *
 * `supportsField` declares whether the engine knows how to emit the wet-ink
 * dynamics field on a second render target (rgba16float = dirX·w, dirY·w,
 * wetness·w, w). The wet-ink path skips engines that return `false`, so
 * methods with no wetness model (art / pattern / geometric stroke) opt out
 * via this flag.
 */
export interface StrokeEngine {
	readonly ids: readonly BrushType[];
	readonly supportsField: boolean;
	createPipeline(ctx: EnginePipelineContext): EnginePipeline;
}

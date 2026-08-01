import { makeStructuredView } from "webgpu-utils";
import type { SoftProofLutResult } from "../color/types";
import {
	type AnyArtObject,
	type Artboard,
	type BrushType,
	type Document,
	type Filter,
	getArtboardBounds,
	type RawRGBA,
	type TextElement,
	type Viewport,
} from "../schema";
import {
	buildDocumentTextResolver,
	type TextDocumentResolver,
	TextLayoutEngine,
	TextRenderer,
} from "../typography";
import { getFontManager } from "../typography/fonts";
import {
	calculateElementBounds,
	type LocalBBox,
	type WorldBBox,
} from "../utils/geometry/bounds";
import {
	compileShaderModule,
	type ShaderDataDefinitions,
	type StructuredView,
} from "../utils/wgpu-utils";
import type { CanvasTarget } from "./CanvasTarget";
import { type CanvasFrameTransaction, CanvasLayer } from "./canvas/CanvasLayer";
import { expandRenderFilter } from "./canvas/CanvasLayer.helpers";
import { RENDER_SAMPLE_COUNT } from "./canvas/CanvasLayerTypes";
import { RenderCacheManager } from "./canvas/caches/RenderCacheManager";
import type { Reference3DRenderContext } from "./canvas/elements/Reference3DElementRenderer";
import { BackdropCaptureManager } from "./canvas/pipeline/BackdropCaptureManager";
import { BrushTextureManager } from "./canvas/pipeline/brush/BrushTextureManager";
import {
	type FilterHandler,
	FilterRenderer,
	type RegisterableFilterHandler,
} from "./canvas/pipeline/FilterRenderer";
import {
	buildFilterPlansForElements,
	calculatePreFilteredElementBounds,
} from "./canvas/pipeline/RenderPlanner";
import { createGeometricStrokeEngine } from "./canvas/pipeline/stroke/GeometricStrokeEngine";
import { createRibbonStrokeEngine } from "./canvas/pipeline/stroke/RibbonStrokeEngine";
import { createStampStrokeEngine } from "./canvas/pipeline/stroke/StampStrokeEngine";
import { StrokeBatchContext } from "./canvas/pipeline/stroke/StrokeBatchContext";
import type {
	EnginePipeline,
	EnginePipelineContext,
} from "./canvas/pipeline/stroke/StrokeEngine";
import { StrokeEngineRegistry } from "./canvas/pipeline/stroke/StrokeEnginePicker";
import {
	UNIFIED_VERTEX_BYTES,
	UNIFIED_VERTEX_OFFSETS,
} from "./canvas/pipeline/unifiedVertexLayout";
import { BlurFilterProcessor } from "./filters/BlurFilterProcessor";
import { DropShadowFilterProcessor } from "./filters/DropShadowFilterProcessor";
import { Extrude3DFilterHandler } from "./filters/Extrude3DFilterHandler";
import { FrostGlassFilterProcessor } from "./filters/FrostGlassFilterProcessor";
import { HKBloomHandler } from "./filters/hanakla-kit/HKBloomHandler";
import { HKBlushStrokeHandler } from "./filters/hanakla-kit/HKBlushStrokeHandler";
import { HKChromaticAberrationHandler } from "./filters/hanakla-kit/HKChromaticAberrationHandler";
import { HKColorReplacementHandler } from "./filters/hanakla-kit/HKColorReplacementHandler";
import { HKComicToneHandler } from "./filters/hanakla-kit/HKComicToneHandler";
import { HKDirectionalBlurHandler } from "./filters/hanakla-kit/HKDirectionalBlurHandler";
import { HKFluidHandler } from "./filters/hanakla-kit/HKFluidHandler";
import { HKGlitchHandler } from "./filters/hanakla-kit/HKGlitchHandler";
import { HKGradientMapHandler } from "./filters/hanakla-kit/HKGradientMapHandler";
import { HKHalftoneHandler } from "./filters/hanakla-kit/HKHalftoneHandler";
import { HKHuskyHandler } from "./filters/hanakla-kit/HKHuskyHandler";
import { HKInnerGlowHandler } from "./filters/hanakla-kit/HKInnerGlowHandler";
import { HKKaleidoscopeHandler } from "./filters/hanakla-kit/HKKaleidoscopeHandler";
import { HKKirakiraHandler } from "./filters/hanakla-kit/HKKirakiraHandler";
import { HKOutlineHandler } from "./filters/hanakla-kit/HKOutlineHandler";
import { HKPaperV2Handler } from "./filters/hanakla-kit/HKPaperV2Handler";
import { HKPixelSortHandler } from "./filters/hanakla-kit/HKPixelSortHandler";
import { HKPosterizationHandler } from "./filters/hanakla-kit/HKPosterizationHandler";
import { HKRadialRotDirHandler } from "./filters/hanakla-kit/HKRadialRotDirHandler";
import { HKSelectiveCorrectionHandler } from "./filters/hanakla-kit/HKSelectiveCorrectionHandler";
import { HKSmearHandler } from "./filters/hanakla-kit/HKSmearHandler";
import { HKSprayingHandler } from "./filters/hanakla-kit/HKSprayingHandler";
import { HKTurbulenceHandler } from "./filters/hanakla-kit/HKTurbulenceHandler";
import { HKVhsInterlaceHandler } from "./filters/hanakla-kit/HKVhsInterlaceHandler";
import { HKWaveHandler } from "./filters/hanakla-kit/HKWaveHandler";
import { PathOffsetFilterHandler } from "./filters/PathOffsetFilterProcessor";
import { PathUnionFilterHandler } from "./filters/PathUnionFilterProcessor";
import { PixelateFilterProcessor } from "./filters/PixelateFilterProcessor";
import { PuckerBloatFilterHandler } from "./filters/PuckerBloatFilterProcessor";
import { Revolve3DFilterHandler } from "./filters/Revolve3DFilterHandler";
import { Rotate3DFilterProcessor } from "./filters/Rotate3DFilterProcessor";
import { ZigzagFilterHandler } from "./filters/ZigzagFilterProcessor";
import { GPUTimingProfiler } from "./GPUTimingProfiler";
import { GradientTextureGenerator } from "./generators/GradientTextureGenerator";
import { MeshGradientTextureGenerator } from "./generators/MeshGradientTextureGenerator";
import {
	createFullscreenPipeline,
	createGeometryPipeline,
} from "./PipelineFactory";
import {
	BLIT_BACKDROP_WITH_MASK_SHADER,
	BLIT_GLASS_PUNCH_SHADER,
	BLIT_SHADER,
	BLIT_WITH_ERASE_MASK_SHADER,
	BLIT_WITH_MASK_SHADER,
	EXPOSURE_BLIT_SHADER,
	MESH_BLIT_SHADER,
	QUAD_BLIT_SHADER,
} from "./shaders/blit.wgsl";
import { COMPOSITE_SHADER } from "./shaders/composite.wgsl";
import { COONS_PATCH_COMPUTE_SHADER } from "./shaders/coonsPatchCompute.wgsl";
import { GRADIENT_FILL_SHADER } from "./shaders/gradientFill.wgsl";
import { UNIFIED_GEOMETRY_SHADER } from "./shaders/unified.wgsl";
import { UNIFIED_PULLED_GEOMETRY_SHADER } from "./shaders/unifiedPulled.wgsl";
import type { FrameRequest, UIOverlayState } from "./types";
import { UILayer } from "./ui/UILayer";

/**
 * Rendering strategy resolved from dirty reasons.
 * Renderer receives this instead of raw dirty reasons.
 */
export const RenderStrategy = {
	/** Re-render document + overlay (viewport/resize/document changed) */
	full: "full",
	/** Re-render document but skip expensive effects (backdrop filters) */
	fullInteraction: "fullInteraction",
	/** Re-render document keeping boundsCache (shape-preserving changes: moves, paste, duplicate) */
	fullTransformOnly: "fullTransformOnly",
	/** Skip the document render entirely: blit the cached composite frame and
	 *  reproject it through the current viewport (pan/zoom during a gesture).
	 *  The overlay layer still re-renders, so gizmos/selection stay crisp. */
	viewportBlit: "viewportBlit",
	/** Re-render document + overlay without full cache invalidation (async
	 *  resource load, post-process toggle, tile-convergence follow-up) */
	overlayOnly: "overlayOnly",
} as const;
export type RenderStrategy = keyof typeof RenderStrategy;

interface TargetData {
	context: GPUCanvasContext;
	uniformBuffer: GPUBuffer;
	viewportUniformView: StructuredView;
	bindGroup: GPUBindGroup;
	canvasLayer: CanvasLayer;
	uiLayer: UILayer;
	strokeRegistry: StrokeEngineRegistry;
	backdropCaptureManager: BackdropCaptureManager;
	cacheManager: RenderCacheManager;
}

interface Pipelines {
	strokePipeline: GPURenderPipeline;
	fillPipeline: GPURenderPipeline;
	gradientFillPipeline: GPURenderPipeline;
	dummyGradientBindGroup: GPUBindGroup;
	dummyMaskBindGroup: GPUBindGroup;
	stencilFanWritePipeline: GPURenderPipeline;
	stencilCoverPipeline: GPURenderPipeline;
	strokeUnionPipeline: GPURenderPipeline;
	stencilZeroPipeline: GPURenderPipeline;
	pulledGeometryPipeline: GPURenderPipeline;
	pulledStencilFanWritePipeline: GPURenderPipeline;
	blitPipeline: GPURenderPipeline;
	blitPipelineRgba8: GPURenderPipeline;
	blitPipelineRgba32Float: GPURenderPipeline;
	blitWithMaskPipeline: GPURenderPipeline;
	blitWithEraseMaskPipeline: GPURenderPipeline;
	blitBackdropWithMaskPipeline: GPURenderPipeline;
	blitBackdropPunchPipeline: GPURenderPipeline;
	blitGlassPunchPipeline: GPURenderPipeline;
	compositePipeline: GPURenderPipeline;
	exposureBlitPipeline: GPURenderPipeline;
	quadBlitPipeline: GPURenderPipeline;
	meshBlitPipeline: GPURenderPipeline;
}

interface Layouts {
	blit: GPUBindGroupLayout;
	blitWithMask: GPUBindGroupLayout;
	composite: GPUBindGroupLayout;
	exposureBlit: GPUBindGroupLayout;
	gradient: GPUBindGroupLayout;
	transforms: GPUBindGroupLayout;
	mask: GPUBindGroupLayout;
	/** BG2 of the vertex-pulling pipelines: vertex store + run table. */
	pulled: GPUBindGroupLayout;
}

export class RenderOrchestrator {
	private initialized = false;
	private destroyed = false;
	private device: GPUDevice | null = null;
	private canvasFormat: GPUTextureFormat = "bgra8unorm";
	private hdrEnabled = false;
	private canvasColorSpace: "srgb" | "display-p3" = "display-p3";

	#hdrGpuSupported = false;

	public get hdrGpuSupported(): boolean {
		return this.#hdrGpuSupported;
	}

	// Shared resources (device-level)
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private transformsBindGroupLayout: GPUBindGroupLayout | null = null;
	private sampler: GPUSampler | null = null;
	private nearestSampler: GPUSampler | null = null;
	private viewportShaderDefs: ShaderDataDefinitions | null = null;
	private gradientShaderCompiled: {
		module: GPUShaderModule;
		uniformViews: Record<string, StructuredView>;
		storageViews: Record<string, StructuredView>;
	} | null = null;
	private pipelines: Pipelines | null = null;
	private layouts: Layouts | null = null;
	private brushTextureManager: BrushTextureManager | null = null;
	private gradientTextureGenerator: GradientTextureGenerator | null = null;
	private meshGradientTextureGenerator: MeshGradientTextureGenerator | null =
		null;
	private filterRenderer: FilterRenderer | null = null;
	private textRenderer: TextRenderer | null = null;
	private textDocumentResolver: TextDocumentResolver | null = null;
	private profiler: GPUTimingProfiler | null = null;
	private readonly disposedDevices = new WeakSet<GPUDevice>();

	// Per-target resources
	private targets = new Map<string, TargetData>();
	private activeTarget: CanvasTarget | null = null;
	private registeredTargets = new Set<CanvasTarget>();

	/** CPU-side soft proof LUT, retained so it can be re-uploaded after
	 *  device re-initialization (HDR switch, device loss recovery). */
	private softProofLut: SoftProofLutResult | null = null;

	// Stored callbacks (applied to new targets)
	private _onRequestRender: (() => void) | null = null;
	private _onTextBoundsComputed:
		| ((elementId: string, bounds: WorldBBox, localBounds: LocalBBox) => void)
		| null = null;
	private _reference3dContextProvider:
		| (() => Reference3DRenderContext | null)
		| null = null;

	// Pending device re-initialization (HDR switch, device recovery)
	#pendingDeviceReInit: Promise<boolean> | null = null;

	// Device lost recovery
	private recoveryAttempt = 0;
	private static readonly MAX_RECOVERY_ATTEMPTS = 5;
	private static readonly BASE_RECOVERY_DELAY_MS = 1_000;
	private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	private onDeviceLost: (() => void) | null = null;
	private onDeviceRestored: (() => void) | null = null;
	private onDeviceRecoveryFailed: (() => void) | null = null;

	public async initDevice(): Promise<boolean> {
		if (this.destroyed) return false;
		if (!navigator.gpu) {
			console.error("WebGPU is not supported in this browser");
			return false;
		}

		try {
			const adapter = await navigator.gpu.requestAdapter();
			if (!adapter) {
				console.error("Failed to get GPU adapter");
				return false;
			}

			const requiredFeatures: GPUFeatureName[] = [];
			if (adapter.features.has("timestamp-query")) {
				requiredFeatures.push("timestamp-query");
			}

			// Lift the storage-binding / buffer ceilings to what the adapter
			// supports. The default device limits (128 MiB storage binding) sit
			// far below capable hardware and cap the resident stamp atlas: a large
			// stress document grows it past 128 MiB and binding the whole buffer
			// fails validation. Requesting up to adapter.limits is always valid.
			// (Bounded paging of the stamp store is the durable fix; this lifts
			// the immediate ceiling so the crash needs a far larger document.)
			const requiredLimits: Record<string, number> = {
				maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
				maxBufferSize: adapter.limits.maxBufferSize,
			};

			const device = await adapter.requestDevice({
				requiredFeatures,
				requiredLimits,
			});
			if (this.destroyed) {
				this.disposedDevices.add(device);
				device.destroy();
				return false;
			}
			this.device = device;
			device.lost.then((info) => this.handleDeviceLost(device, info));

			// Raised from 64: glass extrude passes (mesh/blur/compose, per instance)
			// add many timed passes on top of the layer/composite passes.
			this.profiler = new GPUTimingProfiler(this.device, 256);

			// Probe rgba16float support regardless of hdrEnabled
			const testCanvas = globalThis.document?.createElement("canvas");
			const testCtx = testCanvas?.getContext(
				"webgpu",
			) as GPUCanvasContext | null;
			if (testCtx) {
				try {
					testCtx.configure({
						device: this.device,
						format: "rgba16float",
						alphaMode: "premultiplied",
					});
					testCtx.unconfigure();
					this.#hdrGpuSupported = true;
				} catch {
					this.#hdrGpuSupported = false;
				}
			} else {
				this.#hdrGpuSupported = false;
			}

			if (this.hdrEnabled && this.#hdrGpuSupported) {
				this.canvasFormat = "rgba16float";
			} else {
				if (this.hdrEnabled) {
					console.warn("rgba16float not supported, falling back to SDR");
					this.hdrEnabled = false;
				}
				this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
			}

			await this.createSharedResources();
			await this.initPipelinesAndSharedSystems();
			if (this.destroyed || this.device !== device) {
				if (this.device === device) this.releaseGPUResources();
				if (!this.disposedDevices.has(device)) {
					this.disposedDevices.add(device);
					device.destroy();
				}
				return false;
			}

			this.initialized = true;
			this.recoveryAttempt = 0;
			return true;
		} catch (error) {
			this.releaseGPUResources();
			console.error("Failed to initialize WebGPU device:", error);
			return false;
		}
	}

	public async initCanvasTarget(target: CanvasTarget): Promise<void> {
		// Wait for any pending device re-initialization (e.g. HDR switch)
		if (this.#pendingDeviceReInit) {
			const success = await this.#pendingDeviceReInit;
			if (!success) {
				throw new Error(
					"Pending device re-initialization failed before initCanvasTarget()",
				);
			}
		}

		if (
			!this.device ||
			!this.pipelines ||
			!this.layouts ||
			!this.bindGroupLayout ||
			!this.transformsBindGroupLayout ||
			!this.sampler ||
			!this.viewportShaderDefs ||
			!this.gradientShaderCompiled ||
			!this.filterRenderer ||
			!this.brushTextureManager ||
			!this.gradientTextureGenerator
		) {
			throw new Error("initDevice() must be called before initCanvasTarget()");
		}

		const context = target.getContext(this.device, this.canvasFormat, {
			toneMapping: this.hdrEnabled ? { mode: "extended" } : undefined,
			colorSpace: this.canvasColorSpace,
		});

		const viewportUniformView = makeStructuredView(
			this.viewportShaderDefs.uniforms.uniforms,
		);

		const uniformBuffer = this.device.createBuffer({
			label: `Uniform Buffer [${target.id}]`,
			size: viewportUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		const bindGroup = this.device.createBindGroup({
			label: `Bind Group [${target.id}]`,
			layout: this.bindGroupLayout,
			entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
		});

		const backdropCaptureManager = new BackdropCaptureManager(
			this.device,
			this.filterRenderer,
		);

		const cacheManager = new RenderCacheManager();

		// Mutable holder for the current mask bind group.
		// Initialized to the dummy (no-mask) bind group; CanvasLayer updates it
		// per-element before rendering via the maskBindGroupRef setter.
		const maskBindGroupRef = { current: this.pipelines.dummyMaskBindGroup };

		const strokeBatchContext = new StrokeBatchContext(
			this.device,
			this.canvasFormat,
			uniformBuffer,
			this.brushTextureManager,
			this.transformsBindGroupLayout,
			// Thunk, not the instance: the manager swaps its active document
			// scope between frames, so the stamp cache must be re-resolved per use.
			() => cacheManager.stamp,
			this.layouts.mask,
			() => maskBindGroupRef.current,
		);

		// Construct stroke engines + registry. The stamp/ribbon engines drive
		// the shared StrokeBatchContext that owns the stamp + ribbon
		// pipelines; the geometric engine routes back to
		// ElementRenderer.renderPath, which lives on CanvasLayer — we hold a
		// forward reference and bind the real callback right after CanvasLayer
		// is constructed.
		const canvasLayerRef: { current: CanvasLayer | null } = { current: null };
		const geometricEngine = createGeometricStrokeEngine(
			(pass, path, alpha, pipelineType) => {
				canvasLayerRef.current?.elements.renderPath(
					pass,
					path,
					alpha,
					pipelineType,
				);
			},
		);
		const stampEngine = createStampStrokeEngine(strokeBatchContext);
		const ribbonEngine = createRibbonStrokeEngine(strokeBatchContext);
		const engineCtx: EnginePipelineContext = {
			device: this.device,
			colorFormat: this.canvasFormat,
			fieldFormat: "rgba16float",
			sampleCount: 1,
			bindGroupLayouts: {
				viewport: this.bindGroupLayout,
				transforms: this.transformsBindGroupLayout,
				mask: this.layouts.mask,
			},
		};
		const enginePipelines = new Map<BrushType, EnginePipeline>();
		for (const engine of [geometricEngine, stampEngine, ribbonEngine]) {
			const pipeline = engine.createPipeline(engineCtx);
			for (const id of engine.ids) {
				enginePipelines.set(id, pipeline);
			}
		}
		const strokeRegistry = new StrokeEngineRegistry(
			{
				geometric: geometricEngine,
				stamp: stampEngine,
				ribbon: ribbonEngine,
			},
			strokeBatchContext,
			enginePipelines,
		);

		const canvasLayer = new CanvasLayer(
			this.device,
			this.canvasFormat,
			{
				strokePipeline: this.pipelines.strokePipeline,
				fillPipeline: this.pipelines.fillPipeline,
				stencilFanWritePipeline: this.pipelines.stencilFanWritePipeline,
				stencilCoverPipeline: this.pipelines.stencilCoverPipeline,
				strokeUnionPipeline: this.pipelines.strokeUnionPipeline,
				stencilZeroPipeline: this.pipelines.stencilZeroPipeline,
				pulledGeometryPipeline: this.pipelines.pulledGeometryPipeline,
				pulledStencilFanWritePipeline:
					this.pipelines.pulledStencilFanWritePipeline,
				gradientFillPipeline: this.pipelines.gradientFillPipeline,
				blitPipeline: this.pipelines.blitPipeline,
				blitPipelineRgba8: this.pipelines.blitPipelineRgba8,
				blitPipelineRgba32Float: this.pipelines.blitPipelineRgba32Float,
				blitWithMaskPipeline: this.pipelines.blitWithMaskPipeline,
				blitWithEraseMaskPipeline: this.pipelines.blitWithEraseMaskPipeline,
				blitBackdropWithMaskPipeline:
					this.pipelines.blitBackdropWithMaskPipeline,
				blitBackdropPunchPipeline: this.pipelines.blitBackdropPunchPipeline,
				blitGlassPunchPipeline: this.pipelines.blitGlassPunchPipeline,
				compositePipeline: this.pipelines.compositePipeline,
				exposureBlitPipeline: this.pipelines.exposureBlitPipeline,
				quadBlitPipeline: this.pipelines.quadBlitPipeline,
				meshBlitPipeline: this.pipelines.meshBlitPipeline,
			},
			{
				uniformBuffer,
				viewportUniformView,
				bindGroup,
				viewportBindGroupLayout: this.bindGroupLayout,
				blitBindGroupLayout: this.layouts.blit,
				blitWithMaskBindGroupLayout: this.layouts.blitWithMask,
				compositeBindGroupLayout: this.layouts.composite,
				exposureBlitBindGroupLayout: this.layouts.exposureBlit,
				gradientBindGroupLayout: this.layouts.gradient,
				transformsBindGroupLayout: this.layouts.transforms,
				gradientUniformView: this.gradientShaderCompiled.uniformViews.gradient,
				gradientStopsView: this.gradientShaderCompiled.storageViews.colorStops,
				sampler: this.sampler,
				nearestSampler: this.nearestSampler!,
				filterRenderer: this.filterRenderer,
				backdropCaptureManager,
				gradientTextureGenerator: this.gradientTextureGenerator,
				meshGradientTextureGenerator: this.meshGradientTextureGenerator!,
				dummyGradientBindGroup: this.pipelines.dummyGradientBindGroup,
				dummyMaskBindGroup: this.pipelines.dummyMaskBindGroup,
				maskBindGroupLayout: this.layouts.mask,
				pulledBindGroupLayout: this.layouts.pulled,
				maskBindGroupRef,
				cacheManager,
				textRenderer: this.textRenderer ?? undefined,
			},
			target.id,
		);

		canvasLayerRef.current = canvasLayer;
		canvasLayer.setStrokeRegistry(strokeRegistry);

		const uiLayer = new UILayer(
			this.device,
			this.bindGroupLayout,
			bindGroup,
			this.canvasFormat,
		);

		if (this._onRequestRender)
			canvasLayer.setOnRequestRender(this._onRequestRender);
		if (this._onTextBoundsComputed)
			canvasLayer.setOnTextBoundsComputed(this._onTextBoundsComputed);
		if (this._reference3dContextProvider)
			canvasLayer.setReference3DContextProvider(
				this._reference3dContextProvider,
			);
		// GPU textures don't survive device re-init (HDR switch, device loss
		// recovery) — re-upload the soft proof LUT from the CPU-side copy.
		if (this.softProofLut) canvasLayer.setSoftProofLut(this.softProofLut);

		this.targets.set(target.id, {
			context,
			uniformBuffer,
			viewportUniformView,
			bindGroup,
			canvasLayer,
			uiLayer,
			strokeRegistry,
			backdropCaptureManager,
			cacheManager,
		});

		this.registeredTargets.add(target);
	}

	/**
	 * Switch HDR rendering mode. Reinitializes the GPU pipeline and canvas contexts.
	 */
	public async setHdrEnabled(enabled: boolean): Promise<void> {
		if (this.hdrEnabled === enabled) {
			// Serialize concurrent calls — a previous setHdrEnabled() may still
			// be re-initializing the device. Without this, a concurrent caller
			// could proceed while pipelines are still null.
			if (this.#pendingDeviceReInit) await this.#pendingDeviceReInit;
			return;
		}
		this.hdrEnabled = enabled;

		for (const target of this.registeredTargets) {
			target.unconfigureContext();
		}
		if (this.#pendingDeviceReInit) await this.#pendingDeviceReInit;
		this.releaseGPUResources();

		this.#pendingDeviceReInit = this.initDevice();
		const success = await this.#pendingDeviceReInit;
		this.#pendingDeviceReInit = null;

		if (success) {
			for (const target of this.registeredTargets) {
				await this.initCanvasTarget(target);
			}
			this._onRequestRender?.();
		} else if (enabled) {
			// HDR init failed, fall back to SDR
			console.warn("HDR init failed, reverting to SDR");
			this.hdrEnabled = false;
			this.#pendingDeviceReInit = this.initDevice();
			const sdrSuccess = await this.#pendingDeviceReInit;
			this.#pendingDeviceReInit = null;
			if (sdrSuccess) {
				for (const target of this.registeredTargets) {
					await this.initCanvasTarget(target);
				}
				this._onRequestRender?.();
			}
		}
	}

	/**
	 * Switch the canvas color space to the document's working space. Each
	 * registered context is reconfigured in place; unlike HDR switching the
	 * device/format is unchanged, so GPU resources are retained.
	 */
	public setColorSpace(colorSpace: "srgb" | "display-p3"): void {
		if (this.canvasColorSpace === colorSpace) return;
		this.canvasColorSpace = colorSpace;
		if (!this.device) return;
		for (const target of this.registeredTargets) {
			target.unconfigureContext();
			target.getContext(this.device, this.canvasFormat, {
				toneMapping: this.hdrEnabled ? { mode: "extended" } : undefined,
				colorSpace,
			});
		}
		this._onRequestRender?.();
	}

	/**
	 * Set or clear the soft proof 3D LUT on all canvas targets.
	 * The CPU-side data is retained so the LUT survives device
	 * re-initialization (see initCanvasTarget).
	 */
	public setSoftProofLut(lut: SoftProofLutResult | null): void {
		this.softProofLut = lut;
		for (const td of this.targets.values()) {
			td.canvasLayer.setSoftProofLut(lut);
		}
	}

	public setCanvasTarget(target: CanvasTarget): void {
		this.activeTarget = target;
	}

	public setDeviceLostCallbacks(callbacks: {
		onDeviceLost?: () => void;
		onDeviceRestored?: () => void;
		onDeviceRecoveryFailed?: () => void;
	}): void {
		this.onDeviceLost = callbacks.onDeviceLost ?? null;
		this.onDeviceRestored = callbacks.onDeviceRestored ?? null;
		this.onDeviceRecoveryFailed = callbacks.onDeviceRecoveryFailed ?? null;
	}

	public render(request: FrameRequest, uiState: UIOverlayState): void {
		if (!this.initialized || !this.activeTarget || !this.device) return;

		const td = this.targets.get(this.activeTarget.id);
		if (!td) return;

		const target = this.activeTarget;
		target.updateSize();

		td.canvasLayer.updateViewport(
			request.viewport,
			target.width,
			target.height,
		);
		td.uiLayer.updateViewport(request.viewport);

		const canvasTexture = td.context.getCurrentTexture();
		const textureView = canvasTexture.createView();

		const encoder = this.device.createCommandEncoder({
			label: "Frame Command Encoder",
		});

		this.profiler?.beginFrame();

		const frame = td.canvasLayer.render(
			encoder,
			textureView,
			canvasTexture,
			request,
			this.profiler,
		);

		try {
			td.uiLayer.render(
				encoder,
				textureView,
				uiState,
				request.document.artboards,
				canvasTexture.width,
				canvasTexture.height,
				this.profiler,
			);

			this.profiler?.resolve(encoder);
			this.device.queue.submit([encoder.finish()]);
			frame?.commit();
		} catch (error) {
			frame?.abort();
			throw error;
		}
		this.profiler?.readback();

		// Deferred texture destroys are handled by OffscreenPresenter.resetFrame()
		// at the start of the next frame, giving the GPU time to finish executing
		// the command buffer that may still reference them.
	}

	public getDevice(): GPUDevice | null {
		return this.device;
	}

	public getTextRenderer(): TextRenderer | null {
		return this.textRenderer;
	}

	/**
	 * Document access for text layout (axisBinding / flow chain resolution).
	 * Held here because TextRenderer is created lazily on device init.
	 */
	public setTextDocumentResolver(resolver: TextDocumentResolver | null): void {
		this.textDocumentResolver = resolver;
		this.textRenderer?.setDocumentResolver(resolver);
	}

	public setOnRequestRender(callback: () => void): void {
		this._onRequestRender = callback;
		for (const td of this.targets.values()) {
			td.canvasLayer.setOnRequestRender(callback);
		}
	}

	public setOnTextBoundsComputed(
		callback: (
			elementId: string,
			bounds: WorldBBox,
			localBounds: LocalBBox,
		) => void,
	): void {
		this._onTextBoundsComputed = callback;
		for (const td of this.targets.values()) {
			td.canvasLayer.setOnTextBoundsComputed(callback);
		}
	}

	/** Install the Reference3D subsystem accessor on all (and future) targets. */
	public setReference3DContextProvider(
		provider: () => Reference3DRenderContext | null,
	): void {
		this._reference3dContextProvider = provider;
		for (const td of this.targets.values()) {
			td.canvasLayer.setReference3DContextProvider(provider);
		}
	}

	/**
	 * Invalidate the document cache on all targets so the next render
	 * re-draws the document layer.  Does NOT clear boundsCache or
	 * geometryCache — use this for async resource loads (text paths,
	 * brush textures) that only affect visuals, not geometry.
	 */
	public invalidateDocumentCache(): void {
		for (const td of this.targets.values()) {
			td.canvasLayer.invalidateDocumentCache();
		}
	}

	/**
	 * Destroy every target's cache scope for `documentId` (GPU resources
	 * included). Call when a document leaves the engine for good: replacement
	 * (openDocument/loadYjsState) and after transient-document renders (brush
	 * preview), whose constant element ids would otherwise accumulate
	 * composite-key cache entries until scope-LRU eviction.
	 */
	public dropDocumentCaches(documentId: string): void {
		for (const td of this.targets.values()) {
			td.cacheManager.dropDocument(documentId);
		}
	}

	public invalidateTextCache(elementId?: string): void {
		for (const td of this.targets.values()) {
			td.canvasLayer.invalidateTextCache(elementId);
		}
		if (elementId) {
			this.textRenderer?.invalidateLayout(elementId);
		} else {
			this.textRenderer?.clearLayoutCache();
		}
	}

	/**
	 * Shared export rendering pipeline: renders document content to an
	 * rgba8unorm offscreen texture for CPU readback.
	 *
	 * Replaces the former ExportPresenter — all export-specific pre/post
	 * processing now lives here while the core rendering goes through
	 * the standard CanvasLayer.render() path.
	 */
	private async renderExportToTexture(opts: {
		label: string;
		centerX: number;
		centerY: number;
		worldWidth: number;
		worldHeight: number;
		scale: number;
		rotation?: number;
		backgroundColor: RawRGBA;
		document: Document;
		elementFilter?: ReadonlySet<string>;
		outputFormat?: "rgba8unorm" | "rgba32float";
		/** Changed-element set forwarded to the frame (tile invalidation tests);
		 *  production exports always re-render in full. */
		changedElements?: FrameRequest["changedElements"];
		/** Transient elements forwarded to the frame (tile bypass tests). */
		transientElements?: FrameRequest["transientElements"];
		/** Interaction flag forwarded to the frame (tile bake-budget tests). */
		interacting?: boolean;
		/** Paint artboard backgrounds despite the clearColorOverride background
		 *  (raster analysis renders where artboard edges act as barriers). */
		paintArtboardBackgrounds?: boolean;
	}): Promise<{ texture: GPUTexture; width: number; height: number } | null> {
		const td = this.activeTarget
			? this.targets.get(this.activeTarget.id)
			: null;
		if (!td || !this.device) {
			console.error("Renderer not initialized or no active target");
			return null;
		}
		const device = this.device;

		const width = Math.ceil(opts.worldWidth * opts.scale);
		const height = Math.ceil(opts.worldHeight * opts.scale);
		if (width <= 0 || height <= 0) return null;

		const maxDim = this.device.limits.maxTextureDimension2D;
		if (width > maxDim || height > maxDim) {
			console.error(
				`Export size ${width}×${height} exceeds GPU limit ${maxDim}`,
			);
			return null;
		}

		// Standalone callers (export, VRT) pass a bare Document with no owning
		// Paplico to wire flow-chain / axis-binding resolution — without one,
		// flow members and axis-bound texts render their own leftover content
		// literally instead of resolving the chain/binding. Fall back to a
		// document-derived resolver only when nothing is already wired, so a
		// live Paplico export keeps using its real (override-aware) resolver.
		const hadTextDocumentResolver = this.textDocumentResolver != null;
		if (!hadTextDocumentResolver) {
			this.setTextDocumentResolver(buildDocumentTextResolver(opts.document));
		}

		// 1. Pre-warm text paths (renderText is synchronous and skips uncached)
		const textElements = Object.values(opts.document.objects).filter(
			(el): el is TextElement => el.type === "text",
		);
		await Promise.all(
			textElements.map((el) => td.canvasLayer.elements.ensureTextPaths(el)),
		);
		await td.canvasLayer.elements.ensureImageTextures(
			opts.document,
			opts.elementFilter,
		);
		await td.canvasLayer.elements.ensureReference3DTextures(
			opts.document,
			opts.elementFilter,
		);

		// 2. Isolate deferred destroys from the main canvas frame
		const savedDeferredList =
			td.canvasLayer.offscreen.saveAndClearDeferredList();

		// 3. Save viewport
		const savedVp = td.canvasLayer.getViewportSnapshot();

		let intermediateTexture: GPUTexture | null = null;
		let outputTexture: GPUTexture | null = null;
		let frame: CanvasFrameTransaction | null = null;
		try {
			// 4. Set export viewport
			const exportViewport: Viewport = {
				x: opts.centerX,
				y: opts.centerY,
				zoom: opts.scale,
				rotation: opts.rotation ?? 0,
			};
			td.canvasLayer.updateViewport(exportViewport, width, height);

			const renderIntermediate = () => {
				const canvasFormat = td.canvasLayer.getCanvasFormat();
				const texture = device.createTexture({
					label: `${opts.label} Intermediate`,
					size: { width, height },
					format: canvasFormat,
					usage:
						GPUTextureUsage.RENDER_ATTACHMENT |
						GPUTextureUsage.TEXTURE_BINDING |
						GPUTextureUsage.COPY_SRC |
						GPUTextureUsage.COPY_DST,
				});
				intermediateTexture = texture;

				// 6. Render via CanvasLayer.render()
				const encoder = device.createCommandEncoder({
					label: `${opts.label} Encoder`,
				});
				const frame = td.canvasLayer.render(
					encoder,
					texture.createView(),
					texture,
					{
						viewport: exportViewport,
						document: opts.document,
						strategy: "full",
						disableViewportCulling: true,
						isExport: true,
						changedElements: opts.changedElements,
						transientElements: opts.transientElements,
						interacting: opts.interacting,
						elementFilter: opts.elementFilter,
						clearColorOverride: opts.backgroundColor,
						paintArtboardBackgrounds: opts.paintArtboardBackgrounds,
						hdrExposure: opts.document.hdr?.enabled
							? (opts.document.hdr.exposure ?? 0)
							: undefined,
					},
				);
				return { encoder, texture, frame };
			};

			// 5. Render after export resources are ready. Use a dedicated export
			// clip-mask atlas so this render never destroys the interactive
			// atlas's textures (shared-atlas use-after-destroy on document switch).
			const rendered = td.canvasLayer.withExportClipMaskAtlas(() =>
				renderIntermediate(),
			);
			const { encoder, texture } = rendered;
			frame = rendered.frame;

			// 6. Convert canvasFormat → output format
			const format = opts.outputFormat ?? "rgba8unorm";
			outputTexture = device.createTexture({
				label: `${opts.label} Output (${format})`,
				size: { width, height },
				format,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
			});
			if (format === "rgba32float") {
				td.canvasLayer.convertToRgba32Float(
					encoder,
					texture,
					outputTexture,
					opts.centerX,
					opts.centerY,
					opts.worldWidth,
					opts.worldHeight,
				);
			} else {
				td.canvasLayer.convertToRgba8unorm(
					encoder,
					texture,
					outputTexture,
					opts.centerX,
					opts.centerY,
					opts.worldWidth,
					opts.worldHeight,
				);
			}

			// 7. Submit and flush
			try {
				device.queue.submit([encoder.finish()]);
				frame?.commit();
			} catch (error) {
				frame?.abort();
				throw error;
			}
			td.canvasLayer.flushDeferredDestroys();

			return { texture: outputTexture, width, height };
		} catch (e) {
			frame?.abort();
			outputTexture?.destroy();
			throw e;
		} finally {
			// 9. Restore viewport and deferred list
			if (savedVp.viewport) {
				td.canvasLayer.updateViewport(
					savedVp.viewport,
					savedVp.width,
					savedVp.height,
				);
			}
			td.canvasLayer.markTransformsDirty();
			td.canvasLayer.offscreen.restoreDeferredList(savedDeferredList);
			const textureToDestroy = intermediateTexture as GPUTexture | null;
			textureToDestroy?.destroy();
			if (!hadTextDocumentResolver) {
				this.setTextDocumentResolver(null);
			}
		}
	}

	public async renderArtboardToTexture(
		artboard: Artboard,
		document: Document,
		scale = 1,
		backgroundColor: RawRGBA = { r: 1, g: 1, b: 1, a: 1 },
	): Promise<{ texture: GPUTexture; width: number; height: number } | null> {
		const bounds = getArtboardBounds(artboard);
		return this.renderExportToTexture({
			label: `Export: ${artboard.name}`,
			centerX: artboard.x,
			centerY: artboard.y,
			worldWidth: bounds.width,
			worldHeight: bounds.height,
			scale,
			backgroundColor,
			document,
		});
	}

	public async renderArtboardToImageData(
		artboard: Artboard,
		document: Document,
		scale = 1,
		backgroundColor: RawRGBA = { r: 1, g: 1, b: 1, a: 1 },
	): Promise<ImageData | null> {
		const result = await this.renderArtboardToTexture(
			artboard,
			document,
			scale,
			backgroundColor,
		);
		if (!result) return null;

		const { texture, width, height } = result;
		return this.readbackTexture(texture, width, height, true);
	}

	public async renderArtboardToFloat32(
		artboard: Artboard,
		document: Document,
		scale = 1,
		backgroundColor: RawRGBA = { r: 1, g: 1, b: 1, a: 1 },
	): Promise<{ pixels: Float32Array; width: number; height: number } | null> {
		const bounds = getArtboardBounds(artboard);
		const result = await this.renderExportToTexture({
			label: `HDR Export: ${artboard.name}`,
			centerX: artboard.x,
			centerY: artboard.y,
			worldWidth: bounds.width,
			worldHeight: bounds.height,
			scale,
			backgroundColor,
			document,
			outputFormat: "rgba32float",
		});
		if (!result) return null;

		const { texture, width, height } = result;
		return this.readbackTextureFloat32(texture, width, height);
	}

	/** Read GPU texture pixels into ImageData, optionally un-premultiplying alpha. */
	private async readbackTexture(
		texture: GPUTexture,
		width: number,
		height: number,
		unpremultiply: boolean,
	): Promise<ImageData | null> {
		const device = this.device;
		if (!device) {
			texture.destroy();
			return null;
		}

		const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
		const readBuffer = device.createBuffer({
			size: bytesPerRow * height,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});

		const cmdEncoder = device.createCommandEncoder();
		cmdEncoder.copyTextureToBuffer(
			{ texture },
			{ buffer: readBuffer, bytesPerRow },
			{ width, height },
		);
		device.queue.submit([cmdEncoder.finish()]);

		await device.queue.onSubmittedWorkDone();
		await readBuffer.mapAsync(GPUMapMode.READ);
		const data = new Uint8ClampedArray(readBuffer.getMappedRange().slice(0));
		readBuffer.unmap();

		const pixels = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			const src = y * bytesPerRow;
			const dst = y * width * 4;
			pixels.set(data.subarray(src, src + width * 4), dst);
		}

		if (unpremultiply) {
			for (let i = 0; i < pixels.length; i += 4) {
				const a = pixels[i + 3];
				if (a > 0 && a < 255) {
					const inv = 255 / a;
					pixels[i] = Math.min(255, Math.round(pixels[i] * inv));
					pixels[i + 1] = Math.min(255, Math.round(pixels[i + 1] * inv));
					pixels[i + 2] = Math.min(255, Math.round(pixels[i + 2] * inv));
				}
			}
		}

		texture.destroy();
		readBuffer.destroy();
		return new ImageData(pixels, width, height);
	}

	/** Read GPU texture pixels as Float32Array for HDR export. */
	private async readbackTextureFloat32(
		texture: GPUTexture,
		width: number,
		height: number,
	): Promise<{ pixels: Float32Array; width: number; height: number } | null> {
		const device = this.device;
		if (!device) {
			texture.destroy();
			return null;
		}

		const bytesPerPixel = 16; // 4 channels x 4 bytes (float32)
		const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
		const readBuffer = device.createBuffer({
			size: bytesPerRow * height,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});

		const cmdEncoder = device.createCommandEncoder();
		cmdEncoder.copyTextureToBuffer(
			{ texture },
			{ buffer: readBuffer, bytesPerRow },
			{ width, height },
		);
		device.queue.submit([cmdEncoder.finish()]);

		let mapped = false;
		try {
			await device.queue.onSubmittedWorkDone();
			await readBuffer.mapAsync(GPUMapMode.READ);
			mapped = true;

			const floatsPerRow = width * 4;
			const paddedFloatsPerRow = bytesPerRow / 4;
			const pixels = new Float32Array(width * height * 4);
			const rawView = new Float32Array(readBuffer.getMappedRange());
			for (let y = 0; y < height; y++) {
				pixels.set(
					rawView.subarray(
						y * paddedFloatsPerRow,
						y * paddedFloatsPerRow + floatsPerRow,
					),
					y * floatsPerRow,
				);
			}

			// Un-premultiply alpha
			for (let i = 0; i < pixels.length; i += 4) {
				const a = pixels[i + 3];
				if (a > 0 && a < 1) {
					const inv = 1 / a;
					pixels[i] *= inv;
					pixels[i + 1] *= inv;
					pixels[i + 2] *= inv;
				}
			}

			return { pixels, width, height };
		} finally {
			if (mapped) {
				try {
					readBuffer.unmap();
				} catch {
					// ignore unmap errors during cleanup
				}
			}
			readBuffer.destroy();
			texture.destroy();
		}
	}

	public async renderViewportToImageData(
		viewport: Viewport,
		document: Document,
		canvasWidth: number,
		canvasHeight: number,
	): Promise<ImageData | null> {
		const result = await this.renderExportToTexture({
			label: "BucketFill Viewport",
			centerX: viewport.x,
			centerY: viewport.y,
			worldWidth: canvasWidth / viewport.zoom,
			worldHeight: canvasHeight / viewport.zoom,
			scale: viewport.zoom,
			rotation: viewport.rotation ?? 0,
			backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
			document,
		});
		if (!result) return null;

		const { texture, width, height } = result;
		return this.readbackTexture(texture, width, height, false);
	}

	/**
	 * Render an axis-aligned world region to ImageData for raster analysis
	 * (bucket fill). Rotation-free, transparent background; artboard
	 * backgrounds are painted on request so their edges act as color barriers.
	 */
	public async renderWorldRegionToImageData(
		region: {
			centerX: number;
			centerY: number;
			worldWidth: number;
			worldHeight: number;
		},
		scale: number,
		document: Document,
		opts?: { paintArtboardBackgrounds?: boolean },
	): Promise<ImageData | null> {
		const result = await this.renderExportToTexture({
			label: "BucketFill WorldRegion",
			centerX: region.centerX,
			centerY: region.centerY,
			worldWidth: region.worldWidth,
			worldHeight: region.worldHeight,
			scale,
			backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
			document,
			paintArtboardBackgrounds: opts?.paintArtboardBackgrounds,
		});
		if (!result) return null;

		const { texture, width, height } = result;
		return this.readbackTexture(texture, width, height, false);
	}

	/**
	 * Union of the renderable document content bounds: every layer's top-level
	 * elements (subtree + filter reach via computeElementsExportBounds) plus
	 * artboard rectangles. Layer element lists are used instead of
	 * document.objects so off-canvas defs (pattern sources, …) don't inflate
	 * the result. Returns null when the document has no renderable content.
	 */
	public computeDocumentContentBounds(document: Document): {
		centerX: number;
		centerY: number;
		width: number;
		height: number;
	} | null {
		const topLevelIds = document.layers.flatMap((l) => l.elementIds);
		const content = this.computeElementsExportBounds(topLevelIds, document);

		let minX = content ? content.centerX - content.width / 2 : Infinity;
		let minY = content ? content.centerY - content.height / 2 : Infinity;
		let maxX = content ? content.centerX + content.width / 2 : -Infinity;
		let maxY = content ? content.centerY + content.height / 2 : -Infinity;

		for (const artboard of document.artboards) {
			const b = getArtboardBounds(artboard);
			if (b.minX < minX) minX = b.minX;
			if (b.minY < minY) minY = b.minY;
			if (b.maxX > maxX) maxX = b.maxX;
			if (b.maxY > maxY) maxY = b.maxY;
		}

		if (!Number.isFinite(minX)) return null;
		return {
			centerX: (minX + maxX) / 2,
			centerY: (minY + maxY) / 2,
			width: maxX - minX,
			height: maxY - minY,
		};
	}

	/** Device texture-size limit for sizing analysis rasters (4096 before init). */
	public getMaxTextureDimension(): number {
		return this.device?.limits.maxTextureDimension2D ?? 4096;
	}

	/**
	 * World-space bounds for an element-subtree export (copy / element PNG),
	 * expanded to include post-process filter reach (blur / drop-shadow / glow /
	 * extrude) so the halo is not clipped. `elementIds` are the top-level
	 * selection; the subtree is expanded so a child's or group's filter reach is
	 * covered too. Returns null when nothing is renderable.
	 */
	public computeElementsExportBounds(
		elementIds: readonly string[],
		document: Document,
	): {
		centerX: number;
		centerY: number;
		width: number;
		height: number;
	} | null {
		const elementsMap = new Map(Object.entries(document.objects));
		const ids = expandRenderFilter(new Set(elementIds), elementsMap);

		const elements = [...ids]
			.map((id) => elementsMap.get(id))
			.filter((el): el is AnyArtObject => el != null);
		if (elements.length === 0) return null;

		// filterRenderer is the same instance CanvasLayer uses; when the renderer
		// is not initialized yet, fall back to geometry bounds (legacy behavior).
		const plans = this.filterRenderer
			? buildFilterPlansForElements(elements, elementsMap, this.filterRenderer)
			: null;

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const el of elements) {
			// textureBounds already includes this element's post-process reach;
			// otherwise use the pre-filtered bounds so geometry pre-filters that
			// deform the shape (3d-rotate, zigzag, …) are not clipped to the flat
			// outline. calculatePreFilteredElementBounds returns plain geometry
			// bounds when the element has no pre-filter.
			const b =
				plans?.get(el.id)?.textureBounds ??
				(this.filterRenderer
					? calculatePreFilteredElementBounds(
							el,
							elementsMap,
							this.filterRenderer,
						)
					: calculateElementBounds(el, elementsMap));
			if (b.minX < minX) minX = b.minX;
			if (b.minY < minY) minY = b.minY;
			if (b.maxX > maxX) maxX = b.maxX;
			if (b.maxY > maxY) maxY = b.maxY;
		}

		if (!Number.isFinite(minX)) return null;
		const width = maxX - minX;
		const height = maxY - minY;
		if (width <= 0 || height <= 0) return null;

		return {
			centerX: (minX + maxX) / 2,
			centerY: (minY + maxY) / 2,
			width,
			height,
		};
	}

	public async renderElementsToImageData(
		elementIds: string[],
		document: Document,
		bounds: {
			centerX: number;
			centerY: number;
			width: number;
			height: number;
		},
		scale = 1,
		backgroundColor: RawRGBA = { r: 0, g: 0, b: 0, a: 0 },
	): Promise<ImageData | null> {
		const result = await this.renderExportToTexture({
			label: "Clipboard Export",
			centerX: bounds.centerX,
			centerY: bounds.centerY,
			worldWidth: bounds.width,
			worldHeight: bounds.height,
			scale,
			backgroundColor,
			document,
			elementFilter: new Set(elementIds),
		});
		if (!result) return null;

		const { texture, width, height } = result;
		return this.readbackTexture(texture, width, height, true);
	}

	/**
	 * Render a viewport to an rgba8unorm texture (for visual regression tests
	 * and other consumers that need a GPU texture rather than ImageData).
	 */
	public async renderViewportToTexture(
		viewport: Viewport,
		document: Document,
		canvasWidth: number,
		canvasHeight: number,
		backgroundColor: RawRGBA = { r: 1, g: 1, b: 1, a: 1 },
		changedElements?: FrameRequest["changedElements"],
		transientElements?: FrameRequest["transientElements"],
		interacting?: boolean,
	): Promise<GPUTexture | null> {
		const result = await this.renderExportToTexture({
			label: "Viewport Render",
			centerX: viewport.x,
			centerY: viewport.y,
			worldWidth: canvasWidth / viewport.zoom,
			worldHeight: canvasHeight / viewport.zoom,
			scale: viewport.zoom,
			rotation: viewport.rotation ?? 0,
			backgroundColor,
			document,
			changedElements,
			transientElements,
			interacting,
		});
		return result?.texture ?? null;
	}

	/**
	 * Render only the UI overlay (UILayer) over a transparent background to an
	 * rgba8unorm texture (for visual regression tests of UI overlay rendering).
	 * The document layer is not rendered.
	 */
	public renderUIOverlayToTexture(
		viewport: Viewport,
		uiState: UIOverlayState,
		artboards: Artboard[] | null,
		canvasWidth: number,
		canvasHeight: number,
	): GPUTexture | null {
		const td = this.activeTarget
			? this.targets.get(this.activeTarget.id)
			: null;
		if (!td || !this.device) {
			console.error("Renderer not initialized or no active target");
			return null;
		}
		const device = this.device;

		const savedVp = td.canvasLayer.getViewportSnapshot();

		let intermediateTexture: GPUTexture | null = null;
		let outputTexture: GPUTexture | null = null;
		try {
			td.canvasLayer.updateViewport(viewport, canvasWidth, canvasHeight);
			td.uiLayer.updateViewport(viewport);

			intermediateTexture = device.createTexture({
				label: "UI Overlay Intermediate",
				size: { width: canvasWidth, height: canvasHeight },
				format: td.canvasLayer.getCanvasFormat(),
				usage:
					GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});

			const encoder = device.createCommandEncoder({
				label: "UI Overlay Encoder",
			});

			// Clear to transparent — UILayer's blit pass loads existing content.
			const clearPass = encoder.beginRenderPass({
				label: "UI Overlay Clear Pass",
				colorAttachments: [
					{
						view: intermediateTexture.createView(),
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: "clear",
						storeOp: "store",
					},
				],
			});
			clearPass.end();

			td.uiLayer.render(
				encoder,
				intermediateTexture.createView(),
				uiState,
				artboards,
				canvasWidth,
				canvasHeight,
			);

			outputTexture = device.createTexture({
				label: "UI Overlay Output (rgba8unorm)",
				size: { width: canvasWidth, height: canvasHeight },
				format: "rgba8unorm",
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
			});
			td.canvasLayer.convertToRgba8unorm(
				encoder,
				intermediateTexture,
				outputTexture,
				viewport.x,
				viewport.y,
				canvasWidth / viewport.zoom,
				canvasHeight / viewport.zoom,
			);

			device.queue.submit([encoder.finish()]);
			return outputTexture;
		} catch (e) {
			outputTexture?.destroy();
			throw e;
		} finally {
			if (savedVp.viewport) {
				td.canvasLayer.updateViewport(
					savedVp.viewport,
					savedVp.width,
					savedVp.height,
				);
				td.uiLayer.updateViewport(savedVp.viewport);
			}
			intermediateTexture?.destroy();
		}
	}

	public scaleFilters(
		filters: Filter[],
		scaleX: number,
		scaleY: number,
	): Filter[] {
		if (!this.filterRenderer) return filters;
		return filters
			.map((f) => this.filterRenderer?.scaleFilter(f, scaleX, scaleY))
			.filter((f): f is Filter => f !== undefined);
	}

	public getFilterHandler(processor: string): FilterHandler | undefined {
		return this.filterRenderer?.getHandler(processor);
	}

	/** Whether the common Appearance.applyToBackdrop toggle is meaningful for
	 *  this filter (see FilterRenderer.canApplyToBackdrop). False until the
	 *  GPU device and filter handlers are initialized. */
	public canApplyFilterToBackdrop(filter: Filter): boolean {
		return this.filterRenderer?.canApplyToBackdrop(filter) ?? false;
	}

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;

		if (this.recoveryTimer !== null) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
		}

		this.releaseGPUResources();
		this.registeredTargets.clear();
	}

	// --- Private methods ---

	private handleDeviceLost(device: GPUDevice, info: GPUDeviceLostInfo): void {
		this.disposedDevices.add(device);
		if (this.device !== device) return;

		console.error(
			`WebGPU device lost (reason: ${info.reason}): ${info.message}`,
		);

		this.initialized = false;
		this.onDeviceLost?.();

		if (this.destroyed) return;
		if (info.reason === "destroyed") return;

		this.scheduleRecovery();
	}

	private scheduleRecovery(): void {
		if (this.destroyed) return;
		if (this.recoveryAttempt >= RenderOrchestrator.MAX_RECOVERY_ATTEMPTS) {
			console.error(
				`WebGPU recovery failed after ${this.recoveryAttempt} attempts. Giving up.`,
			);
			this.onDeviceRecoveryFailed?.();
			return;
		}

		const delay =
			RenderOrchestrator.BASE_RECOVERY_DELAY_MS * 2 ** this.recoveryAttempt;
		this.recoveryAttempt++;

		console.log(
			`WebGPU recovery attempt ${this.recoveryAttempt}/${RenderOrchestrator.MAX_RECOVERY_ATTEMPTS} in ${delay}ms`,
		);

		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = null;
			this.attemptRecovery();
		}, delay);
	}

	private async attemptRecovery(): Promise<void> {
		if (this.destroyed) return;
		if (this.#pendingDeviceReInit) {
			const success = await this.#pendingDeviceReInit;
			if (success) {
				this.onDeviceRestored?.();
				return;
			}
		}

		this.releaseGPUResources();

		this.#pendingDeviceReInit = this.initDevice();
		const success = await this.#pendingDeviceReInit;
		this.#pendingDeviceReInit = null;
		if (success) {
			for (const target of this.registeredTargets) {
				await this.initCanvasTarget(target);
			}
			console.log("WebGPU device recovered successfully");
			this.onDeviceRestored?.();
		} else {
			console.warn("WebGPU recovery attempt failed");
			this.scheduleRecovery();
		}
	}

	private releaseGPUResources(): void {
		const device = this.device;
		this.device = null;
		this.initialized = false;

		for (const td of this.targets.values()) {
			td.canvasLayer.elements.destroyReference3DTextures();
			td.canvasLayer.destroy();
			td.strokeRegistry.destroy();
			td.uniformBuffer.destroy();
			td.uiLayer.destroy();
		}
		this.targets.clear();

		this.activeTarget = null;
		this.pipelines = null;
		this.layouts = null;
		this.bindGroupLayout = null;
		this.transformsBindGroupLayout = null;
		this.sampler = null;
		this.nearestSampler = null;
		this.viewportShaderDefs = null;
		this.gradientShaderCompiled = null;
		this.profiler?.destroy();
		this.profiler = null;
		this.filterRenderer?.destroy();
		this.filterRenderer = null;
		this.brushTextureManager?.destroy();
		this.brushTextureManager = null;
		this.gradientTextureGenerator = null;
		this.meshGradientTextureGenerator = null;
		this.textRenderer = null;

		if (device && !this.disposedDevices.has(device)) {
			this.disposedDevices.add(device);
			device.destroy();
		}
	}

	private async createSharedResources(): Promise<void> {
		if (!this.device) return;

		const gradientCompiled = compileShaderModule(this.device, {
			label: "Gradient Fill Shader",
			code: GRADIENT_FILL_SHADER,
		});
		this.gradientShaderCompiled = {
			module: gradientCompiled.module,
			uniformViews: gradientCompiled.uniformViews,
			storageViews: gradientCompiled.storageViews,
		};

		this.bindGroupLayout = this.device.createBindGroupLayout({
			label: "Shared Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
			],
		});

		this.transformsBindGroupLayout = this.device.createBindGroupLayout({
			label: "Transforms Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: "read-only-storage" },
				},
			],
		});

		this.sampler = this.device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		this.nearestSampler = this.device.createSampler({
			magFilter: "nearest",
			minFilter: "nearest",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
	}

	private async initPipelinesAndSharedSystems(): Promise<void> {
		if (
			!this.device ||
			!this.bindGroupLayout ||
			!this.sampler ||
			!this.gradientShaderCompiled
		) {
			return;
		}

		const { module: blitShaderModule } = compileShaderModule(this.device, {
			label: "Blit Shader",
			code: BLIT_SHADER,
		});
		const { module: compositeShaderModule } = compileShaderModule(this.device, {
			label: "Composite Shader",
			code: COMPOSITE_SHADER,
		});

		const bindGroupLayout = this.bindGroupLayout;
		const transformsBindGroupLayout = this.transformsBindGroupLayout!;

		const strokeVertexBufferLayout: GPUVertexBufferLayout = {
			arrayStride: UNIFIED_VERTEX_BYTES,
			attributes: [
				{
					shaderLocation: 0,
					offset: UNIFIED_VERTEX_OFFSETS.position * 4,
					format: "float32x2",
				},
				{
					shaderLocation: 1,
					offset: UNIFIED_VERTEX_OFFSETS.color * 4,
					format: "float32x4",
				},
				{
					shaderLocation: 2,
					offset: UNIFIED_VERTEX_OFFSETS.offset * 4,
					format: "float32x2",
				},
				{
					shaderLocation: 3,
					offset: UNIFIED_VERTEX_OFFSETS.elementIndex * 4,
					format: "uint32",
				},
			],
		};

		const premultipliedBlend: GPUBlendState = {
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
		};

		const noopStencil: GPUDepthStencilState = {
			format: "depth24plus-stencil8",
			depthWriteEnabled: false,
			depthCompare: "always",
			stencilFront: {
				compare: "always",
				passOp: "keep",
				failOp: "keep",
				depthFailOp: "keep",
			},
			stencilBack: {
				compare: "always",
				passOp: "keep",
				failOp: "keep",
				depthFailOp: "keep",
			},
			stencilWriteMask: 0x00,
			stencilReadMask: 0x00,
		};

		const gradientBindGroupLayout = this.device.createBindGroupLayout({
			label: "Gradient Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: {},
				},
				{
					binding: 4,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 5,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 6,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
			],
		});

		const maskBindGroupLayout = this.device.createBindGroupLayout({
			label: "Mask Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {
						sampleType: "float",
						viewDimension: "2d",
					},
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: {},
				},
			],
		});

		const unifiedLayout = this.device.createPipelineLayout({
			bindGroupLayouts: [
				bindGroupLayout,
				transformsBindGroupLayout,
				gradientBindGroupLayout,
				maskBindGroupLayout,
			],
		});

		const unifiedCompiled = compileShaderModule(this.device, {
			label: "Unified Geometry Shader",
			code: UNIFIED_GEOMETRY_SHADER,
		});
		const unifiedShaderModule = unifiedCompiled.module;
		this.viewportShaderDefs = unifiedCompiled.definitions;

		const baseUnified: Omit<
			Parameters<typeof createGeometryPipeline>[0],
			"label" | "targetFormat"
		> = {
			device: this.device,
			shaderModule: unifiedShaderModule,
			vertexBufferLayout: strokeVertexBufferLayout,
			pipelineLayout: unifiedLayout,
			blend: premultipliedBlend,
			topology: "triangle-list",
		};

		const unifiedGeometryPipeline = createGeometryPipeline({
			...baseUnified,
			label: "Unified Geometry Pipeline",
			targetFormat: this.canvasFormat,
			depthStencil: noopStencil,
		});
		// Stencil-Then-Cover fill pipelines
		const fanWriteStencil: GPUDepthStencilState = {
			format: "depth24plus-stencil8",
			depthWriteEnabled: false,
			depthCompare: "always",
			stencilFront: {
				compare: "always",
				passOp: "increment-wrap",
				failOp: "keep",
				depthFailOp: "keep",
			},
			stencilBack: {
				compare: "always",
				passOp: "decrement-wrap",
				failOp: "keep",
				depthFailOp: "keep",
			},
			stencilWriteMask: 0xff,
			stencilReadMask: 0x00,
		};
		const stencilFanWritePipeline = createGeometryPipeline({
			...baseUnified,
			label: "Stencil Fan Write Pipeline",
			targetFormat: this.canvasFormat,
			blend: undefined,
			colorWriteMask: 0,
			depthStencil: fanWriteStencil,
		});
		const stencilCoverPipeline = createGeometryPipeline({
			...baseUnified,
			label: "Stencil Cover Pipeline",
			targetFormat: this.canvasFormat,
			depthStencil: {
				format: "depth24plus-stencil8",
				depthWriteEnabled: false,
				depthCompare: "always",
				stencilFront: {
					compare: "not-equal",
					passOp: "zero",
					failOp: "keep",
					depthFailOp: "keep",
				},
				stencilBack: {
					compare: "not-equal",
					passOp: "zero",
					failOp: "keep",
					depthFailOp: "keep",
				},
				stencilWriteMask: 0xff,
				stencilReadMask: 0xff,
			},
		});

		// Semi-transparent stroke pipelines. A stroke tessellation overlaps
		// itself at every join and self-intersection, so blending it in one pass
		// composites those pixels twice and they come out darker. "First
		// fragment wins" keeps the union: the stencil starts at 0 (the shared
		// invariant — everyone zeroes after themselves), so only the first
		// fragment to reach a pixel passes `equal`, and its increment locks the
		// pixel for the rest of the draw. The reference value stays 0, so no
		// setStencilReference is needed anywhere.
		const firstWinsStencilFace: GPUStencilFaceState = {
			compare: "equal",
			passOp: "increment-clamp",
			failOp: "keep",
			depthFailOp: "keep",
		};
		const strokeUnionPipeline = createGeometryPipeline({
			...baseUnified,
			label: "Stroke Union Pipeline",
			targetFormat: this.canvasFormat,
			depthStencil: {
				format: "depth24plus-stencil8",
				depthWriteEnabled: false,
				depthCompare: "always",
				stencilFront: firstWinsStencilFace,
				stencilBack: firstWinsStencilFace,
				stencilWriteMask: 0xff,
				stencilReadMask: 0xff,
			},
		});
		// Restores the invariant by re-drawing the same geometry with color
		// writes off — exact down to the AA fringe, which a bounding-box quad
		// would leave behind.
		const zeroStencilFace: GPUStencilFaceState = {
			compare: "always",
			passOp: "zero",
			failOp: "keep",
			depthFailOp: "keep",
		};
		const stencilZeroPipeline = createGeometryPipeline({
			...baseUnified,
			label: "Stencil Zero Pipeline",
			targetFormat: this.canvasFormat,
			blend: undefined,
			colorWriteMask: 0,
			depthStencil: {
				format: "depth24plus-stencil8",
				depthWriteEnabled: false,
				depthCompare: "always",
				stencilFront: zeroStencilFace,
				stencilBack: zeroStencilFace,
				stencilWriteMask: 0xff,
				stencilReadMask: 0xff,
			},
		});

		// Vertex-pulling variants: no vertex buffer — the RunBatcher's merged
		// solid runs pull unified vertices from the GeometryStore bound as
		// storage at BG2 (repurposed from the gradient group; solid geometry
		// never samples gradients). See unifiedPulled.wgsl.ts.
		const pulledBindGroupLayout = this.device.createBindGroupLayout({
			label: "Pulled Geometry Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: "read-only-storage" },
				},
			],
		});
		const pulledLayout = this.device.createPipelineLayout({
			bindGroupLayouts: [
				bindGroupLayout,
				transformsBindGroupLayout,
				pulledBindGroupLayout,
				maskBindGroupLayout,
			],
		});
		const { module: pulledShaderModule } = compileShaderModule(this.device, {
			label: "Unified Pulled Geometry Shader",
			code: UNIFIED_PULLED_GEOMETRY_SHADER,
		});
		const basePulled = {
			device: this.device,
			shaderModule: pulledShaderModule,
			pipelineLayout: pulledLayout,
			blend: premultipliedBlend,
			topology: "triangle-list" as const,
		};
		const pulledGeometryPipeline = createGeometryPipeline({
			...basePulled,
			label: "Pulled Geometry Pipeline",
			targetFormat: this.canvasFormat,
			depthStencil: noopStencil,
		});
		const pulledStencilFanWritePipeline = createGeometryPipeline({
			...basePulled,
			label: "Pulled Stencil Fan Write Pipeline",
			targetFormat: this.canvasFormat,
			blend: undefined,
			colorWriteMask: 0,
			depthStencil: fanWriteStencil,
		});

		// Dummy gradient bind group (gradientType=0 → solid fill, fragment uses vertex color)
		const dummyGradientUniformBuffer = this.device.createBuffer({
			label: "Dummy Gradient Uniform",
			size: this.gradientShaderCompiled.uniformViews.gradient.arrayBuffer
				.byteLength,
			usage: GPUBufferUsage.UNIFORM,
		});
		const dummyGradientStopsBuffer = this.device.createBuffer({
			label: "Dummy Gradient Stops",
			size: 32, // minimum storage buffer size
			usage: GPUBufferUsage.STORAGE,
		});
		const dummyGradientStorageBuffer = this.device.createBuffer({
			label: "Dummy Gradient Storage",
			size: 256,
			usage: GPUBufferUsage.STORAGE,
		});
		const dummyGradientTexture = this.device.createTexture({
			label: "Dummy Gradient Texture",
			size: { width: 1, height: 1 },
			format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING,
		});
		const dummyGradientBindGroup = this.device.createBindGroup({
			label: "Dummy Gradient Bind Group",
			layout: gradientBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: dummyGradientUniformBuffer } },
				{ binding: 1, resource: { buffer: dummyGradientStopsBuffer } },
				{ binding: 2, resource: dummyGradientTexture.createView() },
				{ binding: 3, resource: this.sampler },
				{ binding: 4, resource: { buffer: dummyGradientStorageBuffer } },
				{ binding: 5, resource: { buffer: dummyGradientStorageBuffer } },
				{ binding: 6, resource: { buffer: dummyGradientStorageBuffer } },
			],
		});

		// Dummy mask bind group: 1x1 white texture_2d — all elements pass through
		const dummyMaskTexture = this.device.createTexture({
			label: "Dummy Mask Texture",
			size: { width: 1, height: 1 },
			format: "r8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		this.device.queue.writeTexture(
			{ texture: dummyMaskTexture },
			new Uint8Array([255]),
			{ bytesPerRow: 1 },
			{ width: 1, height: 1 },
		);
		const dummyMaskBindGroup = this.device.createBindGroup({
			label: "Dummy Mask Bind Group",
			layout: maskBindGroupLayout,
			entries: [
				{
					binding: 0,
					resource: dummyMaskTexture.createView(),
				},
				{ binding: 1, resource: this.sampler },
			],
		});

		const blitBindGroupLayout = this.device.createBindGroupLayout({
			label: "Blit Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: {},
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {},
				},
			],
		});

		const blitPipelineLayout = this.device.createPipelineLayout({
			bindGroupLayouts: [bindGroupLayout, blitBindGroupLayout],
		});
		const baseBlit: Omit<
			Parameters<typeof createFullscreenPipeline>[0],
			"label"
		> = {
			device: this.device,
			shaderModule: blitShaderModule,
			pipelineLayout: blitPipelineLayout,
			targetFormat: this.canvasFormat,
			blend: premultipliedBlend,
		};

		const blitPipeline = createFullscreenPipeline({
			...baseBlit,
			label: "Blit Pipeline",
			depthStencil: noopStencil,
		});
		const blitPipelineRgba8 = createFullscreenPipeline({
			...baseBlit,
			label: "Blit Pipeline (RGBA8, Single Sample)",
			targetFormat: "rgba8unorm",
			multisampleCount: 1,
		});
		const blitPipelineRgba32Float = createFullscreenPipeline({
			...baseBlit,
			label: "Blit Pipeline (RGBA32Float, Single Sample)",
			targetFormat: "rgba32float",
			multisampleCount: 1,
			blend: undefined,
		});

		// --- Quad blit pipeline (4-corner warp for image preProcess filters) ---
		const { module: quadBlitShaderModule } = compileShaderModule(this.device, {
			label: "Quad Blit Shader",
			code: QUAD_BLIT_SHADER,
		});
		const quadBlitPipeline = createFullscreenPipeline({
			...baseBlit,
			label: "Quad Blit Pipeline",
			shaderModule: quadBlitShaderModule,
			depthStencil: noopStencil,
		});

		// --- Mesh blit pipeline (tessellated texture warp for mesh containers) ---
		// The only blit pipeline with a real vertex buffer: the mesh warp bakes
		// per-vertex world positions on the CPU, so createFullscreenPipeline's
		// vertexless setup doesn't apply.
		const { module: meshBlitShaderModule } = compileShaderModule(this.device, {
			label: "Mesh Blit Shader",
			code: MESH_BLIT_SHADER,
		});
		const meshBlitPipeline = this.device.createRenderPipeline({
			label: "Mesh Blit Pipeline",
			layout: blitPipelineLayout,
			vertex: {
				module: meshBlitShaderModule,
				entryPoint: "vertexMain",
				buffers: [
					{
						arrayStride: 16,
						attributes: [
							{ shaderLocation: 0, offset: 0, format: "float32x2" },
							{ shaderLocation: 1, offset: 8, format: "float32x2" },
						],
					},
				],
			},
			fragment: {
				module: meshBlitShaderModule,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat, blend: premultipliedBlend }],
			},
			primitive: { topology: "triangle-list" },
			depthStencil: noopStencil,
			multisample: { count: RENDER_SAMPLE_COUNT },
		});

		// --- Exposure blit pipeline ---
		const exposureBlitBindGroupLayout = this.device.createBindGroupLayout({
			label: "Exposure Blit Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "non-filtering" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "unfilterable-float" },
				},
			],
		});
		const exposureBlitShaderModule = this.device.createShaderModule({
			label: "Exposure Blit Shader",
			code: EXPOSURE_BLIT_SHADER,
		});
		const exposureBlitPipeline = this.device.createRenderPipeline({
			label: "Exposure Blit Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [exposureBlitBindGroupLayout],
			}),
			vertex: {
				module: exposureBlitShaderModule,
				entryPoint: "vertexMain",
			},
			fragment: {
				module: exposureBlitShaderModule,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		const compositeBindGroupLayout = this.device.createBindGroupLayout({
			label: "Composite Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: {},
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {},
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {},
				},
				{
					binding: 4,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {},
				},
			],
		});

		const compositeBaseOpts = {
			device: this.device,
			shaderModule: compositeShaderModule,
			pipelineLayout: this.device.createPipelineLayout({
				bindGroupLayouts: [bindGroupLayout, compositeBindGroupLayout],
			}),
			blend: {
				color: {
					srcFactor: "one" as const,
					dstFactor: "zero" as const,
					operation: "add" as const,
				},
				alpha: {
					srcFactor: "one" as const,
					dstFactor: "zero" as const,
					operation: "add" as const,
				},
			},
		};

		const compositePipeline = createFullscreenPipeline({
			...compositeBaseOpts,
			label: "Composite Pipeline",
			targetFormat: this.canvasFormat,
			depthStencil: noopStencil,
		});

		// Blit-with-mask bind group layout: same as blit but adds a mask texture
		const blitWithMaskBindGroupLayout = this.device.createBindGroupLayout({
			label: "Blit With Mask Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: {},
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {},
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {},
				},
			],
		});

		const blitWithMaskPipelineLayout = this.device.createPipelineLayout({
			bindGroupLayouts: [
				bindGroupLayout,
				blitWithMaskBindGroupLayout,
				maskBindGroupLayout,
			],
		});

		const { module: blitWithMaskShaderModule } = compileShaderModule(
			this.device,
			{ label: "Blit With Mask Shader", code: BLIT_WITH_MASK_SHADER },
		);

		const blitWithMaskPipeline = createFullscreenPipeline({
			device: this.device,
			label: "Blit With Mask Pipeline",
			shaderModule: blitWithMaskShaderModule,
			pipelineLayout: blitWithMaskPipelineLayout,
			targetFormat: this.canvasFormat,
			blend: premultipliedBlend,
			depthStencil: noopStencil,
		});

		// Glass punch: destination scale-down before the glass intermediate
		// blit, so the following src-over lands on a (1 - coverage·opacity)
		// destination weight — replace within the solid, plain over outside.
		const { module: blitGlassPunchShaderModule } = compileShaderModule(
			this.device,
			{ label: "Blit Glass Punch Shader", code: BLIT_GLASS_PUNCH_SHADER },
		);

		const blitGlassPunchPipeline = createFullscreenPipeline({
			device: this.device,
			label: "Blit Glass Punch Pipeline",
			shaderModule: blitGlassPunchShaderModule,
			pipelineLayout: this.device.createPipelineLayout({
				bindGroupLayouts: [bindGroupLayout, blitWithMaskBindGroupLayout],
			}),
			targetFormat: this.canvasFormat,
			blend: {
				color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
				alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
			},
			depthStencil: noopStencil,
		});

		const { module: blitWithEraseMaskShaderModule } = compileShaderModule(
			this.device,
			{
				label: "Blit With Erase Mask Shader",
				code: BLIT_WITH_ERASE_MASK_SHADER,
			},
		);

		const blitWithEraseMaskPipeline = createFullscreenPipeline({
			device: this.device,
			label: "Blit With Erase Mask Pipeline",
			shaderModule: blitWithEraseMaskShaderModule,
			pipelineLayout: blitWithMaskPipelineLayout,
			targetFormat: this.canvasFormat,
			blend: premultipliedBlend,
			depthStencil: noopStencil,
		});

		const { module: blitBackdropWithMaskShaderModule } = compileShaderModule(
			this.device,
			{
				label: "Blit Backdrop With Mask Shader",
				code: BLIT_BACKDROP_WITH_MASK_SHADER,
			},
		);

		// Backdrop composite is a two-draw replace: the punch draw scales the
		// destination by (1 - mask·opacity), then the additive draw adds the
		// filtered backdrop. Keying src-over on the filtered alpha instead
		// would leave the sharp backdrop visible under blur-softened alpha
		// edges when the background is transparent (e.g. transparent PNG
		// export).
		const blitBackdropPunchPipeline = createFullscreenPipeline({
			device: this.device,
			label: "Blit Backdrop Punch Pipeline",
			shaderModule: blitBackdropWithMaskShaderModule,
			pipelineLayout: blitWithMaskPipelineLayout,
			targetFormat: this.canvasFormat,
			fragmentEntryPoint: "fragmentPunch",
			blend: {
				color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
				alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
			},
			depthStencil: noopStencil,
		});

		const blitBackdropWithMaskPipeline = createFullscreenPipeline({
			device: this.device,
			label: "Blit Backdrop With Mask Pipeline",
			shaderModule: blitBackdropWithMaskShaderModule,
			pipelineLayout: blitWithMaskPipelineLayout,
			targetFormat: this.canvasFormat,
			blend: {
				color: { srcFactor: "one", dstFactor: "one" },
				alpha: { srcFactor: "one", dstFactor: "one" },
			},
			depthStencil: noopStencil,
		});

		this.pipelines = {
			strokePipeline: unifiedGeometryPipeline,
			fillPipeline: unifiedGeometryPipeline,
			gradientFillPipeline: unifiedGeometryPipeline,
			dummyGradientBindGroup,
			dummyMaskBindGroup,
			stencilFanWritePipeline,
			stencilCoverPipeline,
			strokeUnionPipeline,
			stencilZeroPipeline,
			pulledGeometryPipeline,
			pulledStencilFanWritePipeline,
			blitPipeline,
			blitPipelineRgba8,
			blitPipelineRgba32Float,
			blitWithMaskPipeline,
			blitWithEraseMaskPipeline,
			blitBackdropWithMaskPipeline,
			blitBackdropPunchPipeline,
			blitGlassPunchPipeline,
			compositePipeline,
			exposureBlitPipeline,
			quadBlitPipeline,
			meshBlitPipeline,
		};

		this.layouts = {
			blit: blitBindGroupLayout,
			blitWithMask: blitWithMaskBindGroupLayout,
			composite: compositeBindGroupLayout,
			exposureBlit: exposureBlitBindGroupLayout,
			gradient: gradientBindGroupLayout,
			transforms: transformsBindGroupLayout,
			mask: maskBindGroupLayout,
			pulled: pulledBindGroupLayout,
		};

		// Filter renderer
		const filterRenderer = new FilterRenderer(this.device);
		const blurProcessor = new BlurFilterProcessor();
		await blurProcessor.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("blur", blurProcessor);

		const frostGlassProcessor = new FrostGlassFilterProcessor();
		await frostGlassProcessor.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("frost-glass", frostGlassProcessor);

		const dropShadowProcessor = new DropShadowFilterProcessor();
		await dropShadowProcessor.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("drop-shadow", dropShadowProcessor);

		const pixelateProcessor = new PixelateFilterProcessor();
		await pixelateProcessor.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("pixelate", pixelateProcessor);

		const zigzagHandler = new ZigzagFilterHandler();
		await zigzagHandler.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("zigzag", zigzagHandler);

		const pathOffsetHandler = new PathOffsetFilterHandler();
		await pathOffsetHandler.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("path-offset", pathOffsetHandler);

		const pathUnionHandler = new PathUnionFilterHandler();
		await pathUnionHandler.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("path-union", pathUnionHandler);

		const puckerBloatHandler = new PuckerBloatFilterHandler();
		await puckerBloatHandler.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("pucker-bloat", puckerBloatHandler);

		const rotate3dProcessor = new Rotate3DFilterProcessor();
		await rotate3dProcessor.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("3d-rotate", rotate3dProcessor);

		const extrude3dHandler = new Extrude3DFilterHandler();
		extrude3dHandler.setFilterRenderer(filterRenderer);
		await extrude3dHandler.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("extrude3d", extrude3dHandler);

		const revolve3dHandler = new Revolve3DFilterHandler();
		revolve3dHandler.setFilterRenderer(filterRenderer);
		await revolve3dHandler.initialize(this.device, this.canvasFormat);
		filterRenderer.registerHandler("revolve3d", revolve3dHandler);

		// Hanakla Kit filters
		const hkHandlers: [string, RegisterableFilterHandler][] = [
			["hk:bloom", new HKBloomHandler()],
			["hk:directional-blur", new HKDirectionalBlurHandler()],
			["hk:kirakira", new HKKirakiraHandler()],
			["hk:radial-rot-dir", new HKRadialRotDirHandler()],
			["hk:gradient-map", new HKGradientMapHandler()],
			["hk:posterization", new HKPosterizationHandler()],
			["hk:color-replacement", new HKColorReplacementHandler()],
			["hk:selective-correction", new HKSelectiveCorrectionHandler()],
			["hk:fluid", new HKFluidHandler()],
			["hk:glitch", new HKGlitchHandler()],
			["hk:smear", new HKSmearHandler()],
			["hk:spraying", new HKSprayingHandler()],
			["hk:turbulence", new HKTurbulenceHandler()],
			["hk:wave", new HKWaveHandler()],
			["hk:blush-stroke", new HKBlushStrokeHandler()],
			["hk:chromatic-aberration", new HKChromaticAberrationHandler()],
			["hk:comic-tone", new HKComicToneHandler()],
			["hk:halftone", new HKHalftoneHandler()],
			["hk:inner-glow", new HKInnerGlowHandler()],
			["hk:outline", new HKOutlineHandler()],
			["hk:vhs-interlace", new HKVhsInterlaceHandler()],
			["hk:paper-v2", new HKPaperV2Handler()],
			["hk:husky", new HKHuskyHandler()],
			["hk:kaleidoscope", new HKKaleidoscopeHandler()],
			["hk:pixel-sort", new HKPixelSortHandler()],
		];

		const device = this.device as GPUDevice;
		await Promise.all(
			hkHandlers.map(([, handler]) =>
				handler.initialize(device, this.canvasFormat),
			),
		);

		for (const [id, handler] of hkHandlers) {
			filterRenderer.registerHandler(id, handler);
		}

		this.filterRenderer = filterRenderer;

		// Brush texture manager
		this.brushTextureManager = new BrushTextureManager(this.device);
		await this.brushTextureManager.loadDefaultTextures();

		// Text renderer
		const fontManager = getFontManager();
		const textLayoutEngine = new TextLayoutEngine(fontManager);
		this.textRenderer = new TextRenderer(textLayoutEngine);
		this.textRenderer.setDocumentResolver(this.textDocumentResolver);

		// Coons patch compute
		const coonsPatchComputeBindGroupLayout = this.device.createBindGroupLayout({
			label: "CoonsPatch Compute Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 3,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 4,
					visibility: GPUShaderStage.COMPUTE,
					storageTexture: {
						access: "write-only",
						format: "rgba8unorm",
					},
				},
			],
		});

		const { module: coonsPatchComputeModule } = compileShaderModule(
			this.device,
			{ label: "Coons Patch Compute Shader", code: COONS_PATCH_COMPUTE_SHADER },
		);

		const coonsPatchComputePipeline = this.device.createComputePipeline({
			label: "Coons Patch Compute Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [coonsPatchComputeBindGroupLayout],
			}),
			compute: {
				module: coonsPatchComputeModule,
				entryPoint: "main",
			},
		});

		this.gradientTextureGenerator = new GradientTextureGenerator(
			this.device,
			coonsPatchComputePipeline,
			coonsPatchComputeBindGroupLayout,
		);
		this.meshGradientTextureGenerator = new MeshGradientTextureGenerator(
			this.device,
		);
	}
}

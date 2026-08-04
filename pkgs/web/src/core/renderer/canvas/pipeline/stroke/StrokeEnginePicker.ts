/**
 * StrokeEnginePicker — registry that maps BrushSettings.type to the engine
 * that owns that brush family.
 *
 * Three engines:
 *   - GeometricStrokeEngine: `stroke`
 *   - StampStrokeEngine:     `scatter` + `calligraphy`
 *   - RibbonStrokeEngine:    `art` + `pattern`
 *
 * The registry also forwards the frame-level lifecycle (beginFrame,
 * setActiveUniformBuffer) and the batch lifecycle (beginBatch, addToBatch,
 * flushBatch) onto the shared StrokeBatchContext that both stamp and ribbon
 * engines drive.
 */

import type { BrushType } from "../../../../schema";
import type { PipelineType } from "../../CanvasLayerTypes";
import type { BrushTextureManager } from "../brush/BrushTextureManager";
import type { GeometricStrokeEngine } from "./GeometricStrokeEngine";
import type { RibbonStrokeEngine } from "./RibbonStrokeEngine";
import type { StampStrokeEngine } from "./StampStrokeEngine";
import type { StrokeBatchContext } from "./StrokeBatchContext";
import type {
	EnginePipeline,
	ResolvedStrokeStyle,
	StrokeEngine,
} from "./StrokeEngine";

export interface StrokeEngineRegistryEngines {
	geometric: GeometricStrokeEngine;
	stamp: StampStrokeEngine;
	ribbon: RibbonStrokeEngine;
}

/**
 * Registry of StrokeEngine instances. CanvasLayer holds exactly one.
 *
 * The stamp + ribbon engines drive a shared StrokeBatchContext that hosts the
 * actual WebGPU pipelines (stamp / scatter-array / ribbon). The context is
 * therefore kept as an internal field — call sites should obtain the texture
 * manager via `getBrushTextureManager()` (the only concern that leaks out is
 * texture preloading from ElementRenderer.ensureBrushTexture).
 */
export class StrokeEngineRegistry {
	private readonly engineById: Map<BrushType, StrokeEngine>;
	private readonly pipelineById: Map<BrushType, EnginePipeline>;
	private readonly context: StrokeBatchContext;

	public constructor(
		engines: StrokeEngineRegistryEngines,
		context: StrokeBatchContext,
		pipelines: Map<BrushType, EnginePipeline>,
	) {
		this.context = context;
		this.pipelineById = pipelines;
		this.engineById = new Map();
		for (const engine of [engines.geometric, engines.stamp, engines.ribbon]) {
			for (const id of engine.ids) {
				this.engineById.set(id, engine);
			}
		}
	}

	/** Look up the engine pipeline that owns a given brush family. */
	public pickPipeline(brushType: BrushType): EnginePipeline | null {
		return this.pipelineById.get(brushType) ?? null;
	}

	/**
	 * Frame-level reset. Mirrors StrokeBatchContext.beginFrame().
	 */
	public beginFrame(): void {
		this.context.beginFrame();
	}

	/**
	 * Switch the viewport uniform buffer used by stamp / ribbon shaders.
	 * Called by CanvasLayer's pushViewportBinding / popViewportBinding stack.
	 */
	public setActiveUniformBuffer(buffer: GPUBuffer | null): void {
		this.context.setActiveUniformBuffer(buffer);
	}

	/** Install the hook run right before a batch flush encodes its draws —
	 *  the geometry run batcher emits its pending merged draw through this. */
	public setOnBeforeBatchDraw(hook: (() => void) | null): void {
		this.context.onBeforeDraw = hook;
	}

	// -----------------------------------------------------------------
	// Batch lifecycle — stamp + ribbon share the StrokeBatchContext's
	// path-meta / color-stops buffers (stamp instances and ribbon segments
	// live in distinct sub-buffers but reuse the same PathMeta indexing).
	// -----------------------------------------------------------------

	public beginBatch(): void {
		this.context.beginBatch();
	}

	public addToBatch(style: ResolvedStrokeStyle, transformIndex: number): void {
		const pipeline = this.pickPipeline(style.brush.type);
		if (!pipeline?.addToBatch) return;
		pipeline.addToBatch(style, transformIndex);
	}

	public flushBatch(
		passEncoder: GPURenderPassEncoder,
		pipelineType: PipelineType,
		transformsBindGroup: GPUBindGroup,
	): void {
		this.context.flushBatch(passEncoder, pipelineType, transformsBindGroup);
	}

	/**
	 * Immediate render path (offscreen / stencil / non-batch fallback).
	 * Dispatches to the engine that owns the brush family.
	 */
	public render(
		passEncoder: GPURenderPassEncoder,
		style: ResolvedStrokeStyle,
		pipelineType: PipelineType,
		transformsBindGroup: GPUBindGroup,
	): void {
		const pipeline = this.pickPipeline(style.brush.type);
		if (!pipeline) return;
		this.context.onBeforeDraw?.();
		pipeline.render(passEncoder, style, pipelineType, transformsBindGroup);
	}

	/**
	 * BrushTextureManager accessor — exposed because ElementRenderer's
	 * ensureBrushTexture() preloads textures into the shared manager.
	 */
	/** The shared batch context (mix driver needs its dab draw machinery). */
	public getBatchContext(): StrokeBatchContext {
		return this.context;
	}

	public getBrushTextureManager(): BrushTextureManager {
		return this.context.getTextureManager();
	}

	public destroy(): void {
		for (const pipeline of new Set(this.pipelineById.values()))
			pipeline.destroy();
		this.context.destroy();
	}
}

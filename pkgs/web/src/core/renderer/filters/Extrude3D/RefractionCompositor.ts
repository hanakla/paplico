import type { Viewport } from "../../../schema";
import {
	compileShaderModule,
	type StructuredView,
} from "../../../utils/wgpu-utils";
import type { BackdropEffectSample } from "../../canvas/pipeline/BackdropEffectCoordinator";
import type { UnderlayResult } from "../../canvas/pipeline/FilterRenderer";
import { FrameUniformPool } from "../../canvas/pipeline/FrameUniformPool";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import {
	EXTRUDE_COVERAGE_CUT_SHADER,
	EXTRUDE_REFRACTION_SHADER,
} from "../../shaders/extrudeRefraction.wgsl";
import { UV_RECT_BLIT_SHADER } from "../../shaders/uvRectBlit.wgsl";

/** Refraction compositing inputs for one glass extrude. */
export interface RefractionParams {
	/** Backdrop offset scale in rect uv = (ior − 1) · thickness (scaled). */
	refractScale: number;
	/** Chromatic aberration (per-channel offset spread). */
	aberration: number;
	/** Used sub-rect of the pool-quantized mesh color/normal textures. */
	meshUvRect: [number, number, number, number];
	/** The solid's projected quad in compose-viewport NDC, as two packed
	 *  corner pairs: [TL.xy, TR.xy] and [BR.xy, BL.xy]. */
	quadNdc: [[number, number, number, number], [number, number, number, number]];
	/** Per-corner projective weights (computeQuadProjectiveWeights). */
	quadQ: [number, number, number, number];
}

/**
 * Runs the glass refraction: the solid composited over a per-pixel refracted
 * copy of the shared backdrop sample (two Gaussian-pyramid levels bracketing
 * the effect's blur sigma, built once per batch by BackdropEffectCoordinator
 * — this compositor blurs nothing itself). Restricted to the
 * effect's screen rect via the viewport, and composited as a coverage-masked
 * two-draw replace (punch by 1 − coverage, then additive add) so pixels
 * outside the solid never touch the destination — the shared backdrop sample
 * can be older than the destination (one capture per epoch, per FRAME during
 * pan/zoom), so rewriting the full rect would roll later-drawn content back.
 */
export class RefractionCompositor {
	private refractionPipeline: GPURenderPipeline | null = null;
	private punchPipeline: GPURenderPipeline | null = null;
	private coverageWritePipeline: GPURenderPipeline | null = null;
	private copyPipeline: GPURenderPipeline | null = null;
	private cutPipeline: GPURenderPipeline | null = null;
	private cutLayout: GPUBindGroupLayout | null = null;
	private underlayPipeline: GPURenderPipeline | null = null;
	private underlayLayout: GPUBindGroupLayout | null = null;
	private underlayUniforms: StructuredView | null = null;
	private refractionLayout: GPUBindGroupLayout | null = null;
	private refractionUniforms: StructuredView | null = null;
	private sampler: GPUSampler | null = null;
	private readonly refractionPool: FrameUniformPool;
	private readonly underlayPool: FrameUniformPool;

	public constructor(private readonly device: GPUDevice) {
		this.refractionPool = new FrameUniformPool(device, "Refraction Uniforms");
		this.underlayPool = new FrameUniformPool(device, "Glass Underlay Uniforms");
	}

	public initialize(format: GPUTextureFormat): void {
		if (this.refractionPipeline) return;

		this.sampler = this.device.createSampler({
			label: "Refraction Sampler",
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const refraction = compileShaderModule(this.device, {
			label: "Extrude Refraction Shader",
			code: EXTRUDE_REFRACTION_SHADER,
		});
		this.refractionUniforms = refraction.uniformViews.uniforms;
		this.refractionLayout = this.device.createBindGroupLayout({
			label: "Refraction Bind Group Layout",
			entries: [
				{
					// The vertex stage reads the projected quad from the same block.
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
				...[2, 3, 4, 5].map((binding) => ({
					binding,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" as const },
				})),
			],
		});
		// Two-draw replace: punch scales the destination by (1 - coverage),
		// then the additive draw adds the coverage-masked refracted result.
		// Pixels outside the solid (coverage 0) stay untouched by both draws,
		// which matters when the backdrop sample predates the destination.
		const pipelineLayout = this.device.createPipelineLayout({
			bindGroupLayouts: [this.refractionLayout],
		});
		this.punchPipeline = this.device.createRenderPipeline({
			label: "Refraction Punch Pipeline",
			layout: pipelineLayout,
			vertex: { module: refraction.module, entryPoint: "vertexMain" },
			fragment: {
				module: refraction.module,
				entryPoint: "fragmentPunch",
				targets: [
					{
						format,
						blend: {
							color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
							alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
						},
					},
				],
			},
			primitive: { topology: "triangle-list" },
		});
		this.refractionPipeline = this.device.createRenderPipeline({
			label: "Refraction Pipeline",
			layout: pipelineLayout,
			vertex: { module: refraction.module, entryPoint: "vertexMain" },
			fragment: {
				module: refraction.module,
				entryPoint: "fragmentMain",
				targets: [
					{
						format,
						blend: {
							color: { srcFactor: "one", dstFactor: "one" },
							alpha: { srcFactor: "one", dstFactor: "one" },
						},
					},
				],
			},
			primitive: { topology: "triangle-list" },
		});
		// Coverage side-channel writer for the intermediate route: the same
		// fragmentPunch coverage, accumulated with a plain over so several
		// glass entries union up. The final canvas punch reads it back to
		// know where the intermediate content REPLACES the backdrop.
		this.coverageWritePipeline = this.device.createRenderPipeline({
			label: "Refraction Coverage Pipeline",
			layout: pipelineLayout,
			vertex: { module: refraction.module, entryPoint: "vertexMain" },
			fragment: {
				module: refraction.module,
				entryPoint: "fragmentCoverageWrite",
				targets: [
					{
						format,
						blend: {
							color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
							alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
						},
					},
				],
			},
			primitive: { topology: "triangle-list" },
		});

		// Virtual-backdrop passes for the multi-entry intermediate route: a
		// pixel-exact copy of the canvas, and the union cut-out that turns
		// the composed virtual backdrop back into glass-only content.
		const cut = compileShaderModule(this.device, {
			label: "Extrude Coverage Cut Shader",
			code: EXTRUDE_COVERAGE_CUT_SHADER,
		});
		this.cutLayout = this.device.createBindGroupLayout({
			label: "Coverage Cut Bind Group Layout",
			entries: [0, 1].map((binding) => ({
				binding,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: "float" as const },
			})),
		});
		const cutPipelineLayout = this.device.createPipelineLayout({
			bindGroupLayouts: [this.cutLayout],
		});
		this.copyPipeline = this.device.createRenderPipeline({
			label: "Coverage Copy Pipeline",
			layout: cutPipelineLayout,
			vertex: { module: cut.module, entryPoint: "vertexMain" },
			fragment: {
				module: cut.module,
				entryPoint: "fragmentCopy",
				targets: [{ format }],
			},
			primitive: { topology: "triangle-list" },
		});
		this.cutPipeline = this.device.createRenderPipeline({
			label: "Coverage Cut Pipeline",
			layout: cutPipelineLayout,
			vertex: { module: cut.module, entryPoint: "vertexMain" },
			fragment: {
				module: cut.module,
				entryPoint: "fragmentCut",
				targets: [{ format }],
			},
			primitive: { topology: "triangle-list" },
		});

		// A plain uv-rect blit; only the blend state below makes it an underlay.
		const underlay = compileShaderModule(this.device, {
			label: "Glass Underlay Shader",
			code: UV_RECT_BLIT_SHADER,
		});
		this.underlayUniforms = underlay.uniformViews.uniforms;
		this.underlayLayout = this.device.createBindGroupLayout({
			label: "Glass Underlay Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});
		this.underlayPipeline = this.device.createRenderPipeline({
			label: "Glass Underlay Pipeline",
			layout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.underlayLayout],
			}),
			vertex: { module: underlay.module, entryPoint: "vertexMain" },
			fragment: {
				module: underlay.module,
				entryPoint: "fragmentMain",
				targets: [
					{
						format,
						// Premultiplied destination-over: the existing glass content
						// keeps its weight, the underlay fills what it left through.
						blend: {
							color: {
								srcFactor: "one-minus-dst-alpha",
								dstFactor: "one",
							},
							alpha: {
								srcFactor: "one-minus-dst-alpha",
								dstFactor: "one",
							},
						},
					},
				],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	/** Pixel-exact copy of `source`'s top-left width x height into `targetView`. */
	public copyRegion(
		encoder: GPUCommandEncoder,
		source: GPUTexture,
		targetView: GPUTextureView,
		width: number,
		height: number,
	): void {
		this.runCutPass(
			encoder,
			"Virtual Backdrop Copy Pass",
			this.copyPipeline,
			source,
			source,
			targetView,
			width,
			height,
		);
	}

	/** targetView = source x coverage.r over the top-left width x height. */
	public cutOutCoverage(
		encoder: GPUCommandEncoder,
		source: GPUTexture,
		coverage: GPUTexture,
		targetView: GPUTextureView,
		width: number,
		height: number,
	): void {
		this.runCutPass(
			encoder,
			"Coverage Cut Pass",
			this.cutPipeline,
			source,
			coverage,
			targetView,
			width,
			height,
		);
	}

	private runCutPass(
		encoder: GPUCommandEncoder,
		label: string,
		pipeline: GPURenderPipeline | null,
		source: GPUTexture,
		coverage: GPUTexture,
		targetView: GPUTextureView,
		width: number,
		height: number,
	): void {
		if (!pipeline || !this.cutLayout) {
			console.warn("RefractionCompositor used before initialize()");
			return;
		}
		const pass = encoder.beginRenderPass({
			label,
			colorAttachments: [
				{
					view: targetView,
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setViewport(0, 0, width, height, 0, 1);
		pass.setPipeline(pipeline);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({
				label: "Coverage Cut Bind Group",
				layout: this.cutLayout,
				entries: [
					{ binding: 0, resource: source.createView() },
					{ binding: 1, resource: coverage.createView() },
				],
			}),
		);
		pass.draw(3);
		pass.end();
	}

	/** Reset the per-draw uniform-buffer pools. */
	public beginFrame(): void {
		this.refractionPool.beginFrame();
		this.underlayPool.beginFrame();
	}

	/**
	 * Composite the refracted glass into `targetView`, restricted to the
	 * sample's rect (device pixels). `load` keeps existing target content
	 * (writing into a sub-region of prebuf); false clears (offscreen tests).
	 * `coverage` additionally accumulates the solid's coverage into a
	 * side-channel texture (intermediate route; see BlitLayer.coverage).
	 */
	public compose(
		encoder: GPUCommandEncoder,
		targetView: GPUTextureView,
		load: boolean,
		meshColor: GPUTexture,
		meshNormal: GPUTexture,
		backdrop: BackdropEffectSample,
		params: RefractionParams,
		profiler?: GPUTimingProfiler | null,
		timingLabel?: string,
		coverage?: { view: GPUTextureView; load: boolean },
	): void {
		if (!this.refractionPipeline || !this.refractionUniforms) {
			console.warn("RefractionCompositor used before initialize()");
			return;
		}

		const { rect } = backdrop;
		this.refractionUniforms.set({
			params: [params.refractScale, params.aberration, 0, 0],
			meshUvRect: params.meshUvRect,
			backdropRemap: backdrop.backdropRemap,
			blurMix: [backdrop.blurMix, 0, 0, 0],
			blurLoCtl: backdrop.blurLoCtl,
			blurHiCtl: backdrop.blurHiCtl,
			quadTlTr: params.quadNdc[0],
			quadBrBl: params.quadNdc[1],
			quadQ: params.quadQ,
			rect: [rect.x, rect.y, rect.width, rect.height],
		});
		const uniformBuffer = this.refractionPool.write(
			this.refractionUniforms.arrayBuffer,
		);

		const pass = encoder.beginRenderPass({
			label: "Refraction Pass",
			colorAttachments: [
				{
					view: targetView,
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: load ? "load" : "clear",
					storeOp: "store",
				},
			],
			timestampWrites: profiler?.timestampWrites(
				timingLabel ?? "Glass Compose",
			),
		});
		const bindGroup = this.device.createBindGroup({
			label: "Refraction Bind Group",
			layout: this.refractionLayout!,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: this.sampler! },
				{ binding: 2, resource: meshColor.createView() },
				{ binding: 3, resource: meshNormal.createView() },
				{ binding: 4, resource: backdrop.blurLo.createView() },
				{ binding: 5, resource: backdrop.blurHi.createView() },
			],
		});
		// The quad can reach past the (canvas-clamped) compose rect, and the
		// viewport transform alone does not clip — only the scissor keeps the
		// draw inside the region the backdrop sample actually covers.
		pass.setViewport(rect.x, rect.y, rect.width, rect.height, 0, 1);
		pass.setScissorRect(rect.x, rect.y, rect.width, rect.height);
		pass.setBindGroup(0, bindGroup);
		pass.setPipeline(this.punchPipeline!);
		pass.draw(6);
		pass.setPipeline(this.refractionPipeline);
		pass.draw(6);
		pass.end();

		if (coverage) {
			const coveragePass = encoder.beginRenderPass({
				label: "Refraction Coverage Pass",
				colorAttachments: [
					{
						view: coverage.view,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: coverage.load ? "load" : "clear",
						storeOp: "store",
					},
				],
			});
			coveragePass.setViewport(rect.x, rect.y, rect.width, rect.height, 0, 1);
			coveragePass.setScissorRect(rect.x, rect.y, rect.width, rect.height);
			coveragePass.setBindGroup(0, bindGroup);
			coveragePass.setPipeline(this.coverageWritePipeline!);
			coveragePass.draw(6);
			coveragePass.end();
		}
	}

	/**
	 * Draw a cached, world-placed underlay (the coverage-driven drop shadow)
	 * beneath whatever is already in `targetView`, with a premultiplied
	 * destination-over blend. The draw rect is the underlay's world bounds in
	 * device px, clamped to the canvas — the source uv shrinks to match, so a
	 * shadow running past the edge keeps its scale instead of squeezing in.
	 */
	public blitUnderlay(
		encoder: GPUCommandEncoder,
		targetView: GPUTextureView,
		canvasWidth: number,
		canvasHeight: number,
		underlay: UnderlayResult,
		viewport: Pick<Viewport, "x" | "y" | "zoom">,
	): void {
		if (!this.underlayPipeline || !this.underlayUniforms) {
			console.warn("RefractionCompositor used before initialize()");
			return;
		}
		const { bounds, uvRect } = underlay;
		const z = viewport.zoom;
		const x = (bounds.minX - viewport.x) * z + canvasWidth / 2;
		const y = canvasHeight / 2 - (bounds.maxY - viewport.y) * z;
		const w = bounds.width * z;
		const h = bounds.height * z;
		if (!(w > 0) || !(h > 0)) return;

		const clampedX = Math.max(0, Math.floor(x));
		const clampedY = Math.max(0, Math.floor(y));
		const clampedRight = Math.min(canvasWidth, Math.ceil(x + w));
		const clampedBottom = Math.min(canvasHeight, Math.ceil(y + h));
		const clampedW = clampedRight - clampedX;
		const clampedH = clampedBottom - clampedY;
		if (clampedW <= 0 || clampedH <= 0) return;

		const uSpan = uvRect.maxU - uvRect.minU;
		const vSpan = uvRect.maxV - uvRect.minV;
		this.underlayUniforms.set({
			uvRect: [
				uvRect.minU + ((clampedX - x) / w) * uSpan,
				uvRect.minV + ((clampedY - y) / h) * vSpan,
				uvRect.minU + ((clampedRight - x) / w) * uSpan,
				uvRect.minV + ((clampedBottom - y) / h) * vSpan,
			],
		});
		const uniformBuffer = this.underlayPool.write(
			this.underlayUniforms.arrayBuffer,
		);

		const pass = encoder.beginRenderPass({
			label: "Glass Underlay Pass",
			colorAttachments: [
				{ view: targetView, loadOp: "load", storeOp: "store" },
			],
		});
		pass.setViewport(clampedX, clampedY, clampedW, clampedH, 0, 1);
		pass.setScissorRect(clampedX, clampedY, clampedW, clampedH);
		pass.setPipeline(this.underlayPipeline);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({
				label: "Glass Underlay Bind Group",
				layout: this.underlayLayout!,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: this.sampler! },
					{ binding: 2, resource: underlay.texture.texture.createView() },
				],
			}),
		);
		pass.draw(3);
		pass.end();
	}

	public destroy(): void {
		this.refractionPool.destroy();
		this.underlayPool.destroy();
		this.sampler = null;
		this.refractionPipeline = null;
		this.punchPipeline = null;
		this.coverageWritePipeline = null;
		this.copyPipeline = null;
		this.cutPipeline = null;
		this.cutLayout = null;
		this.underlayPipeline = null;
		this.underlayLayout = null;
		this.underlayUniforms = null;
		this.refractionLayout = null;
		this.refractionUniforms = null;
	}
}

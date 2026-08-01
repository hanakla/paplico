/**
 * Pixelate Filter Processor
 * Downsamples onto a blocksX x blocksY grid. Runs on the element raster,
 * or with applyToBackdrop on the captured backdrop masked to the element
 * shape by the backdrop pipeline.
 */

import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../schema";
import { compileShaderModule } from "../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
	FilterRenderRequirements,
} from "../canvas/pipeline/FilterRenderer";
import { PIXELATE_SHADER } from "./pixelate.wgsl";

export interface PixelateParams {
	/** Block cell width in world px. */
	blockWidth: number;
	/** Block cell height in world px. */
	blockHeight: number;
	linkAxes: boolean;
	mode: "bilinear" | "bicubic";
	/** @deprecated Legacy documents only — new documents use the common
	 *  Appearance.applyToBackdrop flag (ORed with this in getRenderConfigure). */
	applyToBackdrop?: boolean;
}

export interface PixelateFilter extends Appearance<PixelateParams> {
	processor: "pixelate";
}

export class PixelateFilterProcessor implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	/**
	 * With applyToBackdrop, pixelate requires backdrop capture - it
	 * pixelates what's behind the element (the mask is applied afterwards
	 * by the backdrop pipeline). Reads the deprecated per-filter param for
	 * legacy documents; new documents use the common Appearance flag, which
	 * resolveRenderConfigure ORs on top of this.
	 */
	public getRenderConfigure(filter: Filter): FilterRenderRequirements {
		const f = filter as PixelateFilter;
		return {
			needsBackdrop: f.paramData.params.applyToBackdrop ?? false,
			needsSourceTexture: true,
		};
	}

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;
		const { module, uniformViews } = compileShaderModule(device, {
			label: "Pixelate Filter Shader",
			code: PIXELATE_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "Pixelate Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		this.pipeline = device.createRenderPipeline({
			label: "Pixelate Filter Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: { module, entryPoint: "vertexMain" },
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as PixelateFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("PixelateFilterProcessor not initialized");
			return;
		}

		const params = f.paramData.params;
		const sourceOffset = context.coordinateSpace?.sourceOffset ?? {
			x: 0,
			y: 0,
		};

		// The sub-texel content offset keeps the world-px block grid
		// DPI-invariant. The source offset anchors backdrop captures to their
		// unclipped coordinate space while element filters retain a local origin.
		const contentOffset = context.sourceContentOffset ?? { x: 0, y: 0 };

		// Documents saved before the block-size rework lack these params
		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			contentOffset: [contentOffset.x, contentOffset.y],
			sourceOffset: [sourceOffset.x, sourceOffset.y],
			dpiScale,
			blockWidth: params.blockWidth ?? 8,
			blockHeight: params.blockHeight ?? 8,
			mode: params.mode === "bicubic" ? 1 : 0,
		});

		const uniformBuffer = device.createBuffer({
			label: "Pixelate Uniform Buffer",
			size: this.uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, this.uniformView.arrayBuffer);

		const sampler = device.createSampler({
			magFilter: "nearest",
			minFilter: "nearest",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const bindGroup = device.createBindGroup({
			label: "Pixelate Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "Pixelate Filter Pass",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "Pixelate Filter",
			),
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});

		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(3, 1, 0, 0);
		pass.end();
	}

	public getExpansionMargin(_filter: Filter): number {
		return 0;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as PixelateFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					blockWidth: f.paramData.params.blockWidth * uniformScale,
					blockHeight: f.paramData.params.blockHeight * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as PixelateFilter["paramData"]["params"];
		const b = paramsB as PixelateFilter["paramData"]["params"];
		return {
			blockWidth: a.blockWidth + (b.blockWidth - a.blockWidth) * t,
			blockHeight: a.blockHeight + (b.blockHeight - a.blockHeight) * t,
			linkAxes: t < 0.5 ? a.linkAxes : b.linkAxes,
			mode: t < 0.5 ? a.mode : b.mode,
			applyToBackdrop: t < 0.5 ? a.applyToBackdrop : b.applyToBackdrop,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

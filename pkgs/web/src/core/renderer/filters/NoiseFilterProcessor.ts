/**
 * Noise Filter Processor
 * Mixes per-cell random noise into the element. The pattern is decided on a
 * 1 world px (72 dpi) grid, and a higher rasterization DPI only subdivides
 * those cells into finer grain.
 */

import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../schema";
import { compileShaderModule } from "../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../canvas/pipeline/FilterRenderer";
import { NOISE_SHADER } from "./noise.wgsl";

export interface NoiseParams {
	/** 0 keeps the source, 1 replaces its color with the noise. */
	mixRate: number;
	seed: number;
	colorMode: "monochrome" | "color";
}

export interface NoiseFilter extends Appearance<NoiseParams> {
	processor: "noise";
}

/** Keeps the finest cell index inside i32 for any practical world coordinate. */
const MAX_SUBDIVISION_LEVELS = 8;

export class NoiseFilterProcessor implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		const { module, uniformViews } = compileShaderModule(device, {
			label: "Noise Filter Shader",
			code: NOISE_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "Noise Bind Group Layout",
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
			label: "Noise Filter Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: { module, entryPoint: "vertexMain" },
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [{ format: canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("NoiseFilterProcessor not initialized");
			return;
		}

		const params = (filter as NoiseFilter).paramData.params;
		const sourceOffset = context.coordinateSpace?.sourceOffset ?? {
			x: 0,
			y: 0,
		};
		const contentOffset = context.sourceContentOffset ?? { x: 0, y: 0 };

		// Only levels whose cells span at least one texel are added, so a
		// subdivision never aliases below the texture resolution.
		const levels = Math.min(
			Math.max(Math.floor(Math.log2(dpiScale)), 0),
			MAX_SUBDIVISION_LEVELS,
		);

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			contentOffset: [contentOffset.x, contentOffset.y],
			sourceOffset: [sourceOffset.x, sourceOffset.y],
			dpiScale,
			mixRate: params.mixRate,
			seed: params.seed,
			levels,
			colorMode: params.colorMode === "color" ? 1 : 0,
		});

		const uniformBuffer = device.createBuffer({
			label: "Noise Uniform Buffer",
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
			label: "Noise Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "Noise Filter Pass",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "Noise Filter",
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

	public getExpansionMargin(): number {
		return 0;
	}

	/** The grain is a fixed 1 world px grid, so scaling the element leaves it as is. */
	public onScaleFilter(params: Filter): Filter {
		return params;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as NoiseParams;
		const b = paramsB as NoiseParams;
		return {
			mixRate: a.mixRate + (b.mixRate - a.mixRate) * t,
			seed: t < 0.5 ? a.seed : b.seed,
			colorMode: t < 0.5 ? a.colorMode : b.colorMode,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

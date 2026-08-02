/**
 * Blur Filter Processor
 * Implements two-pass Gaussian blur
 */

import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../schema";
import { compileShaderModule } from "../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../canvas/pipeline/FilterRenderer";
import { BLUR_SHADER } from "./blur.wgsl";

export interface BlurParams {
	radius: number; // 0.0~100.0 (blur radius in pixels)
}

export interface BlurFilter extends Appearance<BlurParams> {
	processor: "blur";
}

export class BlurFilterProcessor implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;
		const { module, uniformViews } = compileShaderModule(device, {
			label: "Blur Filter Shader",
			code: BLUR_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		// Create bind group layout
		this.bindGroupLayout = device.createBindGroupLayout({
			label: "Blur Bind Group Layout",
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
			label: "Blur Filter Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: {
				module,
				entryPoint: "vertexMain",
			},
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: {
				topology: "triangle-list",
			},
		});
	}

	private createUniformBuffer(
		device: GPUDevice,
		label: string,
		resolution: [number, number],
		direction: [number, number],
		radius: number,
	): GPUBuffer {
		if (!this.uniformView) {
			throw new Error("BlurFilterProcessor not initialized");
		}

		// Use webgpu-utils structured view for correct padding/alignment
		this.uniformView.set({
			resolution,
			direction,
			radius,
		});

		const buffer = device.createBuffer({
			label,
			size: this.uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		device.queue.writeBuffer(buffer, 0, this.uniformView.arrayBuffer);
		return buffer;
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		if (filter.processor !== "blur") {
			throw new Error("BlurFilterProcessor can only process blur filters");
		}

		const blurFilter = filter as BlurFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("BlurFilterProcessor not initialized");
			return;
		}

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		// Two-pass separable Gaussian blur: horizontal then vertical
		// O(2n) instead of O(n^2) for a full 2D kernel
		const scaledRadius = blurFilter.paramData.params.radius * dpiScale;

		// radius=0: skip blur passes to avoid NaN from sigma=0 in the shader
		if (scaledRadius <= 0) {
			commandEncoder.copyTextureToTexture(
				{ texture: sourceTexture },
				{ texture: targetTexture },
				{ width: textureSize.width, height: textureSize.height },
			);
			return;
		}

		// === Pass 1: Horizontal blur (source -> target) ===
		const horizontalUniformBuffer = this.createUniformBuffer(
			device,
			"Blur Uniform Buffer (Horizontal)",
			[textureSize.width, textureSize.height],
			[1.0, 0.0],
			scaledRadius,
		);

		const horizontalBindGroup = device.createBindGroup({
			label: "Blur Bind Group (Horizontal)",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: horizontalUniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const horizontalPass = commandEncoder.beginRenderPass({
			label: "Blur Filter Pass (Horizontal)",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "Blur Filter",
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

		horizontalPass.setPipeline(this.pipeline);
		horizontalPass.setBindGroup(0, horizontalBindGroup);
		horizontalPass.draw(3, 1, 0, 0);
		horizontalPass.end();

		// Copy horizontal result to source for vertical pass input
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: sourceTexture },
			{ width: textureSize.width, height: textureSize.height },
		);

		// === Pass 2: Vertical blur ===
		const verticalUniformBuffer = this.createUniformBuffer(
			device,
			"Blur Uniform Buffer (Vertical)",
			[textureSize.width, textureSize.height],
			[0.0, 1.0],
			scaledRadius,
		);

		const verticalBindGroup = device.createBindGroup({
			label: "Blur Bind Group (Vertical)",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: verticalUniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const verticalPass = commandEncoder.beginRenderPass({
			label: "Blur Filter Pass (Vertical)",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "Blur Filter",
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

		verticalPass.setPipeline(this.pipeline);
		verticalPass.setBindGroup(0, verticalBindGroup);
		verticalPass.draw(3, 1, 0, 0);
		verticalPass.end();
	}

	public getExpansionMargin(filter: Filter): number {
		return ((filter as BlurFilter).paramData.params.radius ?? 0) * 3;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as BlurFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					radius: f.paramData.params.radius * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		return interpolateBlurParams(
			paramsA as BlurFilter["paramData"]["params"],
			paramsB as BlurFilter["paramData"]["params"],
			t,
		);
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

function interpolateBlurParams(
	a: BlurFilter["paramData"]["params"],
	b: BlurFilter["paramData"]["params"],
	t: number,
): BlurFilter["paramData"]["params"] {
	return { radius: a.radius + (b.radius - a.radius) * t };
}

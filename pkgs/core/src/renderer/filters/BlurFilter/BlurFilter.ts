/**
 * Blur Filter Processor
 * Implements two-pass Gaussian blur
 */

import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import {
	BlurPyramidBuilder,
	type BlurTextureCtl,
	blurTextureCtl,
	PYRAMID_BLUR_MIN_RADIUS,
	requiredPyramidLevels,
	selectPyramidLevels,
} from "../../canvas/pipeline/BlurPyramid";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { ScratchTexturePool } from "../shared/ScratchTexturePool";
import { BLUR_PYRAMID_RESOLVE_SHADER, BLUR_SHADER } from "./blur.wgsl";

export interface BlurParams {
	radius: number; // 0.0~100.0 (blur radius in pixels)
}

export interface BlurFilter extends Appearance<BlurParams> {
	processor: "blur";
}

export class BlurFilterHandler implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private resolvePipeline: GPURenderPipeline | null = null;
	private resolveBindGroupLayout: GPUBindGroupLayout | null = null;
	private resolveUniformView: StructuredView | null = null;
	private sampler: GPUSampler | null = null;
	private blurPyramid: BlurPyramidBuilder | null = null;
	private readonly scratch = new ScratchTexturePool();
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

		const resolve = compileShaderModule(device, {
			label: "Blur Pyramid Resolve Shader",
			code: BLUR_PYRAMID_RESOLVE_SHADER,
		});
		this.resolveUniformView = resolve.uniformViews.uniforms;
		this.resolveBindGroupLayout = device.createBindGroupLayout({
			label: "Blur Pyramid Resolve Bind Group Layout",
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
				...[2, 3].map((binding) => ({
					binding,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" as const },
				})),
			],
		});
		this.resolvePipeline = device.createRenderPipeline({
			label: "Blur Pyramid Resolve Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.resolveBindGroupLayout],
			}),
			vertex: { module: resolve.module, entryPoint: "vertexMain" },
			fragment: {
				module: resolve.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		this.sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		this.blurPyramid = new BlurPyramidBuilder(device, (width, height, format) =>
			this.scratch.acquire(
				device,
				width,
				height,
				format,
				GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
				"Blur Pyramid Level",
			),
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		if (filter.processor !== "blur") {
			throw new Error("BlurFilterHandler can only process blur filters");
		}

		const blurFilter = filter as BlurFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.pipeline ||
			!this.bindGroupLayout ||
			!this.uniformView ||
			!this.sampler
		) {
			console.warn("BlurFilterHandler not initialized");
			return;
		}

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

		if (scaledRadius >= PYRAMID_BLUR_MIN_RADIUS) {
			this.encodePyramidResolve(context, scaledRadius);
			// The chain's passes are encoded; the next one may reuse these
			// intermediates, since passes execute in encode order.
			this.scratch.releaseAll();
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
				{ binding: 2, resource: this.sampler },
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
				{ binding: 2, resource: this.sampler },
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

	/** Called by FilterRenderer at frame start. */
	public flushPendingDestroy(): void {
		// Backstop: every chain returns its own intermediates, but a chain that
		// bailed out mid-way (uninitialized pipeline) would otherwise leave them
		// checked out forever.
		this.scratch.releaseAll();
		this.scratch.flushPendingDestroy();
		this.blurPyramid?.beginFrame();
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
		this.resolvePipeline = null;
		this.resolveBindGroupLayout = null;
		this.resolveUniformView = null;
		this.sampler = null;
		this.blurPyramid?.destroy();
		this.blurPyramid = null;
		this.scratch.destroy();
	}

	private createUniformBuffer(
		device: GPUDevice,
		label: string,
		resolution: [number, number],
		direction: [number, number],
		radius: number,
	): GPUBuffer {
		if (!this.uniformView) {
			throw new Error("BlurFilterHandler not initialized");
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

	/** Blur source -> target through the pyramid levels bracketing the sigma. */
	private encodePyramidResolve(
		context: FilterProcessorContext,
		scaledRadius: number,
	): void {
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize },
		} = context;
		const {
			blurPyramid,
			resolvePipeline,
			resolveBindGroupLayout,
			resolveUniformView,
			sampler,
		} = this;
		if (
			!blurPyramid ||
			!resolvePipeline ||
			!resolveBindGroupLayout ||
			!resolveUniformView ||
			!sampler
		) {
			return;
		}
		const { width, height } = textureSize;

		// Same sigma the direct kernel uses, so the two routes agree across the
		// PYRAMID_BLUR_MIN_RADIUS crossover.
		const sigma = scaledRadius / 2;
		const levels = blurPyramid.build(
			commandEncoder,
			sourceTexture,
			width,
			height,
			requiredPyramidLevels(sigma),
			context.profiler,
			context.timingLabel ?? "Blur Filter",
		);
		const { lo, hi, mix } = selectPyramidLevels(sigma, levels.length);
		const levelTexture = (index: number): GPUTexture =>
			index === 0 ? sourceTexture : levels[index - 1].texture;
		const levelCtl = (index: number): BlurTextureCtl =>
			index === 0
				? blurTextureCtl(width, height, sourceTexture)
				: levels[index - 1].ctl;

		resolveUniformView.set({
			control: [mix, 0, 0, 0],
			loCtl: levelCtl(lo),
			hiCtl: levelCtl(hi),
		});
		const uniformBuffer = device.createBuffer({
			label: "Blur Pyramid Resolve Uniforms",
			size: resolveUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, resolveUniformView.arrayBuffer);

		const pass = commandEncoder.beginRenderPass({
			label: "Blur Filter Pass (Pyramid Resolve)",
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
		pass.setViewport(0, 0, width, height, 0, 1);
		pass.setPipeline(resolvePipeline);
		pass.setBindGroup(
			0,
			device.createBindGroup({
				label: "Blur Pyramid Resolve Bind Group",
				layout: resolveBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: levelTexture(lo).createView() },
					{ binding: 3, resource: levelTexture(hi).createView() },
				],
			}),
		);
		pass.draw(3, 1, 0, 0);
		pass.end();
	}
}

function interpolateBlurParams(
	a: BlurFilter["paramData"]["params"],
	b: BlurFilter["paramData"]["params"],
	t: number,
): BlurFilter["paramData"]["params"] {
	return { radius: a.radius + (b.radius - a.radius) * t };
}

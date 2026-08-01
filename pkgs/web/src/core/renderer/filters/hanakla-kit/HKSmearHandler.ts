import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_SMEAR_SHADER } from "./hk-smear.wgsl";

export interface HKSmearParams {
	angle: number;
	/** Dry-brush coverage erosion threshold (0-1). */
	intensity: number;
	/** Streak wavelength along the streak direction, in world px. */
	streakLength: number;
	/** Streak wavelength across the streak direction, in world px. */
	streakWidth: number;
	/** Threshold smoothing half-width (0-0.5). */
	softness: number;
	randomSeed: number;
}
export interface HKSmearFilter extends Appearance<HKSmearParams> {
	processor: "hk:smear";
}

export class HKSmearHandler implements FilterHandler {
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
			label: "HK Smear Filter Shader",
			code: HK_SMEAR_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Smear Bind Group Layout",
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
			label: "HK Smear Filter Pipeline",
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
		const f = filter as HKSmearFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKSmearHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const contentOffset = context.sourceContentOffset ?? { x: 0, y: 0 };
		const worldOrigin = context.coordinateSpace?.sourceOffset ?? { x: 0, y: 0 };

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			contentOffset: [contentOffset.x, contentOffset.y],
			worldOrigin: [worldOrigin.x, worldOrigin.y],
			dpiScale,
			angle: params.angle,
			intensity: params.intensity,
			streakLength: params.streakLength,
			streakWidth: params.streakWidth,
			softness: params.softness,
			randomSeed: params.randomSeed,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Smear Uniform Buffer",
			size: this.uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, this.uniformView.arrayBuffer);

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const bindGroup = device.createBindGroup({
			label: "HK Smear Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Smear Filter Pass",
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
		// Smear only erodes existing coverage; it never draws outside the source.
		return 0;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKSmearFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					streakLength: f.paramData.params.streakLength * uniformScale,
					streakWidth: f.paramData.params.streakWidth * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKSmearFilter["paramData"]["params"];
		const b = paramsB as HKSmearFilter["paramData"]["params"];
		return {
			angle: a.angle + (b.angle - a.angle) * t,
			intensity: a.intensity + (b.intensity - a.intensity) * t,
			streakLength: a.streakLength + (b.streakLength - a.streakLength) * t,
			streakWidth: a.streakWidth + (b.streakWidth - a.streakWidth) * t,
			softness: a.softness + (b.softness - a.softness) * t,
			randomSeed: a.randomSeed + (b.randomSeed - a.randomSeed) * t,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_DIRECTIONAL_BLUR_SHADER } from "./hk-directional-blur.wgsl";

export interface HKDirectionalBlurParams {
	strength: number;
	angle: number;
	opacity: number;
	blurMode: "both" | "behind" | "front";
	originalEmphasis: number;
	fadeOut: number;
	fadeDirection: number;
}
export interface HKDirectionalBlurFilter
	extends Appearance<HKDirectionalBlurParams> {
	processor: "hk:directional-blur";
}

export class HKDirectionalBlurHandler implements FilterHandler {
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
			label: "HK Directional Blur Filter Shader",
			code: HK_DIRECTIONAL_BLUR_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Directional Blur Bind Group Layout",
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
			label: "HK Directional Blur Filter Pipeline",
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
		const f = filter as HKDirectionalBlurFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKDirectionalBlurHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		let blurModeValue = 0.0;
		if (params.blurMode === "behind") {
			blurModeValue = 1.0;
		} else if (params.blurMode === "front") {
			blurModeValue = 2.0;
		}

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			strength: params.strength,
			angle: params.angle,
			opacity: params.opacity,
			blurMode: blurModeValue,
			originalEmphasis: params.originalEmphasis ?? 0.0,
			fadeOut: params.fadeOut ?? 0.0,
			fadeDirection: params.fadeDirection ?? 0.0,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Directional Blur Uniform Buffer",
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
			label: "HK Directional Blur Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Directional Blur Filter Pass",
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

	public getExpansionMargin(filter: Filter): number {
		return (
			((filter as HKDirectionalBlurFilter).paramData.params.strength ?? 0) / 2
		);
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKDirectionalBlurFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					strength: f.paramData.params.strength * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKDirectionalBlurFilter["paramData"]["params"];
		const b = paramsB as HKDirectionalBlurFilter["paramData"]["params"];
		return {
			strength: a.strength + (b.strength - a.strength) * t,
			angle: a.angle + (b.angle - a.angle) * t,
			opacity: a.opacity + (b.opacity - a.opacity) * t,
			blurMode: b.blurMode,
			originalEmphasis:
				(a.originalEmphasis ?? 0) +
				((b.originalEmphasis ?? 0) - (a.originalEmphasis ?? 0)) * t,
			fadeOut: a.fadeOut + (b.fadeOut - a.fadeOut) * t,
			fadeDirection: a.fadeDirection + (b.fadeDirection - a.fadeDirection) * t,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

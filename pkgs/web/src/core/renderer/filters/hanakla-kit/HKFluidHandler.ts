import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_FLUID_SHADER } from "./hk-fluid.wgsl";

export interface HKFluidParams {
	intensity: number;
	speed: number;
	scale: number;
	turbulence: number;
	colorShift: number;
	padding: number;
	timeSeed: number;
}
export interface HKFluidFilter extends Appearance<HKFluidParams> {
	processor: "hk:fluid";
}

export class HKFluidHandler implements FilterHandler {
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
			label: "HK Fluid Filter Shader",
			code: HK_FLUID_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Fluid Bind Group Layout",
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
			label: "HK Fluid Filter Pipeline",
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
		const f = filter as HKFluidFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKFluidHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		// The bake may cover only a viewport-clamped sub-rect of the element;
		// anchor the noise field to the full element rect (see fluidWorldPos)
		// so the pattern stays fixed while zooming or panning.
		const worldSize = context.sourceWorldSize ?? {
			width: textureSize.width / dpiScale,
			height: textureSize.height / dpiScale,
		};
		const contentOffset = context.sourceContentOffset ?? { x: 0, y: 0 };
		const elementWorldSize = context.coordinateSpace?.worldSize ?? worldSize;
		const worldOrigin = context.coordinateSpace?.sourceOffset ?? { x: 0, y: 0 };

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			contentOffset: [contentOffset.x, contentOffset.y],
			worldOrigin: [worldOrigin.x, worldOrigin.y],
			elementSize: [elementWorldSize.width, elementWorldSize.height],
			dpiScale,
			intensity: params.intensity,
			speed: params.speed,
			scale: params.scale,
			turbulence: params.turbulence,
			colorShift: params.colorShift,
			timeSeed: params.timeSeed,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Fluid Uniform Buffer",
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
			label: "HK Fluid Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Fluid Filter Pass",
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
		const f = filter as HKFluidFilter;
		return f.paramData.params.padding;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKFluidFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					intensity: f.paramData.params.intensity * uniformScale,
					scale: f.paramData.params.scale * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKFluidFilter["paramData"]["params"];
		const b = paramsB as HKFluidFilter["paramData"]["params"];
		return {
			intensity: a.intensity + (b.intensity - a.intensity) * t,
			speed: a.speed + (b.speed - a.speed) * t,
			scale: a.scale + (b.scale - a.scale) * t,
			turbulence: a.turbulence + (b.turbulence - a.turbulence) * t,
			colorShift: a.colorShift + (b.colorShift - a.colorShift) * t,
			padding: Math.round(a.padding + (b.padding - a.padding) * t),
			timeSeed: a.timeSeed + (b.timeSeed - a.timeSeed) * t,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

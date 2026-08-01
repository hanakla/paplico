import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_GLITCH_SHADER } from "./hk-glitch.wgsl";

export interface HKGlitchParams {
	intensity: number;
	slices: number;
	colorShift: number;
	angle: number;
	bias: number;
	seed: number;
}
export interface HKGlitchFilter extends Appearance<HKGlitchParams> {
	processor: "hk:glitch";
}

export class HKGlitchHandler implements FilterHandler {
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
			label: "HK Glitch Filter Shader",
			code: HK_GLITCH_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Glitch Bind Group Layout",
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
			label: "HK Glitch Filter Pipeline",
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
		const f = filter as HKGlitchFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKGlitchHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		// The bake may cover only a viewport-clamped sub-rect of the element;
		// anchor the slice pattern to the full element rect (see glitchWorldPos)
		// so the slices stay fixed while zooming or panning.
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
			colorShift: params.colorShift / 100,
			slices: Math.max(1, params.slices),
			angle: params.angle,
			bias: params.bias,
			seed: params.seed,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Glitch Uniform Buffer",
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
			label: "HK Glitch Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Glitch Filter Pass",
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
		[_scaleX, _scaleY]: [number, number],
	): Filter {
		// No need to scale parameters
		return params;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKGlitchFilter["paramData"]["params"];
		const b = paramsB as HKGlitchFilter["paramData"]["params"];
		return {
			intensity: a.intensity + (b.intensity - a.intensity) * t,
			colorShift: a.colorShift + (b.colorShift - a.colorShift) * t,
			slices: Math.round(a.slices + (b.slices - a.slices) * t),
			angle: a.angle + (b.angle - a.angle) * t,
			bias: a.bias + (b.bias - a.bias) * t,
			seed: a.seed, // Seed is not interpolated
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

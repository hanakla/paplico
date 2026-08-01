import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_TURBULENCE_SHADER } from "./hk-turbulence.wgsl";

export interface HKTurbulenceParams {
	scale: number;
	octaves: number;
	seed: number;
	displacementX: number;
	displacementY: number;
	displacementMode: "cartesian" | "radial" | "twist";
	edgeMode: "clamp" | "wrap" | "mirror";
	opacity: number;
}
export interface HKTurbulenceFilter extends Appearance<HKTurbulenceParams> {
	processor: "hk:turbulence";
}

export class HKTurbulenceHandler implements FilterHandler {
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
			label: "HK Turbulence Filter Shader",
			code: HK_TURBULENCE_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Turbulence Bind Group Layout",
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
			label: "HK Turbulence Filter Pipeline",
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
		const f = filter as HKTurbulenceFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKTurbulenceHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		// Map displacement mode string to int
		const modeMap: Record<string, number> = {
			cartesian: 0,
			radial: 1,
			twist: 2,
		};

		const edgeModeMap: Record<string, number> = {
			clamp: 0,
			wrap: 1,
			mirror: 2,
		};

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			scale: params.scale,
			octaves: params.octaves,
			seed: params.seed,
			displacementX: params.displacementX,
			displacementY: params.displacementY,
			displacementMode: modeMap[params.displacementMode] ?? 0,
			edgeMode: edgeModeMap[params.edgeMode] ?? 0,
			opacity: params.opacity,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Turbulence Uniform Buffer",
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
			label: "HK Turbulence Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Turbulence Filter Pass",
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
		const f = filter as HKTurbulenceFilter;
		const params = f.paramData.params;
		return Math.max(params.displacementX, params.displacementY) / 2;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKTurbulenceFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					displacementX: f.paramData.params.displacementX * uniformScale,
					displacementY: f.paramData.params.displacementY * uniformScale,
					scale: f.paramData.params.scale * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKTurbulenceFilter["paramData"]["params"];
		const b = paramsB as HKTurbulenceFilter["paramData"]["params"];
		return {
			scale: a.scale + (b.scale - a.scale) * t,
			octaves: Math.round(a.octaves + (b.octaves - a.octaves) * t),
			seed: a.seed + (b.seed - a.seed) * t,
			displacementX: a.displacementX + (b.displacementX - a.displacementX) * t,
			displacementY: a.displacementY + (b.displacementY - a.displacementY) * t,
			displacementMode: t < 0.5 ? a.displacementMode : b.displacementMode,
			edgeMode: t < 0.5 ? a.edgeMode : b.edgeMode,
			opacity: Math.round(a.opacity + (b.opacity - a.opacity) * t),
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

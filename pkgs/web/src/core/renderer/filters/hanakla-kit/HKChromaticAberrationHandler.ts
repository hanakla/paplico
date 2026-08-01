import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_CHROMATIC_ABERRATION_SHADER } from "./hk-chromatic-aberration.wgsl";

export interface HKChromaticAberrationParams {
	colorMode: "rgb" | "cmyk" | "pastel" | "rc";
	shiftType: "move" | "zoom";
	strength: number;
	angle: number;
	opacity: number;
	blendMode: "over" | "under";
	useFocusPoint: boolean;
	focusPointX: number;
	focusPointY: number;
	focusGradient: number;
}
export interface HKChromaticAberrationFilter
	extends Appearance<HKChromaticAberrationParams> {
	processor: "hk:chromatic-aberration";
}

export class HKChromaticAberrationHandler implements FilterHandler {
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
			label: "HK Chromatic Aberration Filter Shader",
			code: HK_CHROMATIC_ABERRATION_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Chromatic Aberration Bind Group Layout",
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
			label: "HK Chromatic Aberration Filter Pipeline",
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
		const f = filter as HKChromaticAberrationFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKChromaticAberrationHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const colorModeMap: Record<string, number> = {
			rgb: 0,
			cmyk: 1,
			pastel: 2,
			rc: 3,
		};

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			strength: params.strength,
			angle: params.angle,
			colorMode: colorModeMap[params.colorMode] ?? 0,
			opacity: params.opacity,
			blendMode: params.blendMode === "over" ? 0.0 : 1.0,
			useFocusPoint: params.useFocusPoint ? 1.0 : 0.0,
			focusPointX: params.focusPointX,
			focusPointY: params.focusPointY,
			focusGradient: params.focusGradient,
			shiftType: params.shiftType === "move" ? 0.0 : 1.0,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Chromatic Aberration Uniform Buffer",
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
			label: "HK Chromatic Aberration Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Chromatic Aberration Filter Pass",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "HK Chromatic Aberration Filter",
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

	public getExpansionMargin(filter: Filter): number {
		const f = filter as HKChromaticAberrationFilter;
		return f.paramData.params.strength;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKChromaticAberrationFilter;
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
		const a = paramsA as HKChromaticAberrationFilter["paramData"]["params"];
		const b = paramsB as HKChromaticAberrationFilter["paramData"]["params"];
		return {
			colorMode: t < 0.5 ? a.colorMode : b.colorMode,
			shiftType: t < 0.5 ? a.shiftType : b.shiftType,
			strength: a.strength + (b.strength - a.strength) * t,
			angle: a.angle + (b.angle - a.angle) * t,
			opacity: a.opacity + (b.opacity - a.opacity) * t,
			blendMode: t < 0.5 ? a.blendMode : b.blendMode,
			useFocusPoint: t < 0.5 ? a.useFocusPoint : b.useFocusPoint,
			focusPointX: a.focusPointX + (b.focusPointX - a.focusPointX) * t,
			focusPointY: a.focusPointY + (b.focusPointY - a.focusPointY) * t,
			focusGradient: a.focusGradient + (b.focusGradient - a.focusGradient) * t,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_KALEIDOSCOPE_SHADER } from "./hk-kaleidoscope.wgsl";

export interface HKKaleidoscopeParams {
	pattern:
		| "triangular"
		| "square"
		| "hexagonal"
		| "octagonal"
		| "circular"
		| "spiral"
		| "fractal"
		| "composite";
	segments: number;
	rotation: number;
	centerX: number;
	centerY: number;
	zoom: number;
	distortion: number;
	complexity: number;
	colorShift: number;
	cellEffect: number;
	cellSize: number;
	blendMode: "normal" | "kaleidoscope" | "mirror" | "rotational";
	padding: number;
}
export interface HKKaleidoscopeFilter extends Appearance<HKKaleidoscopeParams> {
	processor: "hk:kaleidoscope";
}

const PATTERN_TYPE_MAP: Record<string, number> = {
	triangular: 0,
	square: 1,
	hexagonal: 2,
	octagonal: 3,
	circular: 4,
	spiral: 5,
	fractal: 6,
	composite: 7,
};

const BLEND_MODE_MAP: Record<string, number> = {
	normal: 0,
	kaleidoscope: 1,
	mirror: 2,
	rotational: 3,
};

export class HKKaleidoscopeHandler implements FilterHandler {
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
			label: "HK Kaleidoscope Filter Shader",
			code: HK_KALEIDOSCOPE_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Kaleidoscope Bind Group Layout",
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
			label: "HK Kaleidoscope Filter Pipeline",
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
		const f = filter as HKKaleidoscopeFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKKaleidoscopeHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			patternType: PATTERN_TYPE_MAP[params.pattern] ?? 0,
			segments: params.segments,
			rotation: params.rotation,
			centerX: params.centerX,
			centerY: params.centerY,
			zoom: params.zoom,
			distortion: params.distortion,
			complexity: params.complexity,
			colorShift: params.colorShift,
			cellEffect: params.cellEffect,
			cellSize: params.cellSize,
			blendMode: BLEND_MODE_MAP[params.blendMode] ?? 0,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Kaleidoscope Uniform Buffer",
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
			label: "HK Kaleidoscope Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Kaleidoscope Filter Pass",
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
		const f = filter as HKKaleidoscopeFilter;
		return f.paramData.params.padding;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKKaleidoscopeFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					padding: Math.round(f.paramData.params.padding * uniformScale),
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKKaleidoscopeFilter["paramData"]["params"];
		const b = paramsB as HKKaleidoscopeFilter["paramData"]["params"];
		return {
			pattern: t < 0.5 ? a.pattern : b.pattern,
			segments: Math.round(a.segments + (b.segments - a.segments) * t),
			rotation: a.rotation + (b.rotation - a.rotation) * t,
			centerX: a.centerX + (b.centerX - a.centerX) * t,
			centerY: a.centerY + (b.centerY - a.centerY) * t,
			zoom: a.zoom + (b.zoom - a.zoom) * t,
			distortion: a.distortion + (b.distortion - a.distortion) * t,
			complexity: a.complexity + (b.complexity - a.complexity) * t,
			colorShift: a.colorShift + (b.colorShift - a.colorShift) * t,
			cellEffect: a.cellEffect + (b.cellEffect - a.cellEffect) * t,
			cellSize: a.cellSize + (b.cellSize - a.cellSize) * t,
			blendMode: t < 0.5 ? a.blendMode : b.blendMode,
			padding: Math.round(a.padding + (b.padding - a.padding) * t),
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

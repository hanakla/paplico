import type { StructuredView } from "webgpu-utils";
import {
	type Appearance,
	type ColorStop,
	colorToRawRGBA,
	type Filter,
} from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_GRADIENT_MAP_SHADER } from "./hk-gradient-map.wgsl";

export interface HKGradientMapParams {
	preset: "custom" | "blackAndWhite" | "sepia" | "duotone" | "rainbow";
	colorStops: string;
	strength: number;
}
export interface HKGradientMapFilter extends Appearance<HKGradientMapParams> {
	processor: "hk:gradient-map";
}

const PRESET_INDEX: Record<HKGradientMapParams["preset"], number> = {
	blackAndWhite: 0,
	sepia: 1,
	duotone: 2,
	rainbow: 3,
	custom: 4,
};

/** Must match the WGSL uniform array size. */
const MAX_CUSTOM_STOPS = 16;

/**
 * Preset gradients mirrored from the WGSL builtin presets. The UI writes
 * these into colorStops when a preset is picked; the WGSL builtins remain
 * only as a fallback for documents saved without concrete stops.
 */
export const GRADIENT_MAP_PRESET_STOPS: Record<
	Exclude<HKGradientMapParams["preset"], "custom">,
	ColorStop[]
> = {
	blackAndWhite: [
		{
			offset: 0,
			color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 1,
			color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
			midpoint: 0.5,
		},
	],
	sepia: [
		{
			offset: 0,
			color: { type: "rgb", r: 0.2, g: 0.05, b: 0, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 1,
			color: { type: "rgb", r: 1, g: 0.9, b: 0.7, a: 1 },
			midpoint: 0.5,
		},
	],
	duotone: [
		{
			offset: 0,
			color: { type: "rgb", r: 0.05, g: 0.2, b: 0.6, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 1,
			color: { type: "rgb", r: 1, g: 0.8, b: 0.2, a: 1 },
			midpoint: 0.5,
		},
	],
	rainbow: [
		{
			offset: 0,
			color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 0.2,
			color: { type: "rgb", r: 1, g: 1, b: 0, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 0.4,
			color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 0.6,
			color: { type: "rgb", r: 0, g: 1, b: 1, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 0.8,
			color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 1,
			color: { type: "rgb", r: 1, g: 0, b: 1, a: 1 },
			midpoint: 0.5,
		},
	],
};

export class HKGradientMapHandler implements FilterHandler {
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
			label: "HK Gradient Map Filter Shader",
			code: HK_GRADIENT_MAP_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Gradient Map Bind Group Layout",
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
			label: "HK Gradient Map Filter Pipeline",
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
		const f = filter as HKGradientMapFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKGradientMapHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		// Valid stops always take precedence; the WGSL builtin presets remain
		// only as a fallback for documents saved without concrete stops.
		const customStops = parseCustomStops(params.colorStops);
		const preset =
			customStops.length >= 2
				? PRESET_INDEX.custom
				: params.preset === "custom"
					? PRESET_INDEX.blackAndWhite
					: (PRESET_INDEX[params.preset] ?? 0);

		const stopsData = new Float32Array(MAX_CUSTOM_STOPS * 4);
		customStops.forEach((stop, i) => {
			stopsData.set(stop, i * 4);
		});

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			preset,
			strength: params.strength,
			stopCount: customStops.length,
			stops: stopsData,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Gradient Map Uniform Buffer",
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
			label: "HK Gradient Map Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Gradient Map Filter Pass",
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

	public onScaleFilter(params: Filter, _scale: [number, number]): Filter {
		return params;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKGradientMapFilter["paramData"]["params"];
		const b = paramsB as HKGradientMapFilter["paramData"]["params"];

		if (a.preset !== b.preset) {
			return t < 0.5 ? a : b;
		}

		return {
			preset: t < 0.5 ? a.preset : b.preset,
			colorStops: t < 0.5 ? a.colorStops : b.colorStops,
			strength: a.strength + (b.strength - a.strength) * t,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

/**
 * Parse the colorStops JSON into offset-sorted vec4 entries (rgb + offset),
 * capped at MAX_CUSTOM_STOPS. Returns [] for invalid JSON.
 */
function parseCustomStops(json: string): [number, number, number, number][] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	return parsed
		.filter(isColorStopLike)
		.sort((a, b) => a.offset - b.offset)
		.slice(0, MAX_CUSTOM_STOPS)
		.map((stop) => {
			const c = colorToRawRGBA(stop.color);
			return [c.r, c.g, c.b, stop.offset];
		});
}

function isColorStopLike(value: unknown): value is ColorStop {
	if (typeof value !== "object" || value === null) return false;
	const stop = value as Partial<ColorStop>;
	return typeof stop.offset === "number" && stop.color != null;
}

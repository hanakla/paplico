import type { StructuredView } from "webgpu-utils";
import {
	type Appearance,
	type Color,
	colorToRawRGBA,
	type Filter,
	toRGBColor,
} from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_HALFTONE_SHADER } from "./hk-halftone.wgsl";

export interface HKHalftoneParams {
	size: number;
	angle: number;
	placementPattern: "grid" | "staggered";
	invertDotSize: boolean;
	opaqueOnly: boolean;
	color: Color;
}
export interface HKHalftoneFilter extends Appearance<HKHalftoneParams> {
	processor: "hk:halftone";
}

export class HKHalftoneHandler implements FilterHandler {
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
			label: "HK Halftone Filter Shader",
			code: HK_HALFTONE_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Halftone Bind Group Layout",
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
			label: "HK Halftone Filter Pipeline",
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
		const f = filter as HKHalftoneFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKHalftoneHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const colorRGBA = colorToRawRGBA(params.color);

		// The bake may cover only a viewport-clamped sub-rect of the element;
		// anchor the dot grid to the full element rect (see halftoneWorldPos)
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
			size: params.size,
			angle: params.angle,
			placementPattern: params.placementPattern === "staggered" ? 1.0 : 0.0,
			invertDotSize: params.invertDotSize ? 1.0 : 0.0,
			opaqueOnly: params.opaqueOnly ? 1.0 : 0.0,
			colorR: colorRGBA.r,
			colorG: colorRGBA.g,
			colorB: colorRGBA.b,
			colorA: colorRGBA.a,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Halftone Uniform Buffer",
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
			label: "HK Halftone Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Halftone Filter Pass",
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
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKHalftoneFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					size: f.paramData.params.size * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKHalftoneParams;
		const b = paramsB as HKHalftoneParams;

		const aColor = colorToRawRGBA(a.color);
		const bColor = colorToRawRGBA(b.color);

		return {
			size: a.size + (b.size - a.size) * t,
			angle: a.angle + (b.angle - a.angle) * t,
			placementPattern: t < 0.5 ? a.placementPattern : b.placementPattern,
			invertDotSize: t < 0.5 ? a.invertDotSize : b.invertDotSize,
			opaqueOnly: t < 0.5 ? a.opaqueOnly : b.opaqueOnly,
			color: toRGBColor({
				r: aColor.r + (bColor.r - aColor.r) * t,
				g: aColor.g + (bColor.g - aColor.g) * t,
				b: aColor.b + (bColor.b - aColor.b) * t,
				a: aColor.a + (bColor.a - aColor.a) * t,
			}),
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as HKHalftoneFilter["paramData"]["params"];
		return { ...p, color: adjustColor(p.color) };
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

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
import { JumpFloodDistanceField } from "../JumpFloodDistanceField";
import { HK_OUTLINE_RESOLVE_SHADER } from "./hk-outline.wgsl";

export interface HKOutlineParams {
	thickness: number;
	color: Color;
	opacity: number;
}
export interface HKOutlineFilter extends Appearance<HKOutlineParams> {
	processor: "hk:outline";
}

export class HKOutlineHandler implements FilterHandler {
	private jfa = new JumpFloodDistanceField();
	private resolvePipeline: GPURenderPipeline | null = null;
	private resolveBindGroupLayout: GPUBindGroupLayout | null = null;
	private resolveUniformView: StructuredView | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;
		this.jfa.initialize(device);

		const resolve = compileShaderModule(device, {
			label: "HK Outline Resolve Shader",
			code: HK_OUTLINE_RESOLVE_SHADER,
		});
		this.resolveUniformView = resolve.uniformViews.uniforms;
		this.resolveBindGroupLayout = device.createBindGroupLayout({
			label: "HK Outline Resolve Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "unfilterable-float" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});
		this.resolvePipeline = device.createRenderPipeline({
			label: "HK Outline Resolve Pipeline",
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
	}

	/** Called by FilterRenderer.flushPendingDestroy once per frame, after the
	 *  previous frame's submit — in-flight passes may still reference the old
	 *  JFA textures until then. */
	public flushPendingDestroy(): void {
		this.jfa.flushPendingDestroy();
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKOutlineFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.resolvePipeline ||
			!this.resolveBindGroupLayout ||
			!this.resolveUniformView
		) {
			console.warn("HKOutlineHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		// Rasterization scale: thickness is in world px, the distance field
		// works in texels of the source texture.
		const radius = params.thickness * dpiScale;
		if (radius <= 0) {
			commandEncoder.copyTextureToTexture(
				{ texture: sourceTexture },
				{ texture: targetTexture },
				{ width: textureSize.width, height: textureSize.height },
			);
			return;
		}

		const coordTexture = this.jfa.compute(
			device,
			commandEncoder,
			sourceTexture,
			textureSize.width,
			textureSize.height,
			radius,
			true,
		);
		if (!coordTexture) return;

		// --- Resolve: anti-aliased ring under the original ---
		const colorRGBA = colorToRawRGBA(params.color);
		this.resolveUniformView.set({
			radius,
			colorR: colorRGBA.r,
			colorG: colorRGBA.g,
			colorB: colorRGBA.b,
			colorA: colorRGBA.a,
			opacity: params.opacity,
		});
		const resolveUniformBuffer = device.createBuffer({
			label: "HK Outline Resolve Uniform Buffer",
			size: this.resolveUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			resolveUniformBuffer,
			0,
			this.resolveUniformView.arrayBuffer,
		);

		const resolveBindGroup = device.createBindGroup({
			label: "HK Outline Resolve Bind Group",
			layout: this.resolveBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: resolveUniformBuffer } },
				{ binding: 1, resource: coordTexture.createView() },
				{ binding: 2, resource: sourceTexture.createView() },
			],
		});
		const resolvePass = commandEncoder.beginRenderPass({
			label: "HK Outline Resolve Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		resolvePass.setPipeline(this.resolvePipeline);
		resolvePass.setBindGroup(0, resolveBindGroup);
		resolvePass.draw(3, 1, 0, 0);
		resolvePass.end();
	}

	public getExpansionMargin(filter: Filter): number {
		const f = filter as HKOutlineFilter;
		return f.paramData.params.thickness;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKOutlineFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					thickness: f.paramData.params.thickness * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKOutlineParams;
		const b = paramsB as HKOutlineParams;
		const aColor = colorToRawRGBA(a.color);
		const bColor = colorToRawRGBA(b.color);

		return {
			thickness: a.thickness + (b.thickness - a.thickness) * t,
			color: toRGBColor({
				r: aColor.r + (bColor.r - aColor.r) * t,
				g: aColor.g + (bColor.g - aColor.g) * t,
				b: aColor.b + (bColor.b - aColor.b) * t,
				a: aColor.a + (bColor.a - aColor.a) * t,
			}),
			opacity: Math.round(a.opacity + (b.opacity - a.opacity) * t),
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as HKOutlineFilter["paramData"]["params"];
		return { ...p, color: adjustColor(p.color) };
	}

	public destroy(): void {
		this.jfa.destroy();
		this.resolvePipeline = null;
		this.resolveBindGroupLayout = null;
		this.resolveUniformView = null;
	}
}

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
import {
	HK_KIRAKIRA_HORIZONTAL_SHADER,
	HK_KIRAKIRA_VERTICAL_SHADER,
} from "./hk-kirakira.wgsl";

export interface HKKirakiraParams {
	radius: number;
	strength: number;
	sparkle: number;
	sparkleAlpha: boolean;
	blendOpacity: number;
	makeOriginalTransparent: boolean;
	useCustomColor: boolean;
	customColor: Color;
}
export interface HKKirakiraFilter extends Appearance<HKKirakiraParams> {
	processor: "hk:kirakira";
}

export class HKKirakiraHandler implements FilterHandler {
	private verticalPipeline: GPURenderPipeline | null = null;
	private horizontalPipeline: GPURenderPipeline | null = null;
	private verticalBindGroupLayout: GPUBindGroupLayout | null = null;
	private horizontalBindGroupLayout: GPUBindGroupLayout | null = null;
	private verticalUniformView: StructuredView | null = null;
	private horizontalUniformView: StructuredView | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;

		// Vertical pass: standard 3-binding layout (uniform, texture, sampler)
		this.verticalBindGroupLayout = device.createBindGroupLayout({
			label: "HK Kirakira Vertical Bind Group Layout",
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

		// Horizontal pass: 4-binding layout (uniform, intermediate texture, original texture, sampler)
		this.horizontalBindGroupLayout = device.createBindGroupLayout({
			label: "HK Kirakira Horizontal Bind Group Layout",
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
					texture: { sampleType: "float" },
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		// Vertical pipeline
		const verticalCompiled = compileShaderModule(device, {
			label: "HK Kirakira Vertical Shader",
			code: HK_KIRAKIRA_VERTICAL_SHADER,
		});
		this.verticalUniformView = verticalCompiled.uniformViews.uniforms;

		this.verticalPipeline = device.createRenderPipeline({
			label: "HK Kirakira Vertical Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.verticalBindGroupLayout],
			}),
			vertex: { module: verticalCompiled.module, entryPoint: "vertexMain" },
			fragment: {
				module: verticalCompiled.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		// Horizontal pipeline
		const horizontalCompiled = compileShaderModule(device, {
			label: "HK Kirakira Horizontal Shader",
			code: HK_KIRAKIRA_HORIZONTAL_SHADER,
		});
		this.horizontalUniformView = horizontalCompiled.uniformViews.uniforms;

		this.horizontalPipeline = device.createRenderPipeline({
			label: "HK Kirakira Horizontal Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.horizontalBindGroupLayout],
			}),
			vertex: {
				module: horizontalCompiled.module,
				entryPoint: "vertexMain",
			},
			fragment: {
				module: horizontalCompiled.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	private setUniformValues(
		uniformView: StructuredView,
		params: HKKirakiraParams,
		resolution: [number, number],
		dpiScale: number,
	): void {
		const customRGBA = colorToRawRGBA(params.customColor);

		uniformView.set({
			resolution,
			dpiScale,
			radius: params.radius,
			strength: params.strength,
			sparkle: params.sparkle,
			sparkleAlpha: params.sparkleAlpha ? 1.0 : 0.0,
			blendOpacity: params.blendOpacity,
			makeOriginalTransparent: params.makeOriginalTransparent ? 1.0 : 0.0,
			useCustomColor: params.useCustomColor ? 1.0 : 0.0,
			customColor: [customRGBA.r, customRGBA.g, customRGBA.b, customRGBA.a],
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKKirakiraFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.verticalPipeline ||
			!this.horizontalPipeline ||
			!this.verticalBindGroupLayout ||
			!this.horizontalBindGroupLayout ||
			!this.verticalUniformView ||
			!this.horizontalUniformView
		) {
			console.warn("HKKirakiraHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		// We need to keep the original for the horizontal pass composite.
		// Save original to an intermediate texture.
		const originalCopy = device.createTexture({
			label: "HK Kirakira Original Copy",
			size: [textureSize.width, textureSize.height],
			format: this.canvasFormat,
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC,
		});
		commandEncoder.copyTextureToTexture(
			{ texture: sourceTexture },
			{ texture: originalCopy },
			{ width: textureSize.width, height: textureSize.height },
		);

		// === Pass 1: Vertical blur (source -> target) ===
		this.setUniformValues(
			this.verticalUniformView,
			params,
			[textureSize.width, textureSize.height],
			dpiScale,
		);

		const verticalUniformBuffer = device.createBuffer({
			label: "HK Kirakira Vertical Uniform Buffer",
			size: this.verticalUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			verticalUniformBuffer,
			0,
			this.verticalUniformView.arrayBuffer,
		);

		const verticalBindGroup = device.createBindGroup({
			label: "HK Kirakira Vertical Bind Group",
			layout: this.verticalBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: verticalUniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const verticalPass = commandEncoder.beginRenderPass({
			label: "HK Kirakira Vertical Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		verticalPass.setPipeline(this.verticalPipeline);
		verticalPass.setBindGroup(0, verticalBindGroup);
		verticalPass.draw(3, 1, 0, 0);
		verticalPass.end();

		// Copy vertical result to source for horizontal pass input
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: sourceTexture },
			{ width: textureSize.width, height: textureSize.height },
		);

		// === Pass 2: Horizontal blur + sparkle composite (source + originalCopy -> target) ===
		this.setUniformValues(
			this.horizontalUniformView,
			params,
			[textureSize.width, textureSize.height],
			dpiScale,
		);

		const horizontalUniformBuffer = device.createBuffer({
			label: "HK Kirakira Horizontal Uniform Buffer",
			size: this.horizontalUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			horizontalUniformBuffer,
			0,
			this.horizontalUniformView.arrayBuffer,
		);

		const horizontalBindGroup = device.createBindGroup({
			label: "HK Kirakira Horizontal Bind Group",
			layout: this.horizontalBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: horizontalUniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: originalCopy.createView() },
				{ binding: 3, resource: sampler },
			],
		});

		const horizontalPass = commandEncoder.beginRenderPass({
			label: "HK Kirakira Horizontal Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		horizontalPass.setPipeline(this.horizontalPipeline);
		horizontalPass.setBindGroup(0, horizontalBindGroup);
		horizontalPass.draw(3, 1, 0, 0);
		horizontalPass.end();

		// Note: originalCopy is NOT destroyed here because the commandEncoder
		// has not been submitted yet. The texture will be GC'd after submit.
	}

	public getExpansionMargin(filter: Filter): number {
		return ((filter as HKKirakiraFilter).paramData.params.radius ?? 0) / 2;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKKirakiraFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					radius: f.paramData.params.radius * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKKirakiraParams;
		const b = paramsB as HKKirakiraParams;

		const aCustom = colorToRawRGBA(a.customColor);
		const bCustom = colorToRawRGBA(b.customColor);

		return {
			radius: Math.round(a.radius + (b.radius - a.radius) * t),
			strength: a.strength + (b.strength - a.strength) * t,
			sparkle: a.sparkle + (b.sparkle - a.sparkle) * t,
			sparkleAlpha: t < 0.5 ? a.sparkleAlpha : b.sparkleAlpha,
			blendOpacity: a.blendOpacity + (b.blendOpacity - a.blendOpacity) * t,
			makeOriginalTransparent:
				t < 0.5 ? a.makeOriginalTransparent : b.makeOriginalTransparent,
			useCustomColor: t < 0.5 ? a.useCustomColor : b.useCustomColor,
			customColor: toRGBColor({
				r: aCustom.r + (bCustom.r - aCustom.r) * t,
				g: aCustom.g + (bCustom.g - aCustom.g) * t,
				b: aCustom.b + (bCustom.b - aCustom.b) * t,
				a: aCustom.a + (bCustom.a - aCustom.a) * t,
			}),
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as HKKirakiraFilter["paramData"]["params"];
		if (!p.useCustomColor) return params;
		return { ...p, customColor: adjustColor(p.customColor) };
	}

	public destroy(): void {
		this.verticalPipeline = null;
		this.horizontalPipeline = null;
		this.verticalBindGroupLayout = null;
		this.horizontalBindGroupLayout = null;
		this.verticalUniformView = null;
		this.horizontalUniformView = null;
	}
}

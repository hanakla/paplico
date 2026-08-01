import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import {
	HK_BLOOM_BLUR_SHADER,
	HK_BLOOM_COMPOSITE_SHADER,
	HK_BLOOM_EXTRACT_SHADER,
} from "./hk-bloom.wgsl";

export interface HKBloomParams {
	threshold: number;
	intensity: number;
	radius: number;
	blurStrength: number;
	blendMode: "normal" | "overlay";
}
export interface HKBloomFilter extends Appearance<HKBloomParams> {
	processor: "hk:bloom";
}

export class HKBloomHandler implements FilterHandler {
	private extractPipeline: GPURenderPipeline | null = null;
	private blurPipeline: GPURenderPipeline | null = null;
	private compositePipeline: GPURenderPipeline | null = null;

	private extractBindGroupLayout: GPUBindGroupLayout | null = null;
	private blurBindGroupLayout: GPUBindGroupLayout | null = null;
	private compositeBindGroupLayout: GPUBindGroupLayout | null = null;

	private extractUniformView: StructuredView | null = null;
	private blurUniformView: StructuredView | null = null;
	private compositeUniformView: StructuredView | null = null;

	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;

		// Standard 3-binding layout for extract and blur
		const standardBindGroupLayout = device.createBindGroupLayout({
			label: "HK Bloom Standard Bind Group Layout",
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

		// Composite layout: uniform + original texture + bloom texture + sampler
		const compositeBindGroupLayout = device.createBindGroupLayout({
			label: "HK Bloom Composite Bind Group Layout",
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

		// Extract pipeline
		const extractCompiled = compileShaderModule(device, {
			label: "HK Bloom Extract Shader",
			code: HK_BLOOM_EXTRACT_SHADER,
		});
		this.extractUniformView = extractCompiled.uniformViews.uniforms;
		this.extractBindGroupLayout = standardBindGroupLayout;
		this.extractPipeline = device.createRenderPipeline({
			label: "HK Bloom Extract Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [standardBindGroupLayout],
			}),
			vertex: { module: extractCompiled.module, entryPoint: "vertexMain" },
			fragment: {
				module: extractCompiled.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		// Blur pipeline
		const blurCompiled = compileShaderModule(device, {
			label: "HK Bloom Blur Shader",
			code: HK_BLOOM_BLUR_SHADER,
		});
		this.blurUniformView = blurCompiled.uniformViews.uniforms;
		this.blurBindGroupLayout = standardBindGroupLayout;
		this.blurPipeline = device.createRenderPipeline({
			label: "HK Bloom Blur Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [standardBindGroupLayout],
			}),
			vertex: { module: blurCompiled.module, entryPoint: "vertexMain" },
			fragment: {
				module: blurCompiled.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		// Composite pipeline
		const compositeCompiled = compileShaderModule(device, {
			label: "HK Bloom Composite Shader",
			code: HK_BLOOM_COMPOSITE_SHADER,
		});
		this.compositeUniformView = compositeCompiled.uniformViews.uniforms;
		this.compositeBindGroupLayout = compositeBindGroupLayout;
		this.compositePipeline = device.createRenderPipeline({
			label: "HK Bloom Composite Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [compositeBindGroupLayout],
			}),
			vertex: {
				module: compositeCompiled.module,
				entryPoint: "vertexMain",
			},
			fragment: {
				module: compositeCompiled.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKBloomFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.extractPipeline ||
			!this.blurPipeline ||
			!this.compositePipeline ||
			!this.extractBindGroupLayout ||
			!this.blurBindGroupLayout ||
			!this.compositeBindGroupLayout ||
			!this.extractUniformView ||
			!this.blurUniformView ||
			!this.compositeUniformView
		) {
			console.warn("HKBloomHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const scaledRadius = params.radius * dpiScale;

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		// === Pass 1: Extract bright areas (source -> target) ===
		this.extractUniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			threshold: params.threshold,
		});

		const extractUniformBuffer = device.createBuffer({
			label: "HK Bloom Extract Uniform Buffer",
			size: this.extractUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			extractUniformBuffer,
			0,
			this.extractUniformView.arrayBuffer,
		);

		const extractBindGroup = device.createBindGroup({
			label: "HK Bloom Extract Bind Group",
			layout: this.extractBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: extractUniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const extractPass = commandEncoder.beginRenderPass({
			label: "HK Bloom Extract Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		extractPass.setPipeline(this.extractPipeline);
		extractPass.setBindGroup(0, extractBindGroup);
		extractPass.draw(3, 1, 0, 0);
		extractPass.end();

		// We need to keep the original sourceTexture for the composite step.
		// Copy the extracted result (in targetTexture) back to sourceTexture
		// for the blur input, but we need sourceTexture for the final composite.
		// Strategy: use target for extract output, copy to source for blur input,
		// blur writes to target, copy target back to source for 2nd blur,
		// then composite reads original (we need a copy of original first).

		// Save original to a temporary location by swapping:
		// After extract: target = extracted bright, source = original
		// We'll blur from target. But we need source untouched for composite.
		// So: copy source -> we can't create new textures here easily.

		// Better approach: use the two-texture ping-pong.
		// After extract pass: target has extracted bright areas.
		// Copy target to source (source now has extracted bright areas, original is lost from source).
		// But we need original for composite. Since postProcess only gets source+target,
		// we copy original first before extract.

		// Actually, let's re-examine: before this method, sourceTexture has the original.
		// We can copy original from sourceTexture somewhere first.

		// Simplest approach matching the existing pattern:
		// 1. Extract: source(original) -> target(extracted)
		// 2. Copy target -> source (source = extracted)
		// 3. Blur H: source(extracted) -> target(blurred-h)
		// 4. Copy target -> source (source = blurred-h)
		// 5. Blur V: source(blurred-h) -> target(blurred)
		// 6. Now we need original + blurred for composite.
		//    Copy blurred(target) -> source. Then composite needs original...
		//    We don't have original anymore.

		// Solution: Do composite using source(original) before we overwrite it.
		// Reorder: keep original in source as long as possible.

		// Alternative: extract into target, then do blur passes ping-ponging,
		// then for composite, we already lost the original.

		// The live-effects compute version keeps original in a separate texture.
		// In the render pipeline, we only have source+target.
		// We need to create an intermediate texture for the bloom buffer.

		// Create intermediate texture for bloom processing
		const bloomTexture = device.createTexture({
			label: "HK Bloom Intermediate Texture",
			size: [textureSize.width, textureSize.height],
			format: this.canvasFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
		});

		// Copy extracted result from target to bloomTexture for blur input
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: bloomTexture },
			{ width: textureSize.width, height: textureSize.height },
		);

		// === Pass 2: Horizontal blur (bloomTexture -> target) ===
		this.blurUniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			radius: scaledRadius,
			blurStrength: params.blurStrength,
			direction: [1.0, 0.0],
		});

		const blurHUniformBuffer = device.createBuffer({
			label: "HK Bloom Blur H Uniform Buffer",
			size: this.blurUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			blurHUniformBuffer,
			0,
			this.blurUniformView.arrayBuffer,
		);

		const blurHBindGroup = device.createBindGroup({
			label: "HK Bloom Blur H Bind Group",
			layout: this.blurBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: blurHUniformBuffer } },
				{ binding: 1, resource: bloomTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const blurHPass = commandEncoder.beginRenderPass({
			label: "HK Bloom Blur Horizontal Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		blurHPass.setPipeline(this.blurPipeline);
		blurHPass.setBindGroup(0, blurHBindGroup);
		blurHPass.draw(3, 1, 0, 0);
		blurHPass.end();

		// Copy horizontal blur result to bloomTexture for vertical blur input
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: bloomTexture },
			{ width: textureSize.width, height: textureSize.height },
		);

		// === Pass 3: Vertical blur (bloomTexture -> target) ===
		this.blurUniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			radius: scaledRadius,
			blurStrength: params.blurStrength,
			direction: [0.0, 1.0],
		});

		const blurVUniformBuffer = device.createBuffer({
			label: "HK Bloom Blur V Uniform Buffer",
			size: this.blurUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			blurVUniformBuffer,
			0,
			this.blurUniformView.arrayBuffer,
		);

		const blurVBindGroup = device.createBindGroup({
			label: "HK Bloom Blur V Bind Group",
			layout: this.blurBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: blurVUniformBuffer } },
				{ binding: 1, resource: bloomTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const blurVPass = commandEncoder.beginRenderPass({
			label: "HK Bloom Blur Vertical Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		blurVPass.setPipeline(this.blurPipeline);
		blurVPass.setBindGroup(0, blurVBindGroup);
		blurVPass.draw(3, 1, 0, 0);
		blurVPass.end();

		// Now target has blurred bloom, source still has original.
		// Copy blurred bloom to bloomTexture for composite input
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: bloomTexture },
			{ width: textureSize.width, height: textureSize.height },
		);

		// === Pass 4: Composite (source=original + bloomTexture=blurred -> target) ===
		this.compositeUniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			intensity: params.intensity,
			blendMode: params.blendMode === "overlay" ? 1.0 : 0.0,
		});

		const compositeUniformBuffer = device.createBuffer({
			label: "HK Bloom Composite Uniform Buffer",
			size: this.compositeUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			compositeUniformBuffer,
			0,
			this.compositeUniformView.arrayBuffer,
		);

		const compositeBindGroup = device.createBindGroup({
			label: "HK Bloom Composite Bind Group",
			layout: this.compositeBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: compositeUniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: bloomTexture.createView() },
				{ binding: 3, resource: sampler },
			],
		});

		const compositePass = commandEncoder.beginRenderPass({
			label: "HK Bloom Composite Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		compositePass.setPipeline(this.compositePipeline);
		compositePass.setBindGroup(0, compositeBindGroup);
		compositePass.draw(3, 1, 0, 0);
		compositePass.end();

		// Note: bloomTexture is NOT destroyed here because the commandEncoder
		// has not been submitted yet. The texture will be GC'd after submit.
	}

	public getExpansionMargin(filter: Filter): number {
		return ((filter as HKBloomFilter).paramData.params.radius ?? 0) * 3;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKBloomFilter;
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
		const a = paramsA as HKBloomFilter["paramData"]["params"];
		const b = paramsB as HKBloomFilter["paramData"]["params"];
		return {
			threshold: a.threshold + (b.threshold - a.threshold) * t,
			intensity: a.intensity + (b.intensity - a.intensity) * t,
			radius: a.radius + (b.radius - a.radius) * t,
			blurStrength: a.blurStrength + (b.blurStrength - a.blurStrength) * t,
			blendMode: t < 0.5 ? a.blendMode : b.blendMode,
		};
	}

	public destroy(): void {
		this.extractPipeline = null;
		this.blurPipeline = null;
		this.compositePipeline = null;
		this.extractBindGroupLayout = null;
		this.blurBindGroupLayout = null;
		this.compositeBindGroupLayout = null;
		this.extractUniformView = null;
		this.blurUniformView = null;
		this.compositeUniformView = null;
	}
}

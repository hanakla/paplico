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
import { HK_INNER_GLOW_RESOLVE_SHADER } from "./hk-inner-glow.wgsl";

export interface HKInnerGlowParams {
	glowType: "inner" | "outer";
	weight: number;
	glowColor: Color;
}
export interface HKInnerGlowFilter extends Appearance<HKInnerGlowParams> {
	processor: "hk:inner-glow";
}

export class HKInnerGlowHandler implements FilterHandler {
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
			label: "HK Inner Glow Resolve Shader",
			code: HK_INNER_GLOW_RESOLVE_SHADER,
		});
		this.resolveUniformView = resolve.uniformViews.uniforms;
		this.resolveBindGroupLayout = device.createBindGroupLayout({
			label: "HK Inner Glow Resolve Bind Group Layout",
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
			label: "HK Inner Glow Resolve Pipeline",
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
		const f = filter as HKInnerGlowFilter;
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
			console.warn("HKInnerGlowHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		// Rasterization scale: weight is in world px, the distance field
		// works in texels of the source texture.
		const radius = params.weight * dpiScale;
		if (radius <= 0) {
			commandEncoder.copyTextureToTexture(
				{ texture: sourceTexture },
				{ texture: targetTexture },
				{ width: textureSize.width, height: textureSize.height },
			);
			return;
		}

		// Inner glow measures the distance to the background (erosion field),
		// outer glow the distance to the silhouette.
		const isInner = params.glowType === "inner";
		const coordTexture = this.jfa.compute(
			device,
			commandEncoder,
			sourceTexture,
			textureSize.width,
			textureSize.height,
			radius,
			!isInner,
		);
		if (!coordTexture) return;

		// --- Resolve: glow falloff composited with the original ---
		const glowRGBA = colorToRawRGBA(params.glowColor);
		this.resolveUniformView.set({
			radius,
			glowType: isInner ? 0.0 : 1.0,
			colorR: glowRGBA.r,
			colorG: glowRGBA.g,
			colorB: glowRGBA.b,
			colorA: glowRGBA.a,
		});
		const resolveUniformBuffer = device.createBuffer({
			label: "HK Inner Glow Resolve Uniform Buffer",
			size: this.resolveUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			resolveUniformBuffer,
			0,
			this.resolveUniformView.arrayBuffer,
		);

		const resolveBindGroup = device.createBindGroup({
			label: "HK Inner Glow Resolve Bind Group",
			layout: this.resolveBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: resolveUniformBuffer } },
				{ binding: 1, resource: coordTexture.createView() },
				{ binding: 2, resource: sourceTexture.createView() },
			],
		});
		const resolvePass = commandEncoder.beginRenderPass({
			label: "HK Inner Glow Resolve Pass",
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
		const f = filter as HKInnerGlowFilter;
		// The inner glow never leaves the silhouette, but the distance field
		// still needs a transparent ring around content that fills its bounds
		// edge-to-edge — without background texels there are no seeds at all.
		return f.paramData.params.glowType === "outer"
			? f.paramData.params.weight
			: 2;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKInnerGlowFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					weight: f.paramData.params.weight * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKInnerGlowParams;
		const b = paramsB as HKInnerGlowParams;
		const aGlow = colorToRawRGBA(a.glowColor);
		const bGlow = colorToRawRGBA(b.glowColor);

		return {
			glowType: t < 0.5 ? a.glowType : b.glowType,
			weight: a.weight + (b.weight - a.weight) * t,
			glowColor: toRGBColor({
				r: aGlow.r + (bGlow.r - aGlow.r) * t,
				g: aGlow.g + (bGlow.g - aGlow.g) * t,
				b: aGlow.b + (bGlow.b - aGlow.b) * t,
				a: aGlow.a + (bGlow.a - aGlow.a) * t,
			}),
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as HKInnerGlowFilter["paramData"]["params"];
		return { ...p, glowColor: adjustColor(p.glowColor) };
	}

	public destroy(): void {
		this.jfa.destroy();
		this.resolvePipeline = null;
		this.resolveBindGroupLayout = null;
		this.resolveUniformView = null;
	}
}

/**
 * FrostGlass Filter Processor
 * Implements frosted glass effect with blur, saturation adjustment, and tint.
 *
 * Backdrop mask is applied by FilterRenderer after all filter passes.
 */

import type { StructuredView } from "webgpu-utils";
import {
	type Appearance,
	type Color,
	colorToRawRGBA,
	type Filter,
	toRGBColor,
} from "../../schema";
import { lerpOptionalRGBColor, lerpOptionalScalar } from "../../utils/color";
import { compileShaderModule } from "../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../canvas/pipeline/FilterRenderer";
import { FrameUniformPool } from "../canvas/pipeline/FrameUniformPool";
import {
	FROST_GLASS_PYRAMID_SHADER,
	FROST_GLASS_SHADER,
} from "./frostGlass.wgsl";

/** Texel cap of the fallback blur kernel (GPU safety bound). */
const MAX_BLUR_RADIUS_TEXELS = 300;

export interface FrostGlassParams {
	radius: number; // 0.0~100.0 (blur radius in pixels)
	tint?: Color; // Optional color tint overlay
	tintOpacity?: number; // 0.0~1.0 (how much the tint shows)
	saturation?: number; // 0.0~2.0 (1.0 = normal, <1 = desaturated, >1 = saturated)
	scatter?: number; // 0+ world px of random backdrop displacement (frosted grain)
	scatterGrain?: number; // world px block size of the scatter pattern
}

export interface FrostGlassFilter extends Appearance<FrostGlassParams> {
	processor: "frost-glass";
}

export class FrostGlassFilterProcessor implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private uniformPoolH: FrameUniformPool | null = null;
	private uniformPoolV: FrameUniformPool | null = null;
	// Shared-pyramid path: one pass lerping two pre-blurred batch levels.
	// Uniform buffers pool per postProcess call (several frost glass elements
	// can run inside one submit, so a shared buffer would cross-talk).
	private pyramidPipeline: GPURenderPipeline | null = null;
	private pyramidBindGroupLayout: GPUBindGroupLayout | null = null;
	private pyramidUniformView: StructuredView | null = null;
	private pyramidUniformPool: FrameUniformPool | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	// No getRenderConfigure: frost glass runs on the element's own raster by
	// default and rides the common Appearance.applyToBackdrop flag to blur
	// what's behind the element instead (resolveRenderConfigure forces the
	// backdrop route). postProcess only reads sourceTexture, so both routes
	// share the same pass chain.

	/** Blur sigma in capture texels, mirroring the fallback shader's kernel
	 *  (sigma = radius / 2, radius capped at 300 texels) so the shared
	 *  pyramid reproduces the same blur strength. Zero when scattering: the
	 *  grain must be displaced BEFORE the blur softens it, which the
	 *  pre-blurred pyramid cannot reproduce, so those filters keep the
	 *  self-contained blur. */
	public getBackdropBlurSigma(filter: Filter, rasterScale: number): number {
		const p = (filter as FrostGlassFilter).paramData.params;
		if ((p.scatter ?? 0) > 0) return 0;
		return Math.min(p.radius * rasterScale, MAX_BLUR_RADIUS_TEXELS) / 2;
	}

	public startFrame(): void {
		this.uniformPoolH?.beginFrame();
		this.uniformPoolV?.beginFrame();
		this.pyramidUniformPool?.beginFrame();
	}

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;
		const { module, uniformViews } = compileShaderModule(device, {
			label: "FrostGlass Filter Shader",
			code: FROST_GLASS_SHADER,
		});

		this.uniformView = uniformViews.uniforms;
		this.uniformPoolH = new FrameUniformPool(
			device,
			"FrostGlass Uniform Buffer (Horizontal)",
		);
		this.uniformPoolV = new FrameUniformPool(
			device,
			"FrostGlass Uniform Buffer (Vertical)",
		);
		this.pyramidUniformPool = new FrameUniformPool(
			device,
			"FrostGlass Pyramid Uniform Buffer",
		);

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "FrostGlass Bind Group Layout",
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
			label: "FrostGlass Filter Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: {
				module,
				entryPoint: "vertexMain",
			},
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: {
				topology: "triangle-list",
			},
		});

		const { module: pyramidModule, uniformViews: pyramidUniformViews } =
			compileShaderModule(device, {
				label: "FrostGlass Pyramid Shader",
				code: FROST_GLASS_PYRAMID_SHADER,
			});
		this.pyramidUniformView = pyramidUniformViews.uniforms;
		this.pyramidBindGroupLayout = device.createBindGroupLayout({
			label: "FrostGlass Pyramid Bind Group Layout",
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
		this.pyramidPipeline = device.createRenderPipeline({
			label: "FrostGlass Pyramid Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.pyramidBindGroupLayout],
			}),
			vertex: { module: pyramidModule, entryPoint: "vertexMain" },
			fragment: {
				module: pyramidModule,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		if (filter.processor !== "frost-glass") {
			throw new Error(
				"FrostGlassFilterProcessor can only process frost-glass filters",
			);
		}

		const frostFilter = filter as FrostGlassFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.pipeline ||
			!this.bindGroupLayout ||
			!this.uniformView ||
			!this.uniformPoolH ||
			!this.uniformPoolV
		) {
			console.warn("FrostGlassFilterProcessor not initialized");
			return;
		}

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		// Extract filter parameters with defaults.
		// sceneInfo.dpiScale is texels per world px of the source texture. The
		// backdrop is captured at the fixed rasterization scale R, so radius
		// (world px) scales by R here and the blur is invariant to viewport zoom.
		const fp = frostFilter.paramData.params;
		const radius = fp.radius * dpiScale;
		// Scatter stays in world px; the shader converts via the dpiScale uniform
		// so the grain pattern is anchored to world-px cells.
		const scatter = fp.scatter ?? 0;
		const scatterGrain = Math.max(fp.scatterGrain ?? 1, 1);
		const sourceOffset = context.coordinateSpace?.sourceOffset ?? {
			x: 0,
			y: 0,
		};
		const saturation = fp.saturation ?? 1.0;
		const tintRGBA = fp.tint ? colorToRawRGBA(fp.tint) : null;
		const tintR = tintRGBA?.r ?? 1.0;
		const tintG = tintRGBA?.g ?? 1.0;
		const tintB = tintRGBA?.b ?? 1.0;
		const tintOpacity = fp.tintOpacity ?? 0.0;

		// Shared-pyramid path: the coordinator already blurred the batch
		// capture, so one pass lerps the two levels bracketing this filter's
		// sigma and applies saturation/tint. Falls through to the
		// self-contained separable blur when no pyramid is available or when
		// scatter needs the displace-before-blur order.
		const pyramidSigma = this.getBackdropBlurSigma(filter, dpiScale);
		const pyramid =
			pyramidSigma > 0 ? context.backdropBlur?.(pyramidSigma) : null;
		if (
			pyramid &&
			this.pyramidPipeline &&
			this.pyramidBindGroupLayout &&
			this.pyramidUniformView
		) {
			this.pyramidUniformView.set({
				remap: pyramid.remap,
				loCtl: pyramid.blurLoCtl,
				hiCtl: pyramid.blurHiCtl,
				blurMix: pyramid.blurMix,
				saturation,
				tintR,
				tintG,
				tintB,
				tintOpacity,
			});
			const uniformBuffer = this.pyramidUniformPool!.write(
				this.pyramidUniformView.arrayBuffer,
			);

			const bindGroup = device.createBindGroup({
				label: "FrostGlass Pyramid Bind Group",
				layout: this.pyramidBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: pyramid.blurLo.createView() },
					{ binding: 2, resource: pyramid.blurHi.createView() },
					{ binding: 3, resource: sampler },
				],
			});

			const pass = commandEncoder.beginRenderPass({
				label: "FrostGlass Pyramid Pass",
				timestampWrites: context.profiler?.timestampWrites(
					context.timingLabel ?? "FrostGlass Filter",
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
			pass.setPipeline(this.pyramidPipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3, 1, 0, 0);
			pass.end();
			return;
		}

		// Two-pass separable Gaussian blur: horizontal then vertical

		// === Pass 1: Horizontal blur (source -> target) ===
		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			sourceOffset: [sourceOffset.x, sourceOffset.y],
			direction: [1.0, 0.0],
			radius,
			saturation,
			tintR,
			tintG,
			tintB,
			tintOpacity,
			applyEffects: 0.0,
			scatter,
			scatterGrain,
			applyScatter: 1.0,
			dpiScale,
		});

		const uniformBufferH = this.uniformPoolH.write(
			this.uniformView.arrayBuffer,
		);

		const horizontalBindGroup = device.createBindGroup({
			label: "FrostGlass Bind Group (Horizontal)",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBufferH } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const horizontalPass = commandEncoder.beginRenderPass({
			label: "FrostGlass Filter Pass (Horizontal)",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "FrostGlass Filter",
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

		horizontalPass.setPipeline(this.pipeline);
		horizontalPass.setBindGroup(0, horizontalBindGroup);
		horizontalPass.draw(3, 1, 0, 0);
		horizontalPass.end();

		// Copy horizontal result to source for vertical pass input
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: sourceTexture },
			{ width: textureSize.width, height: textureSize.height },
		);

		// === Pass 2: Vertical blur with saturation/tint ===
		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			sourceOffset: [sourceOffset.x, sourceOffset.y],
			direction: [0.0, 1.0],
			radius,
			saturation,
			tintR,
			tintG,
			tintB,
			tintOpacity,
			applyEffects: 1.0,
			scatter,
			scatterGrain,
			applyScatter: 0.0,
			dpiScale,
		});

		const uniformBufferV = this.uniformPoolV.write(
			this.uniformView.arrayBuffer,
		);

		const verticalBindGroup = device.createBindGroup({
			label: "FrostGlass Bind Group (Vertical)",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBufferV } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const verticalPass = commandEncoder.beginRenderPass({
			label: "FrostGlass Filter Pass (Vertical)",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "FrostGlass Filter",
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

		verticalPass.setPipeline(this.pipeline);
		verticalPass.setBindGroup(0, verticalBindGroup);
		verticalPass.draw(3, 1, 0, 0);
		verticalPass.end();
	}

	public getExpansionMargin(filter: Filter): number {
		// On the backdrop route the effect fills the element shape, so the
		// element raster needs no headroom. On the element route the blur and
		// scatter spread content up to radius + scatter world px outward.
		if (filter.applyToBackdrop) return 0;
		const p = (filter as FrostGlassFilter).paramData.params;
		return p.radius + (p.scatter ?? 0);
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as FrostGlassFilter;
		const p = f.paramData.params;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...p,
					radius: p.radius * uniformScale,
					...(p.scatter != null && { scatter: p.scatter * uniformScale }),
					...(p.scatterGrain != null && {
						scatterGrain: p.scatterGrain * uniformScale,
					}),
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		return interpolateFrostGlassParams(
			paramsA as FrostGlassFilter["paramData"]["params"],
			paramsB as FrostGlassFilter["paramData"]["params"],
			t,
		);
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as FrostGlassFilter["paramData"]["params"];
		if (!p.tint) return params;
		return { ...p, tint: adjustColor(p.tint) };
	}

	public destroy(): void {
		this.uniformPoolH?.destroy();
		this.uniformPoolH = null;
		this.uniformPoolV?.destroy();
		this.uniformPoolV = null;
		this.pyramidUniformPool?.destroy();
		this.pyramidUniformPool = null;
		this.pyramidPipeline = null;
		this.pyramidBindGroupLayout = null;
		this.pyramidUniformView = null;
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}

function interpolateFrostGlassParams(
	a: FrostGlassFilter["paramData"]["params"],
	b: FrostGlassFilter["paramData"]["params"],
	t: number,
): FrostGlassFilter["paramData"]["params"] {
	return {
		radius: a.radius + (b.radius - a.radius) * t,
		tint: lerpOptionalRGBColor(
			a.tint ? toRGBColor(colorToRawRGBA(a.tint)) : undefined,
			b.tint ? toRGBColor(colorToRawRGBA(b.tint)) : undefined,
			t,
		),
		tintOpacity: lerpOptionalScalar(a.tintOpacity, b.tintOpacity, t, 0),
		saturation: lerpOptionalScalar(a.saturation, b.saturation, t, 1),
		scatter: lerpOptionalScalar(a.scatter, b.scatter, t, 0),
		scatterGrain: lerpOptionalScalar(a.scatterGrain, b.scatterGrain, t, 1),
	};
}

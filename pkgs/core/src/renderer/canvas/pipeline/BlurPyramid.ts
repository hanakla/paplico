import {
	compileShaderModule,
	type StructuredView,
} from "../../../utils/wgpu-utils";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import { createFullscreenPipeline } from "../../PipelineFactory";
import {
	BLUR_PYRAMID_FUSED_SHADER,
	BLUR_PYRAMID_SHADER,
} from "../../shaders/blurPyramid.wgsl";
import { FrameUniformPool } from "./FrameUniformPool";

/** Per-texture sampling control: xy = used-area uv scale (used / quantized
 *  texture size), zw = half texel of the used region in region uv — the
 *  shader clamps region uv into [zw, 1-zw] then multiplies by xy. */
export type BlurTextureCtl = readonly [number, number, number, number];

/** One built pyramid level: the halved-and-blurred result plus the horizontal
 *  intermediate it came from (retained so a dirty region can be patched
 *  without rebuilding the whole separable chain). */
export interface BlurPyramidLevel {
	intermediate: GPUTexture;
	texture: GPUTexture;
	ctl: BlurTextureCtl;
	/** Used region size in px (halved per level from the source size). */
	usedWidth: number;
	usedHeight: number;
}

/** A rectangle of texels, in a level's own pixel coordinates. */
interface BlurPixelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Gaussian sigma each pyramid pass applies, in its SOURCE level's texels. */
export const PYRAMID_PASS_SIGMA = 2.0;
/** Max pyramid depth. σ_eff(7) ≈ 148 level-0 texels — covers frost glass's
 *  σ cap of 150 (radius cap 300 / 2); glass extrude's 48-texel kernel cap
 *  only ever needs 6 levels. */
export const MAX_PYRAMID_LEVELS = 7;
export const PYRAMID_KERNEL_RADIUS = Math.ceil(PYRAMID_PASS_SIGMA * 3);

/**
 * Cumulative effective blur variance at pyramid level k (in level-0 texels²).
 * Level i blurs σ = PYRAMID_PASS_SIGMA in level-(i-1) texels = σ·2^(i-1)
 * level-0 texels per axis; independent Gaussian passes add variances:
 * Σ_{i=1..k} (2·2^(i-1))² = (4^(k+1) − 4) / 3.
 */
export function pyramidLevelVariance(level: number): number {
	return (4 ** (level + 1) - 4) / 3;
}

/** Pyramid depth needed to cover `maxSigma` (source texels), capped. */
export function requiredPyramidLevels(maxSigma: number): number {
	if (!(maxSigma > 0)) return 0;
	const targetVariance = maxSigma * maxSigma;
	for (let level = 1; level <= MAX_PYRAMID_LEVELS; level++) {
		if (pyramidLevelVariance(level) >= targetVariance) return level;
	}
	return MAX_PYRAMID_LEVELS;
}

/**
 * The two pyramid levels bracketing `sigma` and their lerp factor,
 * interpolated in variance space (level 0 = the unblurred source).
 */
export function selectPyramidLevels(
	sigma: number,
	levelCount: number,
): { lo: number; hi: number; mix: number } {
	if (!(sigma > 0) || levelCount === 0) return { lo: 0, hi: 0, mix: 0 };
	const targetVariance = sigma * sigma;
	let lo = 0;
	while (lo < levelCount && pyramidLevelVariance(lo + 1) <= targetVariance) {
		lo++;
	}
	if (lo === levelCount) return { lo, hi: lo, mix: 0 };
	const hi = lo + 1;
	const loVariance = pyramidLevelVariance(lo);
	const hiVariance = pyramidLevelVariance(hi);
	return {
		lo,
		hi,
		mix: Math.min(
			1,
			Math.max(0, (targetVariance - loVariance) / (hiVariance - loVariance)),
		),
	};
}

/** Sampling ctl for a texture whose used region is (width, height). */
export function blurTextureCtl(
	width: number,
	height: number,
	texture: GPUTexture,
): BlurTextureCtl {
	return [
		width / texture.width,
		height / texture.height,
		0.5 / width,
		0.5 / height,
	];
}

/**
 * Builds calibrated Gaussian blur pyramids over an arbitrary texture.
 *
 * Owns only the WGSL pipelines, the sampler, and a per-frame uniform-buffer
 * pool. It knows nothing about backdrops: capture, dirty-region bookkeeping
 * and z-order stay with the caller (BackdropEffectCoordinator), while a
 * filter that just needs a wide blur of its own texture (drop shadow) reuses
 * the same passes and the same variance calibration instead of a
 * radius-proportional direct kernel.
 *
 * Level textures come from the caller-supplied `acquireTexture` so each owner
 * keeps its own allocation and release policy (frame pool vs. cross-frame
 * cache).
 */
export class BlurPyramidBuilder {
	private pipeline: GPURenderPipeline | null = null;
	private fusedPipeline: GPURenderPipeline | null = null;
	private pipelineFormat: GPUTextureFormat | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private sampler: GPUSampler | null = null;
	private uniforms: StructuredView | null = null;
	private readonly uniformPool: FrameUniformPool;

	public constructor(
		private readonly device: GPUDevice,
		/** Allocate a level texture (RENDER_ATTACHMENT | TEXTURE_BINDING). The
		 *  caller owns its lifetime — the builder never releases it. */
		private readonly acquireTexture: (
			width: number,
			height: number,
			format: GPUTextureFormat,
		) => GPUTexture,
	) {
		this.uniformPool = new FrameUniformPool(device, "Blur Pyramid Uniforms");
	}

	/** Reset the per-frame uniform-buffer pool. */
	public beginFrame(): void {
		this.uniformPool.beginFrame();
	}

	/**
	 * Encode the separable downsample-blur chain (2 passes per level) over
	 * `source`'s used region.
	 */
	public build(
		encoder: GPUCommandEncoder,
		source: GPUTexture,
		sourceUsedWidth: number,
		sourceUsedHeight: number,
		levelCount: number,
		profiler?: GPUTimingProfiler | null,
		timingLabel = "Blur Pyramid Build",
	): BlurPyramidLevel[] {
		if (levelCount === 0) return [];
		this.ensurePipeline(source.format);

		const levels: BlurPyramidLevel[] = [];
		let srcTexture = source;
		let srcWidth = sourceUsedWidth;
		let srcHeight = sourceUsedHeight;
		for (let level = 1; level <= levelCount; level++) {
			const dstWidth = Math.max(1, Math.ceil(srcWidth / 2));
			const dstHeight = Math.max(1, Math.ceil(srcHeight / 2));

			// Horizontal: halve X while blurring along X.
			const temp = this.acquireTexture(dstWidth, srcHeight, source.format);
			this.encodeLevelPass(
				encoder,
				srcTexture,
				srcWidth,
				srcHeight,
				temp,
				dstWidth,
				srcHeight,
				[1, 0],
				profiler,
				undefined,
				true,
				timingLabel,
			);
			// Vertical: halve Y while blurring along Y.
			const dst = this.acquireTexture(dstWidth, dstHeight, source.format);
			this.encodeLevelPass(
				encoder,
				temp,
				dstWidth,
				srcHeight,
				dst,
				dstWidth,
				dstHeight,
				[0, 1],
				profiler,
				undefined,
				true,
				timingLabel,
			);

			levels.push({
				intermediate: temp,
				texture: dst,
				ctl: blurTextureCtl(dstWidth, dstHeight, dst),
				usedWidth: dstWidth,
				usedHeight: dstHeight,
			});
			srcTexture = dst;
			srcWidth = dstWidth;
			srcHeight = dstHeight;
		}
		return levels;
	}

	/** One separable pyramid pass (full level, or scissored dirty rects). */
	public encodeLevelPass(
		encoder: GPUCommandEncoder,
		src: GPUTexture,
		srcUsedWidth: number,
		srcUsedHeight: number,
		dst: GPUTexture,
		dstUsedWidth: number,
		dstUsedHeight: number,
		axis: [number, number],
		profiler?: GPUTimingProfiler | null,
		dirtyRects?: readonly BlurPixelRect[],
		fullUpdate = true,
		timingLabel = "Blur Pyramid Build",
	): void {
		if (!fullUpdate && (!dirtyRects || dirtyRects.length === 0)) return;
		this.ensurePipeline(dst.format);
		const partialRects = dirtyRects ?? [];
		this.uniforms!.set({
			dstSizeStep: [
				dstUsedWidth,
				dstUsedHeight,
				axis[0] / src.width,
				axis[1] / src.height,
			],
			srcCtl: [
				srcUsedWidth / src.width,
				srcUsedHeight / src.height,
				0.5 / srcUsedWidth,
				0.5 / srcUsedHeight,
			],
			params: [PYRAMID_PASS_SIGMA, 0, 0, 0],
		});
		const buffer = this.uniformPool.write(this.uniforms!.arrayBuffer);

		const pass = encoder.beginRenderPass({
			label: "Blur Pyramid Pass",
			colorAttachments: [
				{
					view: dst.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: fullUpdate ? "clear" : "load",
					storeOp: "store",
				},
			],
			timestampWrites: profiler?.timestampWrites(timingLabel),
		});
		pass.setViewport(0, 0, dstUsedWidth, dstUsedHeight, 0, 1);
		pass.setPipeline(this.pipeline!);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({
				label: "Blur Pyramid Bind Group",
				layout: this.bindGroupLayout!,
				entries: [
					{ binding: 0, resource: { buffer } },
					{ binding: 1, resource: this.sampler! },
					{ binding: 2, resource: src.createView() },
				],
			}),
		);
		if (fullUpdate) {
			pass.draw(3);
		} else {
			for (const rect of partialRects) {
				pass.setScissorRect(rect.x, rect.y, rect.width, rect.height);
				pass.draw(3);
			}
		}
		pass.end();
	}

	/** Update a small dirty tile in one pass by evaluating the separable
	 * Gaussian directly from the previous level. */
	public encodeFusedLevelPass(
		encoder: GPUCommandEncoder,
		src: GPUTexture,
		srcUsedWidth: number,
		srcUsedHeight: number,
		dst: GPUTexture,
		dstUsedWidth: number,
		dstUsedHeight: number,
		dirtyRects: readonly BlurPixelRect[],
		profiler?: GPUTimingProfiler | null,
		timingLabel = "Blur Pyramid Patch",
	): void {
		if (dirtyRects.length === 0) return;
		this.ensurePipeline(dst.format);
		const { uniforms, fusedPipeline, bindGroupLayout, sampler } = this;
		if (!uniforms || !fusedPipeline || !bindGroupLayout || !sampler) {
			throw new Error("Blur pyramid fused pipeline was not initialized");
		}
		uniforms.set({
			dstSizeStep: [dstUsedWidth, dstUsedHeight, 0, 0],
			srcCtl: [
				srcUsedWidth / src.width,
				srcUsedHeight / src.height,
				0.5 / srcUsedWidth,
				0.5 / srcUsedHeight,
			],
			params: [PYRAMID_PASS_SIGMA, 0, 0, 0],
		});
		const buffer = this.uniformPool.write(uniforms.arrayBuffer);

		const pass = encoder.beginRenderPass({
			label: "Blur Pyramid Fused Pass",
			colorAttachments: [
				{
					view: dst.createView(),
					loadOp: "load",
					storeOp: "store",
				},
			],
			timestampWrites: profiler?.timestampWrites(timingLabel),
		});
		pass.setViewport(0, 0, dstUsedWidth, dstUsedHeight, 0, 1);
		pass.setPipeline(fusedPipeline);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({
				label: "Blur Pyramid Fused Bind Group",
				layout: bindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: src.createView() },
				],
			}),
		);
		for (const rect of dirtyRects) {
			pass.setScissorRect(rect.x, rect.y, rect.width, rect.height);
			pass.draw(3);
		}
		pass.end();
	}

	public destroy(): void {
		this.uniformPool.destroy();
		this.pipeline = null;
		this.fusedPipeline = null;
		this.pipelineFormat = null;
		this.bindGroupLayout = null;
		this.sampler = null;
		this.uniforms = null;
	}

	private ensurePipeline(format: GPUTextureFormat): void {
		if (this.pipeline && this.fusedPipeline && this.pipelineFormat === format) {
			return;
		}

		this.sampler ??= this.device.createSampler({
			label: "Blur Pyramid Sampler",
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		const { module, uniformViews } = compileShaderModule(this.device, {
			label: "Blur Pyramid Shader",
			code: BLUR_PYRAMID_SHADER,
		});
		const { module: fusedModule } = compileShaderModule(this.device, {
			label: "Blur Pyramid Fused Shader",
			code: BLUR_PYRAMID_FUSED_SHADER,
		});
		this.uniforms = uniformViews.uniforms;
		this.bindGroupLayout ??= this.device.createBindGroupLayout({
			label: "Blur Pyramid Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});
		this.pipeline = createFullscreenPipeline({
			device: this.device,
			label: "Blur Pyramid Pipeline",
			shaderModule: module,
			pipelineLayout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			targetFormat: format,
			multisampleCount: 1,
		});
		this.fusedPipeline = createFullscreenPipeline({
			device: this.device,
			label: "Blur Pyramid Fused Pipeline",
			shaderModule: fusedModule,
			pipelineLayout: this.device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			targetFormat: format,
			multisampleCount: 1,
		});
		this.pipelineFormat = format;
	}
}

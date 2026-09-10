import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import type { ScratchTexturePool } from "../ScratchTexturePool";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import {
	SVG_BLUR_DOWNSAMPLE_SHADER,
	SVG_BLUR_UPSAMPLE_SHADER,
	SVG_GAUSSIAN_BLUR_SHADER,
} from "./svg-gaussian-blur.wgsl";
import { SVG_INPUT_MODE_COLOR, svgRegionOriginTexel } from "./svgFilterInput";

/**
 * Sigma, in texels of the blurred texture, above which the blur runs on a
 * box-downsampled copy. A stride of floor(sigma / this) keeps the reduced
 * sigma in [this, 2 * this), so a pass never exceeds 6 * 2 * this taps.
 */
const DOWNSAMPLE_SIGMA = 8;

/**
 * Separable Gaussian blur shared by the SVG primitives that blur. Sigmas
 * beyond DOWNSAMPLE_SIGMA texels blur a box-downsampled copy and bilinearly
 * upsample the result, so the cost stays bounded at any rasterization scale
 * instead of growing with sigma squared.
 */
export class SvgGaussianBlur {
	private readonly blurPass = new SvgFullscreenPass();
	private readonly downsamplePass = new SvgFullscreenPass();
	private readonly upsamplePass = new SvgFullscreenPass();
	public readonly passes = [
		this.blurPass,
		this.downsamplePass,
		this.upsamplePass,
	];

	public initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
		label: string,
	): void {
		this.blurPass.initialize(
			device,
			canvasFormat,
			label,
			SVG_GAUSSIAN_BLUR_SHADER,
			{
				textures: 1,
			},
		);
		this.downsamplePass.initialize(
			device,
			canvasFormat,
			`${label} Downsample`,
			SVG_BLUR_DOWNSAMPLE_SHADER,
			{ textures: 1 },
		);
		this.upsamplePass.initialize(
			device,
			canvasFormat,
			`${label} Upsample`,
			SVG_BLUR_UPSAMPLE_SHADER,
			{ textures: 1 },
		);
	}

	/** Blur `source` into `target` with sigmas in texels; `inputMode` reduces the source read. */
	public run(
		context: FilterProcessorContext,
		scratch: ScratchTexturePool,
		source: GPUTexture,
		target: GPUTexture,
		sigmaX: number,
		sigmaY: number,
		inputMode: number,
	): void {
		const { device } = context;
		const strideX = Math.max(1, Math.floor(sigmaX / DOWNSAMPLE_SIGMA));
		const strideY = Math.max(1, Math.floor(sigmaY / DOWNSAMPLE_SIGMA));
		if (strideX === 1 && strideY === 1) {
			const blurredX = scratch.acquireLike(device, target, "SVG Blur Scratch");
			this.blurPass.run(
				context,
				{ direction: [1, 0], sigma: sigmaX, inputMode },
				[source],
				blurredX,
			);
			this.blurPass.run(
				context,
				{ direction: [0, 1], sigma: sigmaY, inputMode: SVG_INPUT_MODE_COLOR },
				[blurredX],
				target,
			);
			scratch.release(blurredX);
			return;
		}

		// Anchor the block grid to the filter region's origin, not the
		// texture's: a viewport-clamped bake starts at a different texel of
		// the region every pan, and a grid that moved with it would shift the
		// blur by up to a stride.
		const origin = svgRegionOriginTexel(context);
		const phaseX = gridPhase(Math.round(origin.x), strideX);
		const phaseY = gridPhase(Math.round(origin.y), strideY);
		const small = {
			width: Math.ceil((target.width - phaseX) / strideX),
			height: Math.ceil((target.height - phaseY) / strideY),
		};
		const reduced = scratch.acquireLike(
			device,
			target,
			"SVG Blur Scratch",
			small,
		);
		const blurredX = scratch.acquireLike(
			device,
			target,
			"SVG Blur Scratch",
			small,
		);
		this.downsamplePass.run(
			context,
			{ stride: [strideX, strideY], phase: [phaseX, phaseY], inputMode },
			[source],
			reduced,
		);
		this.blurPass.run(
			context,
			{
				direction: [1, 0],
				sigma: sigmaX / strideX,
				inputMode: SVG_INPUT_MODE_COLOR,
			},
			[reduced],
			blurredX,
		);
		this.blurPass.run(
			context,
			{
				direction: [0, 1],
				sigma: sigmaY / strideY,
				inputMode: SVG_INPUT_MODE_COLOR,
			},
			[blurredX],
			reduced,
		);
		this.upsamplePass.run(
			context,
			{ stride: [strideX, strideY], phase: [phaseX, phaseY] },
			[reduced],
			target,
		);
		scratch.release(reduced);
		scratch.release(blurredX);
	}
}

/** Start texel, in (-stride, 0], of the first block of a grid anchored at `origin`. */
function gridPhase(origin: number, stride: number): number {
	return ((origin % stride) - stride) % stride;
}

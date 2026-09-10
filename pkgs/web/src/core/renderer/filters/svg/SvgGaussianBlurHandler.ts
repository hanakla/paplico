import type { Appearance, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { effectiveSigma, SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgGaussianBlur } from "./SvgGaussianBlur";
import { resolveSvgInput, type SvgFilterInputParams } from "./svgFilterInput";

/** feGaussianBlur. Standard deviations in world px per axis. */
export interface SvgGaussianBlurParams extends SvgFilterInputParams {
	stdDeviationX: number;
	stdDeviationY: number;
}

export interface SvgGaussianBlurFilter
	extends Appearance<SvgGaussianBlurParams> {
	processor: "svg:gaussian-blur";
}

export class SvgGaussianBlurHandler extends SvgFilterHandlerBase<SvgGaussianBlurParams> {
	private readonly blur = new SvgGaussianBlur();
	protected readonly passes = this.blur.passes;

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.blur.initialize(device, canvasFormat, "SVG Gaussian Blur");
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const { stdDeviationX, stdDeviationY, in: input } = this.params(filter);
		const { dpiScale } = context.sceneInfo;
		const source = resolveSvgInput(context, input);
		this.blur.run(
			context,
			this.scratch,
			source.texture,
			context.targetTexture,
			effectiveSigma(stdDeviationX * dpiScale),
			effectiveSigma(stdDeviationY * dpiScale),
			source.mode,
		);
	}

	public getExpansionMargin(filter: Filter): number {
		const { stdDeviationX, stdDeviationY } = this.params(filter);
		return 3 * Math.max(stdDeviationX, stdDeviationY);
	}

	public onScaleFilter(filter: Filter, [sx, sy]: [number, number]): Filter {
		const { stdDeviationX, stdDeviationY } = this.params(filter);
		return this.withParams(filter, {
			stdDeviationX: stdDeviationX * sx,
			stdDeviationY: stdDeviationY * sy,
		});
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgGaussianBlurParams;
		const pb = b as SvgGaussianBlurParams;
		return {
			...pa,
			stdDeviationX: lerp(pa.stdDeviationX, pb.stdDeviationX, t),
			stdDeviationY: lerp(pa.stdDeviationY, pb.stdDeviationY, t),
		};
	}
}

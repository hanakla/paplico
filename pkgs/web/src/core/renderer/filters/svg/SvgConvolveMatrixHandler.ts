import type { Appearance, Filter } from "../../../schema";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import {
	SVG_CONVOLVE_KERNEL_VEC4_COUNT,
	SVG_CONVOLVE_MATRIX_SHADER,
	SVG_CONVOLVE_ORDER_MAX,
} from "./svg-convolve-matrix.wgsl";
import { resolveSvgInput, type SvgFilterInputParams } from "./svgFilterInput";

/**
 * feConvolveMatrix with a square kernel. `kernelMatrix` holds order x order
 * row-major weights; `divisor` null means the kernel sum.
 */
export interface SvgConvolveMatrixParams extends SvgFilterInputParams {
	order: number;
	kernelMatrix: number[];
	divisor: number | null;
	bias: number;
	edgeMode: "duplicate" | "wrap" | "none";
	preserveAlpha: boolean;
}

export interface SvgConvolveMatrixFilter
	extends Appearance<SvgConvolveMatrixParams> {
	processor: "svg:convolve-matrix";
}

const KERNEL_MAX = SVG_CONVOLVE_KERNEL_VEC4_COUNT * 4;

/** Must match the EDGE_* constants in the shader. */
const EDGE_MODE_INDEX: Record<SvgConvolveMatrixParams["edgeMode"], number> = {
	duplicate: 0,
	wrap: 1,
	none: 2,
};

export class SvgConvolveMatrixHandler extends SvgFilterHandlerBase<SvgConvolveMatrixParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			"SVG Convolve Matrix",
			SVG_CONVOLVE_MATRIX_SHADER,
			{ textures: 1 },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const params = this.params(filter);
		const source = resolveSvgInput(context, params.in);
		const order = clampSvgConvolveOrder(params.order);
		const kernel = new Float32Array(KERNEL_MAX);
		kernel.set(params.kernelMatrix.slice(0, order * order));
		this.pass.run(
			context,
			{
				order,
				divisor: resolveDivisor(params.divisor, kernel, order),
				bias: params.bias,
				edgeMode: EDGE_MODE_INDEX[params.edgeMode],
				preserveAlpha: params.preserveAlpha ? 1 : 0,
				inputMode: source.mode,
				kernelUnit: context.sceneInfo.dpiScale,
				kernel,
			},
			[source.texture],
			context.targetTexture,
		);
	}

	public getExpansionMargin(filter: Filter): number {
		return Math.ceil(clampSvgConvolveOrder(this.params(filter).order) / 2);
	}
}

/** The order the pass renders: whole, at least 1, at most SVG_CONVOLVE_ORDER_MAX. */
export function clampSvgConvolveOrder(order: number): number {
	return Math.min(SVG_CONVOLVE_ORDER_MAX, Math.max(1, Math.trunc(order)));
}

/** A zero divisor would blow up the sum, so the spec substitutes 1. */
function resolveDivisor(
	divisor: number | null,
	kernel: Float32Array,
	order: number,
): number {
	const value =
		divisor ?? kernel.subarray(0, order * order).reduce((s, w) => s + w, 0);
	return value === 0 ? 1 : value;
}

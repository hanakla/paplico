import type { Appearance, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import type { ScratchTexturePool } from "../ScratchTexturePool";
import {
	resolveColorMatrix,
	runColorMatrixPass,
} from "./SvgColorMatrixHandler";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_COLOR_MATRIX_SHADER } from "./svg-color-matrix.wgsl";
import { resolveSvgInput, type SvgFilterInputParams } from "./svgFilterInput";

/**
 * The CSS `filter` color functions. Each is a feColorMatrix in disguise, so
 * one handler class serves all of them and the exporter writes the matrix.
 */
export type SvgColorFunction =
	| "saturate"
	| "hue-rotate"
	| "grayscale"
	| "sepia"
	| "invert"
	| "brightness"
	| "contrast";

export const SVG_COLOR_FUNCTIONS: readonly SvgColorFunction[] = [
	"saturate",
	"hue-rotate",
	"grayscale",
	"sepia",
	"invert",
	"brightness",
	"contrast",
];

/** `amount` is the CSS function argument: degrees for hue-rotate, a factor otherwise. */
export interface SvgColorFunctionParams extends SvgFilterInputParams {
	amount: number;
}

export interface SvgColorFunctionFilter
	extends Appearance<SvgColorFunctionParams> {
	processor: `svg:${SvgColorFunction}`;
}

export class SvgColorFunctionHandler extends SvgFilterHandlerBase<SvgColorFunctionParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public constructor(
		private readonly fn: SvgColorFunction,
		scratch?: ScratchTexturePool,
	) {
		super(scratch);
	}

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			`SVG ${this.fn}`,
			SVG_COLOR_MATRIX_SHADER,
			{ textures: 1 },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const { amount, in: input } = this.params(filter);
		runColorMatrixPass(
			this.pass,
			context,
			colorFunctionMatrix(this.fn, amount),
			resolveSvgInput(context, input),
		);
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgColorFunctionParams;
		const pb = b as SvgColorFunctionParams;
		return { ...pa, amount: lerp(pa.amount, pb.amount, t) };
	}
}

/**
 * The 4x5 row-major color matrix of a CSS color function, per the Filter
 * Effects specification's definitions of the shorthand filters.
 */
export function colorFunctionMatrix(
	fn: SvgColorFunction,
	amount: number,
): number[] {
	switch (fn) {
		case "saturate":
			return resolveColorMatrix({
				in: "previous",
				type: "saturate",
				values: [amount],
			});
		case "hue-rotate":
			return resolveColorMatrix({
				in: "previous",
				type: "hueRotate",
				values: [amount],
			});
		case "grayscale":
			return resolveColorMatrix({
				in: "previous",
				type: "saturate",
				values: [1 - Math.min(1, amount)],
			});
		case "sepia": {
			const a = Math.min(1, amount);
			return [
				0.393 + 0.607 * (1 - a),
				0.769 - 0.769 * (1 - a),
				0.189 - 0.189 * (1 - a),
				0,
				0,
				0.349 - 0.349 * (1 - a),
				0.686 + 0.314 * (1 - a),
				0.168 - 0.168 * (1 - a),
				0,
				0,
				0.272 - 0.272 * (1 - a),
				0.534 - 0.534 * (1 - a),
				0.131 + 0.869 * (1 - a),
				0,
				0,
				0,
				0,
				0,
				1,
				0,
			];
		}
		case "invert": {
			// c' = (1 - a) c + a (1 - c) = (1 - 2a) c + a
			const a = Math.min(1, amount);
			return diagonalMatrix(1 - 2 * a, a);
		}
		case "brightness":
			return diagonalMatrix(amount, 0);
		case "contrast":
			// c' = a (c - 0.5) + 0.5
			return diagonalMatrix(amount, 0.5 - 0.5 * amount);
	}
}

/** `scale` on the RGB diagonal with `offset` in the RGB constant column. */
function diagonalMatrix(scale: number, offset: number): number[] {
	return [
		scale,
		0,
		0,
		0,
		offset,
		0,
		scale,
		0,
		0,
		offset,
		0,
		0,
		scale,
		0,
		offset,
		0,
		0,
		0,
		1,
		0,
	];
}

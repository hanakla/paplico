import type { Appearance, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_COLOR_MATRIX_SHADER } from "./svg-color-matrix.wgsl";
import { resolveSvgInput, type SvgFilterInputParams } from "./svgFilterInput";

export type SvgColorMatrixType =
	| "matrix"
	| "saturate"
	| "hueRotate"
	| "luminanceToAlpha";

/**
 * feColorMatrix. `values` follows the SVG attribute per type: 20 row-major
 * numbers for "matrix", [s] for "saturate", [degrees] for "hueRotate", and
 * nothing for "luminanceToAlpha".
 */
export interface SvgColorMatrixParams extends SvgFilterInputParams {
	type: SvgColorMatrixType;
	values: number[];
}

export interface SvgColorMatrixFilter extends Appearance<SvgColorMatrixParams> {
	processor: "svg:color-matrix";
}

/** The 4x5 matrix that leaves every channel unchanged. */
export const SVG_COLOR_MATRIX_IDENTITY: readonly number[] = [
	1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
];

export class SvgColorMatrixHandler extends SvgFilterHandlerBase<SvgColorMatrixParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			"SVG Color Matrix",
			SVG_COLOR_MATRIX_SHADER,
			{ textures: 1 },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const params = this.params(filter);
		runColorMatrixPass(
			this.pass,
			context,
			resolveColorMatrix(params),
			resolveSvgInput(context, params.in),
		);
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgColorMatrixParams;
		const pb = b as SvgColorMatrixParams;
		if (pa.type !== pb.type || pa.values.length !== pb.values.length) {
			return pa;
		}
		return {
			...pa,
			values: pa.values.map((v, i) => lerp(v, pb.values[i], t)),
		};
	}
}

/**
 * Apply a 4x5 row-major color matrix (the SVG `values` layout) to `source`,
 * writing the target of `context`. Shared with the CSS color functions,
 * which are all color matrices too.
 */
export function runColorMatrixPass(
	pass: SvgFullscreenPass,
	context: FilterProcessorContext,
	m: readonly number[],
	source: { texture: GPUTexture; mode: number },
): void {
	pass.run(
		context,
		{
			// WGSL mat4x4f is column-major, so each column gathers one
			// spec-matrix column across the four rows.
			matrix: [0, 1, 2, 3].flatMap((column) => [
				m[column],
				m[5 + column],
				m[10 + column],
				m[15 + column],
			]),
			offset: [m[4], m[9], m[14], m[19]],
			inputMode: source.mode,
		},
		[source.texture],
		context.targetTexture,
	);
}

/**
 * The 4x5 row-major matrix (20 values, as the SVG `values` attribute for
 * type="matrix") that `params` denotes, using the feColorMatrix spec
 * formulas for the shorthand types.
 */
export function resolveColorMatrix(params: SvgColorMatrixParams): number[] {
	const { type, values } = params;
	switch (type) {
		case "matrix":
			return values.length === 20
				? [...values]
				: [...SVG_COLOR_MATRIX_IDENTITY];
		case "saturate": {
			const s = values[0] ?? 1;
			return [
				0.213 + 0.787 * s,
				0.715 - 0.715 * s,
				0.072 - 0.072 * s,
				0,
				0,
				0.213 - 0.213 * s,
				0.715 + 0.285 * s,
				0.072 - 0.072 * s,
				0,
				0,
				0.213 - 0.213 * s,
				0.715 - 0.715 * s,
				0.072 + 0.928 * s,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
			];
		}
		case "hueRotate": {
			const radians = ((values[0] ?? 0) * Math.PI) / 180;
			const cos = Math.cos(radians);
			const sin = Math.sin(radians);
			return [
				0.213 + cos * 0.787 - sin * 0.213,
				0.715 - cos * 0.715 - sin * 0.715,
				0.072 - cos * 0.072 + sin * 0.928,
				0,
				0,
				0.213 - cos * 0.213 + sin * 0.143,
				0.715 + cos * 0.285 + sin * 0.14,
				0.072 - cos * 0.072 - sin * 0.283,
				0,
				0,
				0.213 - cos * 0.213 - sin * 0.787,
				0.715 - cos * 0.715 + sin * 0.715,
				0.072 + cos * 0.928 + sin * 0.072,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
			];
		}
		case "luminanceToAlpha":
			return [
				0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2125, 0.7154, 0.0721, 0,
				0,
			];
	}
}

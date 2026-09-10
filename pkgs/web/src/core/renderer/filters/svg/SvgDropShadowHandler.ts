import type { Appearance, Color, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { effectiveSigma, SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import {
	adjustSvgFloodColor,
	lerpSvgFlood,
	svgFloodColor,
} from "./SvgFloodHandler";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SvgGaussianBlur } from "./SvgGaussianBlur";
import { svgOffsetTexels } from "./SvgOffsetHandler";
import { SVG_DROP_SHADOW_COMPOSE_SHADER } from "./svg-drop-shadow.wgsl";
import {
	resolveSvgInput,
	SVG_INPUT_MODE_ALPHA,
	type SvgFilterInputParams,
} from "./svgFilterInput";

/**
 * feDropShadow. dx / dy in world px with Y up like feOffset; stdDeviation in
 * world px; color / opacity are the flood color of the shadow.
 */
export interface SvgDropShadowParams extends SvgFilterInputParams {
	dx: number;
	dy: number;
	stdDeviation: number;
	color: Color;
	opacity: number;
}

export interface SvgDropShadowFilter extends Appearance<SvgDropShadowParams> {
	processor: "svg:drop-shadow";
}

export class SvgDropShadowHandler extends SvgFilterHandlerBase<SvgDropShadowParams> {
	private readonly blur = new SvgGaussianBlur();
	private readonly composePass = new SvgFullscreenPass();
	protected readonly passes = [...this.blur.passes, this.composePass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.blur.initialize(device, canvasFormat, "SVG Drop Shadow Blur");
		this.composePass.initialize(
			device,
			canvasFormat,
			"SVG Drop Shadow Compose",
			SVG_DROP_SHADOW_COMPOSE_SHADER,
			{ textures: 2 },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const {
			dx,
			dy,
			stdDeviation,
			color,
			opacity,
			in: input,
		} = this.params(filter);
		const { dpiScale } = context.sceneInfo;
		const source = resolveSvgInput(context, input);
		const sigma = effectiveSigma(stdDeviation * dpiScale);
		// The shadow is the input's coverage blurred; SourceAlpha reads give
		// (0, 0, 0, a) directly, so the scratch stays valid premultiplied.
		const scratch = this.scratch.acquireLike(
			context.device,
			context.targetTexture,
			"SVG Drop Shadow Scratch",
		);
		this.blur.run(
			context,
			this.scratch,
			source.texture,
			scratch,
			sigma,
			sigma,
			SVG_INPUT_MODE_ALPHA,
		);
		this.composePass.run(
			context,
			{
				offset: svgOffsetTexels(dx, dy, dpiScale),
				inputMode: source.mode,
				color: svgFloodColor({ color, opacity }),
			},
			[scratch, source.texture],
			context.targetTexture,
		);
		this.scratch.release(scratch);
	}

	public getExpansionMargin(filter: Filter): number {
		const { dx, dy, stdDeviation } = this.params(filter);
		return 3 * stdDeviation + Math.max(Math.abs(dx), Math.abs(dy));
	}

	public onScaleFilter(filter: Filter, [sx, sy]: [number, number]): Filter {
		const { dx, dy, stdDeviation } = this.params(filter);
		return this.withParams(filter, {
			dx: dx * sx,
			dy: dy * sy,
			stdDeviation: stdDeviation * Math.sqrt(sx * sy),
		});
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgDropShadowParams;
		const pb = b as SvgDropShadowParams;
		return {
			...lerpSvgFlood(pa, pb, t),
			dx: lerp(pa.dx, pb.dx, t),
			dy: lerp(pa.dy, pb.dy, t),
			stdDeviation: lerp(pa.stdDeviation, pb.stdDeviation, t),
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		return adjustSvgFloodColor(params as SvgDropShadowParams, adjustColor);
	}
}

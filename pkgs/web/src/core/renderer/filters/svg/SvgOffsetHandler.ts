import type { Appearance, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_OFFSET_SHADER } from "./svg-offset.wgsl";
import { resolveSvgInput, type SvgFilterInputParams } from "./svgFilterInput";

/** feOffset. dx / dy in world px, Y up like every other Paplico offset. */
export interface SvgOffsetParams extends SvgFilterInputParams {
	dx: number;
	dy: number;
}

export interface SvgOffsetFilter extends Appearance<SvgOffsetParams> {
	processor: "svg:offset";
}

export class SvgOffsetHandler extends SvgFilterHandlerBase<SvgOffsetParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			"SVG Offset",
			SVG_OFFSET_SHADER,
			{
				textures: 1,
			},
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const { dx, dy, in: input } = this.params(filter);
		const { dpiScale } = context.sceneInfo;
		const source = resolveSvgInput(context, input);
		this.pass.run(
			context,
			{
				offset: svgOffsetTexels(dx, dy, dpiScale),
				inputMode: source.mode,
			},
			[source.texture],
			context.targetTexture,
		);
	}

	public getExpansionMargin(filter: Filter): number {
		const { dx, dy } = this.params(filter);
		return Math.max(Math.abs(dx), Math.abs(dy));
	}

	public onScaleFilter(filter: Filter, [sx, sy]: [number, number]): Filter {
		const { dx, dy } = this.params(filter);
		return this.withParams(filter, { dx: dx * sx, dy: dy * sy });
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgOffsetParams;
		const pb = b as SvgOffsetParams;
		return { ...pa, dx: lerp(pa.dx, pb.dx, t), dy: lerp(pa.dy, pb.dy, t) };
	}
}

/**
 * A world-space (Y up) offset as whole texels (Y down). resvg truncates
 * feOffset to whole device pixels; matching it lands the exported SVG on
 * the same texels.
 */
export function svgOffsetTexels(
	dx: number,
	dy: number,
	dpiScale: number,
): [number, number] {
	return [Math.trunc(dx * dpiScale), Math.trunc(-dy * dpiScale)];
}

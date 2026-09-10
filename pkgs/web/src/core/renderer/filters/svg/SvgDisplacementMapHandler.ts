import type { Appearance, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_DISPLACEMENT_MAP_SHADER } from "./svg-displacement-map.wgsl";
import { resolveSvgInput, type SvgFilterInput2Params } from "./svgFilterInput";

export type SvgChannelSelector = "R" | "G" | "B" | "A";

export const SVG_CHANNEL_SELECTORS: readonly SvgChannelSelector[] = [
	"R",
	"G",
	"B",
	"A",
];

/** feDisplacementMap. `in` is displaced by the channels of `in2`; scale in world px. */
export interface SvgDisplacementMapParams extends SvgFilterInput2Params {
	scale: number;
	xChannelSelector: SvgChannelSelector;
	yChannelSelector: SvgChannelSelector;
}

export interface SvgDisplacementMapFilter
	extends Appearance<SvgDisplacementMapParams> {
	processor: "svg:displacement-map";
}

export class SvgDisplacementMapHandler extends SvgFilterHandlerBase<SvgDisplacementMapParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			"SVG Displacement Map",
			SVG_DISPLACEMENT_MAP_SHADER,
			{ textures: 2 },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const {
			scale,
			xChannelSelector,
			yChannelSelector,
			in: input,
			in2,
		} = this.params(filter);
		const source = resolveSvgInput(context, input);
		const map = resolveSvgInput(context, in2);
		this.pass.run(
			context,
			{
				scale: scale * context.sceneInfo.dpiScale,
				inputMode: source.mode,
				mapMode: map.mode,
				xChannel: SVG_CHANNEL_SELECTORS.indexOf(xChannelSelector),
				yChannel: SVG_CHANNEL_SELECTORS.indexOf(yChannelSelector),
			},
			[source.texture, map.texture],
			context.targetTexture,
		);
	}

	public getExpansionMargin(filter: Filter): number {
		return Math.abs(this.params(filter).scale) / 2;
	}

	public onScaleFilter(filter: Filter, [sx, sy]: [number, number]): Filter {
		const { scale } = this.params(filter);
		return this.withParams(filter, { scale: scale * Math.sqrt(sx * sy) });
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgDisplacementMapParams;
		const pb = b as SvgDisplacementMapParams;
		return { ...pa, scale: lerp(pa.scale, pb.scale, t) };
	}
}

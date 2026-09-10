import type { Appearance, BlendMode, Filter } from "../../../schema";
import { BLEND_MODE_ORDER } from "../../canvas/CanvasLayerTypes";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_BLEND_SHADER } from "./svg-blend.wgsl";
import { resolveSvgInput, type SvgFilterInput2Params } from "./svgFilterInput";

/** feBlend. `in` is the source blended over the `in2` backdrop. */
export interface SvgBlendParams extends SvgFilterInput2Params {
	mode: BlendMode;
}

export interface SvgBlendFilter extends Appearance<SvgBlendParams> {
	processor: "svg:blend";
}

export class SvgBlendHandler extends SvgFilterHandlerBase<SvgBlendParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(device, canvasFormat, "SVG Blend", SVG_BLEND_SHADER, {
			textures: 2,
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const { mode, in: input, in2 } = this.params(filter);
		const source = resolveSvgInput(context, input);
		const source2 = resolveSvgInput(context, in2);
		this.pass.run(
			context,
			{
				mode: Math.max(0, BLEND_MODE_ORDER.indexOf(mode)),
				inputMode: source.mode,
				input2Mode: source2.mode,
			},
			[source.texture, source2.texture],
			context.targetTexture,
		);
	}
}

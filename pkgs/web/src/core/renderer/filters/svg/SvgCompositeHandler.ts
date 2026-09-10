import type { Appearance, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_COMPOSITE_SHADER } from "./svg-composite.wgsl";
import { resolveSvgInput, type SvgFilterInput2Params } from "./svgFilterInput";

export type SvgCompositeOperator =
	| "over"
	| "in"
	| "out"
	| "atop"
	| "xor"
	| "arithmetic";

export const SVG_COMPOSITE_OPERATORS: readonly SvgCompositeOperator[] = [
	"over",
	"in",
	"out",
	"atop",
	"xor",
	"arithmetic",
];

/** feComposite. `in` is composited on top of `in2`; k1..k4 apply to arithmetic only. */
export interface SvgCompositeParams extends SvgFilterInput2Params {
	operator: SvgCompositeOperator;
	k1: number;
	k2: number;
	k3: number;
	k4: number;
}

export interface SvgCompositeFilter extends Appearance<SvgCompositeParams> {
	processor: "svg:composite";
}

export class SvgCompositeHandler extends SvgFilterHandlerBase<SvgCompositeParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			"SVG Composite",
			SVG_COMPOSITE_SHADER,
			{ textures: 2 },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const { operator, k1, k2, k3, k4, in: input, in2 } = this.params(filter);
		const source = resolveSvgInput(context, input);
		const source2 = resolveSvgInput(context, in2);
		this.pass.run(
			context,
			{
				op: Math.max(0, SVG_COMPOSITE_OPERATORS.indexOf(operator)),
				inputMode: source.mode,
				input2Mode: source2.mode,
				k: [k1, k2, k3, k4],
			},
			[source.texture, source2.texture],
			context.targetTexture,
		);
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgCompositeParams;
		const pb = b as SvgCompositeParams;
		return {
			...pa,
			k1: lerp(pa.k1, pb.k1, t),
			k2: lerp(pa.k2, pb.k2, t),
			k3: lerp(pa.k3, pb.k3, t),
			k4: lerp(pa.k4, pb.k4, t),
		};
	}
}

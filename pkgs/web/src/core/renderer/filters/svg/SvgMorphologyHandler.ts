import type { Appearance, Filter } from "../../../schema";
import { lerp } from "../../../utils/math";
import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";
import { SvgFilterHandlerBase } from "./SvgFilterHandlerBase";
import { SvgFullscreenPass } from "./SvgFullscreenPass";
import { SVG_MORPHOLOGY_SHADER } from "./svg-morphology.wgsl";
import {
	resolveSvgInput,
	SVG_INPUT_MODE_COLOR,
	type SvgFilterInputParams,
} from "./svgFilterInput";

/** feMorphology. Radii in world px per axis. */
export interface SvgMorphologyParams extends SvgFilterInputParams {
	operator: "erode" | "dilate";
	radiusX: number;
	radiusY: number;
}

export interface SvgMorphologyFilter extends Appearance<SvgMorphologyParams> {
	processor: "svg:morphology";
}

/** Must match the OPERATOR_* constants in the shader. */
const OPERATOR_INDEX: Record<SvgMorphologyParams["operator"], number> = {
	erode: 0,
	dilate: 1,
};

export class SvgMorphologyHandler extends SvgFilterHandlerBase<SvgMorphologyParams> {
	private readonly pass = new SvgFullscreenPass();
	protected readonly passes = [this.pass];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.pass.initialize(
			device,
			canvasFormat,
			"SVG Morphology",
			SVG_MORPHOLOGY_SHADER,
			{ textures: 1 },
		);
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const { operator, radiusX, radiusY, in: input } = this.params(filter);
		const { dpiScale } = context.sceneInfo;
		const source = resolveSvgInput(context, input);
		const scratch = this.scratch.acquireLike(
			context.device,
			context.targetTexture,
			"SVG Morphology Scratch",
		);
		// SVG rasterizers work on whole-texel radii; rounding keeps a radius
		// that lands near a texel boundary from flipping between sizes.
		const common = { op: OPERATOR_INDEX[operator] };
		this.pass.run(
			context,
			{
				...common,
				direction: [1, 0],
				radius: Math.max(0, Math.round(radiusX * dpiScale)),
				inputMode: source.mode,
			},
			[source.texture],
			scratch,
		);
		this.pass.run(
			context,
			{
				...common,
				direction: [0, 1],
				radius: Math.max(0, Math.round(radiusY * dpiScale)),
				inputMode: SVG_INPUT_MODE_COLOR,
			},
			[scratch],
			context.targetTexture,
		);
		this.scratch.release(scratch);
	}

	public getExpansionMargin(filter: Filter): number {
		const { radiusX, radiusY } = this.params(filter);
		return Math.max(radiusX, radiusY);
	}

	public onScaleFilter(filter: Filter, [sx, sy]: [number, number]): Filter {
		const { radiusX, radiusY } = this.params(filter);
		return this.withParams(filter, {
			radiusX: radiusX * sx,
			radiusY: radiusY * sy,
		});
	}

	public onInterpolate(a: unknown, b: unknown, t: number): unknown {
		const pa = a as SvgMorphologyParams;
		const pb = b as SvgMorphologyParams;
		return {
			...pa,
			radiusX: lerp(pa.radiusX, pb.radiusX, t),
			radiusY: lerp(pa.radiusY, pb.radiusY, t),
		};
	}
}

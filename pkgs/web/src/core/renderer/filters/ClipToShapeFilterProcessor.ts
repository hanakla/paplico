import type { Appearance, Filter } from "../../schema";
import type {
	FilterHandler,
	FilterProcessorContext,
	FilterRenderRequirements,
} from "../canvas/pipeline/FilterRenderer";
import {
	SvgCompositeHandler,
	type SvgCompositeParams,
} from "./svg/SvgCompositeHandler";

export interface ClipToShapeParams {
	/** Keep what falls outside the shape instead of what falls inside. */
	invert: boolean;
}

export interface ClipToShapeFilter extends Appearance<ClipToShapeParams> {
	processor: "clip-to-shape";
}

/**
 * Clips the chain's current result to the element's own coverage — the shape
 * as it stands after the geometry filters, before any raster filter spread it
 * (blur halo, offset copies). A fixed-parameter feComposite over SourceAlpha;
 * the same params drive the GPU pass and the SVG export.
 */
export function clipToShapeComposite(
	params: ClipToShapeParams,
): SvgCompositeParams {
	return {
		in: "previous",
		in2: "SourceAlpha",
		operator: params.invert ? "out" : "in",
		k1: 0,
		k2: 0,
		k3: 0,
		k4: 0,
	};
}

export class ClipToShapeFilterHandler implements FilterHandler {
	private readonly composite = new SvgCompositeHandler();

	public initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		return this.composite.initialize(device, canvasFormat);
	}

	public destroy(): void {
		this.composite.destroy();
	}

	public onScaleFilter(filter: Filter): Filter {
		return filter;
	}

	public getExpansionMargin(): number {
		return 0;
	}

	public getRenderConfigure(): Partial<FilterRenderRequirements> {
		return { needsSourceGraphic: true };
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		this.composite.postProcess(context, {
			...filter,
			paramData: {
				version: "1",
				params: clipToShapeComposite(
					filter.paramData.params as ClipToShapeParams,
				),
			},
		});
	}
}

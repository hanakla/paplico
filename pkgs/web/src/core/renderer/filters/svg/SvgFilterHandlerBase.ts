import type { Filter } from "../../../schema";
import type {
	FilterHandler,
	FilterRenderRequirements,
} from "../../canvas/pipeline/FilterRenderer";
import { ScratchTexturePool } from "../ScratchTexturePool";
import type { SvgFullscreenPass } from "./SvgFullscreenPass";
import {
	needsSourceGraphic,
	type SvgFilterInput2Params,
} from "./svgFilterInput";

/**
 * Shared lifecycle of the SVG filter primitive handlers: they own one or more
 * fullscreen passes, declare SourceGraphic reads from their `in` params, and
 * are in-place image filters (postProcess writes ctx.targetTexture).
 * Subclasses implement the primitive itself; those with spatial parameters
 * override the margin and scaling, which default to "none".
 *
 * Intermediate textures come from `scratch`, a pool the orchestrator shares
 * across every SVG handler so equal sizes are not held once per primitive.
 */
export abstract class SvgFilterHandlerBase<P> implements FilterHandler {
	protected abstract readonly passes: SvgFullscreenPass[];

	public constructor(
		protected readonly scratch: ScratchTexturePool = new ScratchTexturePool(),
	) {}

	public abstract initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void>;

	public onScaleFilter(filter: Filter, scale: [number, number]): Filter {
		return filter;
	}

	public getExpansionMargin(
		filter: Filter,
		bounds?: { width: number; height: number },
	): number {
		return 0;
	}

	public getRenderConfigure(filter: Filter): Partial<FilterRenderRequirements> {
		return {
			needsSourceGraphic: needsSourceGraphic(
				this.params(filter) as Partial<SvgFilterInput2Params>,
			),
		};
	}

	public flushPendingDestroy(): void {
		this.scratch.flushPendingDestroy();
	}

	public destroy(): void {
		for (const pass of this.passes) pass.destroy();
		this.scratch.destroy();
	}

	protected params(filter: Filter): P {
		return filter.paramData.params as P;
	}

	/** The filter with some of its params replaced (onScaleFilter results). */
	protected withParams(filter: Filter, patch: Partial<P>): Filter {
		return {
			...filter,
			paramData: {
				...filter.paramData,
				params: { ...this.params(filter), ...patch },
			},
		};
	}
}

/** Below this sigma (in texels) SVG renderers skip a Gaussian blur entirely. */
const MIN_SIGMA = 0.05;

export function effectiveSigma(sigma: number): number {
	return sigma < MIN_SIGMA ? 0 : sigma;
}

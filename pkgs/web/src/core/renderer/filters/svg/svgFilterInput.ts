import type { FilterProcessorContext } from "../../canvas/pipeline/FilterRenderer";

/** Prefix of an input that names another node of the same `svg:filter` graph. */
export const SVG_NODE_REF_PREFIX = "ref:";

/**
 * Where an SVG filter primitive reads its input from, mirroring the `in`
 * attribute: the previous primitive's result, the untouched element render
 * (SourceGraphic), its coverage only (SourceAlpha), or — inside an
 * `svg:filter` graph — the result of an earlier node (`ref:<nodeId>`).
 */
export type SvgFilterInput =
	| "previous"
	| "SourceGraphic"
	| "SourceAlpha"
	| `${typeof SVG_NODE_REF_PREFIX}${string}`;

export interface SvgFilterInputParams {
	in: SvgFilterInput;
}

export interface SvgFilterInput2Params extends SvgFilterInputParams {
	in2: SvgFilterInput;
}

/** The node id an input refers to, or null for the keyword inputs. */
export function svgInputNodeRef(input: SvgFilterInput): string | null {
	return input.startsWith(SVG_NODE_REF_PREFIX)
		? input.slice(SVG_NODE_REF_PREFIX.length)
		: null;
}

export function svgNodeRefInput(nodeId: string): SvgFilterInput {
	return `${SVG_NODE_REF_PREFIX}${nodeId}`;
}

/** True when any declared input reads the chain input instead of a pass result. */
export function needsSourceGraphic(
	params: Partial<SvgFilterInput2Params>,
): boolean {
	return [params.in, params.in2].some(
		(input) => input === "SourceGraphic" || input === "SourceAlpha",
	);
}

/**
 * Sample mode the shader applies to a resolved input texture:
 * SVG_INPUT_MODE_COLOR passes the texel through, SVG_INPUT_MODE_ALPHA keeps
 * only its alpha (SourceAlpha).
 */
export const SVG_INPUT_MODE_COLOR = 0;
export const SVG_INPUT_MODE_ALPHA = 1;

/**
 * The context an `svg:filter` graph hands each node: the graph's earlier
 * node results are reachable by id for `ref:` inputs.
 */
export interface SvgNodeProcessorContext extends FilterProcessorContext {
	nodeOutputs?: ReadonlyMap<string, GPUTexture>;
}

export function resolveSvgInput(
	context: SvgNodeProcessorContext,
	input: SvgFilterInput,
): { texture: GPUTexture; mode: number } {
	const ref = svgInputNodeRef(input);
	if (ref !== null) {
		// A dangling reference (node removed) degrades to the previous result.
		return {
			texture: context.nodeOutputs?.get(ref) ?? context.sourceTexture,
			mode: SVG_INPUT_MODE_COLOR,
		};
	}
	if (input === "previous") {
		return { texture: context.sourceTexture, mode: SVG_INPUT_MODE_COLOR };
	}
	// A chain input is only kept when a handler asked for it; falling back to
	// the previous result keeps a misconfigured chain rendering something.
	const texture = context.sourceGraphicTexture ?? context.sourceTexture;
	return {
		texture,
		mode: input === "SourceAlpha" ? SVG_INPUT_MODE_ALPHA : SVG_INPUT_MODE_COLOR,
	};
}

/**
 * Texel of the current texture where the filter region's top-left corner
 * falls. A viewport-clamped bake covers a sub-rect of the region; anything
 * anchored to the region (noise coordinates, block grids) starts here.
 */
export function svgRegionOriginTexel(context: FilterProcessorContext): {
	x: number;
	y: number;
} {
	const { dpiScale } = context.sceneInfo;
	const content = context.sourceContentOffset ?? { x: 0, y: 0 };
	const region = context.coordinateSpace?.sourceOffset ?? { x: 0, y: 0 };
	return {
		x: content.x - region.x * dpiScale,
		y: content.y - region.y * dpiScale,
	};
}

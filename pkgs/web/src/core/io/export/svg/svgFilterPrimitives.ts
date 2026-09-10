/**
 * Emits the `svg:*` filter appearances as native SVG filter primitives. Each
 * appearance maps to exactly one `fe*` node; a chain of consecutive `svg:*`
 * appearances becomes one `<filter>` whose primitives read each other through
 * `result` names, so the serializer never rasterizes them.
 */

import { localAppearances } from "../../../document/appearancePresets";
import type { SvgBlendParams } from "../../../renderer/filters/svg/SvgBlendHandler";
import {
	colorFunctionMatrix,
	SVG_COLOR_FUNCTIONS,
	type SvgColorFunctionParams,
} from "../../../renderer/filters/svg/SvgColorFunctionHandler";
import type { SvgColorMatrixParams } from "../../../renderer/filters/svg/SvgColorMatrixHandler";
import type {
	SvgComponentTransferParams,
	SvgTransferFunction,
} from "../../../renderer/filters/svg/SvgComponentTransferHandler";
import type { SvgCompositeParams } from "../../../renderer/filters/svg/SvgCompositeHandler";
import {
	clampSvgConvolveOrder,
	type SvgConvolveMatrixParams,
} from "../../../renderer/filters/svg/SvgConvolveMatrixHandler";
import type { SvgDisplacementMapParams } from "../../../renderer/filters/svg/SvgDisplacementMapHandler";
import type { SvgDropShadowParams } from "../../../renderer/filters/svg/SvgDropShadowHandler";
import {
	isSvgFilterNodeEnabled,
	type SvgFilterGraphParams,
	type SvgFilterNode,
} from "../../../renderer/filters/svg/SvgFilterGraphHandler";
import type { SvgFloodParams } from "../../../renderer/filters/svg/SvgFloodHandler";
import type { SvgGaussianBlurParams } from "../../../renderer/filters/svg/SvgGaussianBlurHandler";
import type { SvgMorphologyParams } from "../../../renderer/filters/svg/SvgMorphologyHandler";
import type { SvgOffsetParams } from "../../../renderer/filters/svg/SvgOffsetHandler";
import type { SvgTurbulenceParams } from "../../../renderer/filters/svg/SvgTurbulenceHandler";
import {
	type SvgFilterInput,
	svgInputNodeRef,
} from "../../../renderer/filters/svg/svgFilterInput";
import {
	type Color,
	type Filter,
	type FilterEntry,
	isFilterEnabled,
} from "../../../schema";
import { colorToSvgPaint } from "./paintServer";
import { formatNumber } from "./pathData";
import type { SvgNode } from "./svgBuilder";

/** Resolves an `in` / `in2` value to the SVG attribute value it names. */
type InputResolver = (input: SvgFilterInput) => string;

type PrimitiveEmitter = (params: never, inputOf: InputResolver) => SvgNode;

export function isSvgNativeFilter(processor: string): boolean {
	return processor === "svg:filter" || processor in SVG_PRIMITIVE_EMITTERS;
}

/** The enabled `svg:*` appearances of an element in stack order. */
export function collectSvgFilterChain(
	filters: FilterEntry[] | undefined,
): Filter[] {
	return localAppearances(filters).filter(
		(f) =>
			isFilterEnabled(f) &&
			isSvgNativeFilter(f.processor) &&
			!isEmptySvgFilterGraph(f),
	);
}

/**
 * The primitive nodes of the `index`-th appearance in its chain. The last
 * node names its output `s{index}`, which is what a following appearance's
 * "previous" input refers to; an `svg:filter` graph expands to one node per
 * graph node, the inner ones named after their node id.
 */
export function svgFilterPrimitives(filter: Filter, index: number): SvgNode[] {
	const previous = index === 0 ? "SourceGraphic" : resultName(index - 1);
	if (filter.processor === "svg:filter") {
		const { nodes } = filter.paramData.params as SvgFilterGraphParams;
		// A disabled node forwards its "previous" input, and so does one whose
		// primitive has no emitter, as it has no pass on the GPU either; either
		// name resolves to the nearest emitted node before it, or to the outer
		// input.
		const emits = (node: SvgFilterNode) =>
			isSvgFilterNodeEnabled(node) && node.processor in SVG_PRIMITIVE_EMITTERS;
		const lastEnabled = nodes.findLastIndex(emits);
		const nodeResult = (nodeIndex: number): string => {
			if (nodeIndex < 0) return previous;
			if (!emits(nodes[nodeIndex])) return nodeResult(nodeIndex - 1);
			return nodeIndex === lastEnabled
				? resultName(index)
				: `${resultName(index)}-${nodes[nodeIndex].id}`;
		};
		return nodes.flatMap((node, nodeIndex) => {
			if (!emits(node)) return [];
			const emit = emitterFor(node.processor);
			const emitted = emit(node.params as never, (input) => {
				const ref = svgInputNodeRef(input);
				if (ref !== null) {
					// A dangling reference (node removed) reads the previous
					// result, as resolveSvgInput does on the GPU.
					const refIndex = nodes.findIndex((n) => n.id === ref);
					return nodeResult(refIndex === -1 ? nodeIndex - 1 : refIndex);
				}
				if (input !== "previous") return input;
				return nodeResult(nodeIndex - 1);
			});
			emitted.attrs.result = nodeResult(nodeIndex);
			return [emitted];
		});
	}
	const node = emitterFor(filter.processor)(
		filter.paramData.params as never,
		(input) => (input === "previous" ? previous : input),
	);
	node.attrs.result = resultName(index);
	return [node];
}

/** An `svg:filter` graph with no enabled node emits nothing, like a disabled filter. */
function isEmptySvgFilterGraph(filter: Filter): boolean {
	return (
		filter.processor === "svg:filter" &&
		!(filter.paramData.params as SvgFilterGraphParams).nodes.some(
			isSvgFilterNodeEnabled,
		)
	);
}

function emitterFor(processor: string): PrimitiveEmitter {
	const emit = SVG_PRIMITIVE_EMITTERS[processor];
	if (!emit) {
		throw new Error(`Not an SVG filter primitive: ${processor}`);
	}
	return emit;
}

const SVG_PRIMITIVE_EMITTERS: Record<string, PrimitiveEmitter> = {
	"svg:gaussian-blur": (p: SvgGaussianBlurParams, inputOf) => ({
		tag: "feGaussianBlur",
		attrs: {
			in: inputOf(p.in),
			stdDeviation: numberList([p.stdDeviationX, p.stdDeviationY]),
		},
	}),
	"svg:offset": (p: SvgOffsetParams, inputOf) => ({
		tag: "feOffset",
		attrs: {
			in: inputOf(p.in),
			dx: formatNumber(p.dx),
			// World Y is up; SVG user space Y is down.
			dy: formatNumber(-p.dy),
		},
	}),
	"svg:flood": (p: SvgFloodParams) => ({
		tag: "feFlood",
		attrs: floodAttrs(p.color, p.opacity),
	}),
	"svg:color-matrix": (p: SvgColorMatrixParams, inputOf) => ({
		tag: "feColorMatrix",
		attrs: {
			in: inputOf(p.in),
			type: p.type,
			...(p.type === "luminanceToAlpha"
				? {}
				: { values: numberList(p.values) }),
		},
	}),
	"svg:component-transfer": (p: SvgComponentTransferParams, inputOf) => ({
		tag: "feComponentTransfer",
		attrs: { in: inputOf(p.in) },
		children: (
			[
				["feFuncR", p.r],
				["feFuncG", p.g],
				["feFuncB", p.b],
				["feFuncA", p.a],
			] as const
		)
			.filter(([, fn]) => fn.type !== "identity")
			.map(([tag, fn]) => ({ tag, attrs: transferFunctionAttrs(fn) })),
	}),
	"svg:morphology": (p: SvgMorphologyParams, inputOf) => ({
		tag: "feMorphology",
		attrs: {
			in: inputOf(p.in),
			operator: p.operator,
			radius: numberList([p.radiusX, p.radiusY]),
		},
	}),
	"svg:convolve-matrix": (p: SvgConvolveMatrixParams, inputOf) => ({
		tag: "feConvolveMatrix",
		attrs: {
			in: inputOf(p.in),
			// The pass clamps the order and reads only that many weights.
			order: clampSvgConvolveOrder(p.order),
			kernelMatrix: numberList(
				p.kernelMatrix.slice(0, clampSvgConvolveOrder(p.order) ** 2),
			),
			...(p.divisor === null ? {} : { divisor: formatNumber(p.divisor) }),
			bias: formatNumber(p.bias),
			edgeMode: p.edgeMode,
			preserveAlpha: String(p.preserveAlpha),
		},
	}),
	"svg:turbulence": (p: SvgTurbulenceParams) => ({
		tag: "feTurbulence",
		attrs: {
			type: p.type,
			baseFrequency: numberList([p.baseFrequencyX, p.baseFrequencyY]),
			numOctaves: Math.max(0, Math.trunc(p.numOctaves)),
			seed: formatNumber(p.seed),
			stitchTiles: p.stitchTiles ? "stitch" : "noStitch",
		},
	}),
	"svg:displacement-map": (p: SvgDisplacementMapParams, inputOf) => ({
		tag: "feDisplacementMap",
		attrs: {
			in: inputOf(p.in),
			in2: inputOf(p.in2),
			scale: formatNumber(p.scale),
			xChannelSelector: p.xChannelSelector,
			yChannelSelector: p.yChannelSelector,
		},
	}),
	"svg:composite": (p: SvgCompositeParams, inputOf) => ({
		tag: "feComposite",
		attrs: {
			in: inputOf(p.in),
			in2: inputOf(p.in2),
			operator: p.operator,
			...(p.operator === "arithmetic"
				? {
						k1: formatNumber(p.k1),
						k2: formatNumber(p.k2),
						k3: formatNumber(p.k3),
						k4: formatNumber(p.k4),
					}
				: {}),
		},
	}),
	"svg:blend": (p: SvgBlendParams, inputOf) => ({
		tag: "feBlend",
		attrs: {
			in: inputOf(p.in),
			in2: inputOf(p.in2),
			mode: p.mode,
		},
	}),
	...Object.fromEntries(
		SVG_COLOR_FUNCTIONS.map((fn): [string, PrimitiveEmitter] => [
			`svg:${fn}`,
			(p: SvgColorFunctionParams, inputOf) => ({
				tag: "feColorMatrix",
				attrs: {
					in: inputOf(p.in),
					type: "matrix",
					values: numberList(colorFunctionMatrix(fn, p.amount)),
				},
			}),
		]),
	),
	"svg:drop-shadow": (p: SvgDropShadowParams, inputOf) => ({
		tag: "feDropShadow",
		attrs: {
			in: inputOf(p.in),
			dx: formatNumber(p.dx),
			dy: formatNumber(-p.dy),
			stdDeviation: formatNumber(p.stdDeviation),
			...floodAttrs(p.color, p.opacity),
		},
	}),
};

function resultName(index: number): string {
	return `s${index}`;
}

function floodAttrs(color: Color, opacity: number): Record<string, string> {
	const paint = colorToSvgPaint(color);
	return {
		"flood-color": paint.paint,
		"flood-opacity": formatNumber(paint.opacity * opacity),
	};
}

function transferFunctionAttrs(
	fn: SvgTransferFunction,
): Record<string, string> {
	switch (fn.type) {
		case "table":
		case "discrete":
			return { type: fn.type, tableValues: numberList(fn.tableValues) };
		case "linear":
			return {
				type: fn.type,
				slope: formatNumber(fn.slope),
				intercept: formatNumber(fn.intercept),
			};
		case "gamma":
			return {
				type: fn.type,
				amplitude: formatNumber(fn.amplitude),
				exponent: formatNumber(fn.exponent),
				offset: formatNumber(fn.offset),
			};
		default:
			return { type: "identity" };
	}
}

function numberList(values: readonly number[]): string {
	return values.map(formatNumber).join(" ");
}

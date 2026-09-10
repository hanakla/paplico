import { BLEND_MODE_ORDER } from "../renderer/canvas/CanvasLayerTypes";
import type { SvgBlendParams } from "../renderer/filters/svg/SvgBlendHandler";
import type {
	SvgColorMatrixParams,
	SvgColorMatrixType,
} from "../renderer/filters/svg/SvgColorMatrixHandler";
import { SVG_COLOR_MATRIX_IDENTITY } from "../renderer/filters/svg/SvgColorMatrixHandler";
import type {
	SvgComponentTransferParams,
	SvgTransferFunction,
} from "../renderer/filters/svg/SvgComponentTransferHandler";
import type {
	SvgCompositeOperator,
	SvgCompositeParams,
} from "../renderer/filters/svg/SvgCompositeHandler";
import { SVG_COMPOSITE_OPERATORS } from "../renderer/filters/svg/SvgCompositeHandler";
import type { SvgConvolveMatrixParams } from "../renderer/filters/svg/SvgConvolveMatrixHandler";
import type {
	SvgChannelSelector,
	SvgDisplacementMapParams,
} from "../renderer/filters/svg/SvgDisplacementMapHandler";
import { SVG_CHANNEL_SELECTORS } from "../renderer/filters/svg/SvgDisplacementMapHandler";
import type { SvgDropShadowParams } from "../renderer/filters/svg/SvgDropShadowHandler";
import type { SvgFilterNode } from "../renderer/filters/svg/SvgFilterGraphHandler";
import type { SvgFloodParams } from "../renderer/filters/svg/SvgFloodHandler";
import type { SvgGaussianBlurParams } from "../renderer/filters/svg/SvgGaussianBlurHandler";
import type { SvgMorphologyParams } from "../renderer/filters/svg/SvgMorphologyHandler";
import type { SvgOffsetParams } from "../renderer/filters/svg/SvgOffsetHandler";
import type { SvgTurbulenceParams } from "../renderer/filters/svg/SvgTurbulenceHandler";
import { SVG_CONVOLVE_ORDER_MAX } from "../renderer/filters/svg/svg-convolve-matrix.wgsl";
import {
	type SvgFilterInput,
	svgNodeRefInput,
} from "../renderer/filters/svg/svgFilterInput";
import type { BlendMode, RGBColor } from "../schema";

/**
 * Turn an SVG <filter> element into the node list of an `svg:filter` graph,
 * one node per supported primitive in document order. `result` names become
 * `ref:` inputs, an absent `in` reads the previous result, and primitives
 * Paplico has no pass for (feImage, feTile, lighting) are left out so the
 * rest of the graph still renders. Returns null when nothing is supported.
 *
 * The filter region and color-interpolation-filters are not carried over:
 * the region follows the element, and the passes run on sRGB values.
 */
export function parseSvgFilterElement(
	el: Element,
	parseColor: (value: string) => RGBColor | null,
): SvgFilterNode[] | null {
	const nodes: SvgFilterNode[] = [];
	const resultIds = new Map<string, string>();
	const input = (primitive: Element, name: string): SvgFilterInput => {
		const value = primitive.getAttribute(name)?.trim();
		if (!value) return "previous";
		if (value === "SourceGraphic" || value === "SourceAlpha") return value;
		const id = resultIds.get(value);
		// Background / paint inputs have no counterpart; fall back to the chain.
		return id === undefined ? "previous" : svgNodeRefInput(id);
	};
	for (const primitive of Array.from(el.children)) {
		const emitted = parsePrimitive(primitive, input, parseColor, nodes.length);
		if (emitted.length === 0) continue;
		nodes.push(...emitted);
		const result = primitive.getAttribute("result")?.trim();
		if (result) resultIds.set(result, nodes[nodes.length - 1].id);
	}
	return nodes.length === 0 ? null : nodes;
}

type InputOf = (primitive: Element, name: string) => SvgFilterInput;

function parsePrimitive(
	el: Element,
	inputOf: InputOf,
	parseColor: (value: string) => RGBColor | null,
	index: number,
): SvgFilterNode[] {
	const node = (processor: string, params: object): SvgFilterNode => ({
		id: `n${index}`,
		processor,
		params: params as SvgFilterNode["params"],
	});
	const num = (name: string, fallback: number) =>
		numberList(el.getAttribute(name))[0] ?? fallback;
	const pair = (name: string, fallback: number): [number, number] => {
		const [x, y] = numberList(el.getAttribute(name));
		return [x ?? fallback, y ?? x ?? fallback];
	};
	const flood = (): { color: RGBColor; opacity: number } => ({
		color: parseColor(el.getAttribute("flood-color") ?? "black") ?? {
			type: "rgb",
			r: 0,
			g: 0,
			b: 0,
			a: 1,
		},
		opacity: num("flood-opacity", 1),
	});

	switch (el.localName) {
		case "feGaussianBlur": {
			const [stdDeviationX, stdDeviationY] = pair("stdDeviation", 0);
			return [
				node("svg:gaussian-blur", {
					in: inputOf(el, "in"),
					stdDeviationX,
					stdDeviationY,
				} satisfies SvgGaussianBlurParams),
			];
		}
		case "feOffset":
			return [
				node("svg:offset", {
					in: inputOf(el, "in"),
					dx: num("dx", 0),
					// SVG user space Y is down; world Y is up.
					dy: -num("dy", 0),
				} satisfies SvgOffsetParams),
			];
		case "feFlood":
			return [node("svg:flood", flood() satisfies SvgFloodParams)];
		case "feColorMatrix":
			return [
				node("svg:color-matrix", {
					in: inputOf(el, "in"),
					...colorMatrix(el.getAttribute("type"), el.getAttribute("values")),
				} satisfies SvgColorMatrixParams),
			];
		case "feComponentTransfer": {
			const fn = (channel: string): SvgTransferFunction =>
				transferFunction(el.querySelector(`feFunc${channel}`));
			return [
				node("svg:component-transfer", {
					in: inputOf(el, "in"),
					r: fn("R"),
					g: fn("G"),
					b: fn("B"),
					a: fn("A"),
				} satisfies SvgComponentTransferParams),
			];
		}
		case "feMorphology": {
			const [radiusX, radiusY] = pair("radius", 0);
			return [
				node("svg:morphology", {
					in: inputOf(el, "in"),
					operator:
						el.getAttribute("operator") === "dilate" ? "dilate" : "erode",
					radiusX,
					radiusY,
				} satisfies SvgMorphologyParams),
			];
		}
		case "feConvolveMatrix": {
			const [orderX, orderY] = pair("order", 3);
			const kernelMatrix = numberList(el.getAttribute("kernelMatrix"));
			// Only square kernels up to the pass's order have a pass.
			if (
				orderX !== orderY ||
				orderX > SVG_CONVOLVE_ORDER_MAX ||
				kernelMatrix.length !== orderX * orderX
			) {
				return [];
			}
			const edgeMode = el.getAttribute("edgeMode");
			return [
				node("svg:convolve-matrix", {
					in: inputOf(el, "in"),
					order: orderX,
					kernelMatrix,
					divisor: numberList(el.getAttribute("divisor"))[0] ?? null,
					bias: num("bias", 0),
					edgeMode:
						edgeMode === "wrap" || edgeMode === "none" ? edgeMode : "duplicate",
					preserveAlpha: el.getAttribute("preserveAlpha") === "true",
				} satisfies SvgConvolveMatrixParams),
			];
		}
		case "feTurbulence": {
			const [baseFrequencyX, baseFrequencyY] = pair("baseFrequency", 0);
			return [
				node("svg:turbulence", {
					type:
						el.getAttribute("type") === "fractalNoise"
							? "fractalNoise"
							: "turbulence",
					baseFrequencyX,
					baseFrequencyY,
					numOctaves: num("numOctaves", 1),
					seed: num("seed", 0),
					stitchTiles: el.getAttribute("stitchTiles") === "stitch",
				} satisfies SvgTurbulenceParams),
			];
		}
		case "feDisplacementMap":
			return [
				node("svg:displacement-map", {
					in: inputOf(el, "in"),
					in2: inputOf(el, "in2"),
					scale: num("scale", 0),
					xChannelSelector: channel(el.getAttribute("xChannelSelector")),
					yChannelSelector: channel(el.getAttribute("yChannelSelector")),
				} satisfies SvgDisplacementMapParams),
			];
		case "feComposite": {
			const operator = el.getAttribute("operator") as SvgCompositeOperator;
			return [
				node("svg:composite", {
					in: inputOf(el, "in"),
					in2: inputOf(el, "in2"),
					operator: SVG_COMPOSITE_OPERATORS.includes(operator)
						? operator
						: "over",
					k1: num("k1", 0),
					k2: num("k2", 0),
					k3: num("k3", 0),
					k4: num("k4", 0),
				} satisfies SvgCompositeParams),
			];
		}
		case "feBlend": {
			const mode = el.getAttribute("mode") as BlendMode;
			return [
				node("svg:blend", {
					in: inputOf(el, "in"),
					in2: inputOf(el, "in2"),
					mode: BLEND_MODE_ORDER.includes(mode) ? mode : "normal",
				} satisfies SvgBlendParams),
			];
		}
		case "feDropShadow":
			return [
				node("svg:drop-shadow", {
					in: inputOf(el, "in"),
					dx: num("dx", 2),
					dy: -num("dy", 2),
					stdDeviation: num("stdDeviation", 2),
					...flood(),
				} satisfies SvgDropShadowParams),
			];
		case "feMerge":
			return merge(el, inputOf, index);
		default:
			return [];
	}
}

/**
 * feMerge stacks its feMergeNode inputs bottom to top: the first is the
 * base and every later one composites over the running result.
 */
function merge(el: Element, inputOf: InputOf, index: number): SvgFilterNode[] {
	const layers = Array.from(el.querySelectorAll("feMergeNode")).map((child) =>
		inputOf(child, "in"),
	);
	if (layers.length === 0) return [];
	const nodes: SvgFilterNode[] = [];
	const over = (
		top: SvgFilterInput,
		bottom: SvgFilterInput,
	): SvgFilterNode => ({
		id: `n${index + nodes.length}`,
		processor: "svg:composite",
		params: {
			in: top,
			in2: bottom,
			operator: "over",
			k1: 0,
			k2: 0,
			k3: 0,
			k4: 0,
		} satisfies SvgCompositeParams,
	});
	if (layers.length === 1) {
		// A single layer passes through untouched; a zero offset keeps its
		// alpha, where compositing it over itself would not.
		nodes.push({
			id: `n${index}`,
			processor: "svg:offset",
			params: { in: layers[0], dx: 0, dy: 0 } satisfies SvgOffsetParams,
		});
		return nodes;
	}
	let below = layers[0];
	for (const layer of layers.slice(1)) {
		const composite = over(layer, below);
		nodes.push(composite);
		below = svgNodeRefInput(composite.id);
	}
	return nodes;
}

function colorMatrix(
	type: string | null,
	values: string | null,
): { type: SvgColorMatrixType; values: number[] } {
	const list = numberList(values);
	switch (type) {
		case "saturate":
			return { type, values: [list[0] ?? 1] };
		case "hueRotate":
			return { type, values: [list[0] ?? 0] };
		case "luminanceToAlpha":
			return { type, values: [] };
		default:
			return {
				type: "matrix",
				values: list.length === 20 ? list : [...SVG_COLOR_MATRIX_IDENTITY],
			};
	}
}

function transferFunction(el: Element | null): SvgTransferFunction {
	const num = (name: string, fallback: number) =>
		numberList(el?.getAttribute(name) ?? null)[0] ?? fallback;
	switch (el?.getAttribute("type")) {
		case "table":
		case "discrete":
			return {
				type: el.getAttribute("type") as "table" | "discrete",
				tableValues: numberList(el.getAttribute("tableValues")),
			};
		case "linear":
			return {
				type: "linear",
				slope: num("slope", 1),
				intercept: num("intercept", 0),
			};
		case "gamma":
			return {
				type: "gamma",
				amplitude: num("amplitude", 1),
				exponent: num("exponent", 1),
				offset: num("offset", 0),
			};
		default:
			return { type: "identity" };
	}
}

function channel(value: string | null): SvgChannelSelector {
	const selector = value as SvgChannelSelector;
	return SVG_CHANNEL_SELECTORS.includes(selector) ? selector : "A";
}

function numberList(value: string | null): number[] {
	return (value ?? "")
		.trim()
		.split(/[\s,]+/)
		.filter((token) => token !== "")
		.map(Number)
		.filter((n) => !Number.isNaN(n));
}

import { describe, expect, it } from "vitest";
import type { Filter } from "../../../schema";
import {
	collectSvgFilterChain,
	isSvgNativeFilter,
	svgFilterPrimitives,
} from "./svgFilterPrimitives";

const svgFilterPrimitive = (f: Filter, index: number) =>
	svgFilterPrimitives(f, index)[0];

const filter = (processor: string, params: object): Filter => ({
	uid: `f-${processor}`,
	processor,
	opacity: 1,
	blendMode: "normal",
	paramData: { version: "1", params },
});

describe("isSvgNativeFilter", () => {
	it("should recognize every svg:* processor and nothing else", () => {
		expect(isSvgNativeFilter("svg:gaussian-blur")).toBe(true);
		expect(isSvgNativeFilter("svg:composite")).toBe(true);
		expect(isSvgNativeFilter("blur")).toBe(false);
		expect(isSvgNativeFilter("hk:bloom")).toBe(false);
	});
});

describe("collectSvgFilterChain", () => {
	it("should keep only enabled svg filters in stack order", () => {
		const chain = collectSvgFilterChain([
			filter("fill", {}),
			filter("svg:offset", { in: "previous", dx: 1, dy: 1 }),
			{ ...filter("svg:flood", {}), enabled: false },
			filter("svg:gaussian-blur", {
				in: "previous",
				stdDeviationX: 1,
				stdDeviationY: 1,
			}),
		]);
		expect(chain.map((f) => f.processor)).toEqual([
			"svg:offset",
			"svg:gaussian-blur",
		]);
	});
});

describe("svgFilterPrimitive", () => {
	it("should name every result and resolve 'previous' to the prior result", () => {
		const first = svgFilterPrimitive(
			filter("svg:gaussian-blur", {
				in: "previous",
				stdDeviationX: 2,
				stdDeviationY: 3,
			}),
			0,
		);
		expect(first.tag).toBe("feGaussianBlur");
		expect(first.attrs).toMatchObject({
			in: "SourceGraphic",
			stdDeviation: "2 3",
			result: "s0",
		});

		const second = svgFilterPrimitive(
			filter("svg:morphology", {
				in: "previous",
				operator: "dilate",
				radiusX: 1,
				radiusY: 2,
			}),
			1,
		);
		expect(second.attrs).toMatchObject({
			in: "s0",
			operator: "dilate",
			radius: "1 2",
			result: "s1",
		});
	});

	it("should pass SourceGraphic / SourceAlpha keywords through", () => {
		const node = svgFilterPrimitive(
			filter("svg:offset", { in: "SourceAlpha", dx: 4, dy: -4 }),
			2,
		);
		expect(node.attrs.in).toBe("SourceAlpha");
	});

	it("should negate dy for feOffset and feDropShadow (world Y is up)", () => {
		const offset = svgFilterPrimitive(
			filter("svg:offset", { in: "previous", dx: 4, dy: -4 }),
			0,
		);
		expect(offset.attrs).toMatchObject({ dx: "4", dy: "4" });

		const shadow = svgFilterPrimitive(
			filter("svg:drop-shadow", {
				in: "previous",
				dx: 2,
				dy: 3,
				stdDeviation: 1.5,
				color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				opacity: 0.5,
			}),
			0,
		);
		expect(shadow.tag).toBe("feDropShadow");
		expect(shadow.attrs).toMatchObject({
			dx: "2",
			dy: "-3",
			stdDeviation: "1.5",
			"flood-color": "#ff0000",
			"flood-opacity": "0.5",
		});
	});

	it("should multiply the flood color alpha into flood-opacity", () => {
		const node = svgFilterPrimitive(
			filter("svg:flood", {
				color: { type: "rgb", r: 0, g: 0, b: 1, a: 0.5 },
				opacity: 0.5,
			}),
			0,
		);
		expect(node.tag).toBe("feFlood");
		expect(node.attrs).toMatchObject({
			"flood-color": "#0000ff",
			"flood-opacity": "0.25",
		});
		expect(node.attrs.in).toBeUndefined();
	});

	it("should emit feColorMatrix values except for luminanceToAlpha", () => {
		expect(
			svgFilterPrimitive(
				filter("svg:color-matrix", {
					in: "previous",
					type: "saturate",
					values: [0.5],
				}),
				0,
			).attrs,
		).toMatchObject({ type: "saturate", values: "0.5" });
		expect(
			svgFilterPrimitive(
				filter("svg:color-matrix", {
					in: "previous",
					type: "luminanceToAlpha",
					values: [],
				}),
				0,
			).attrs.values,
		).toBeUndefined();
	});

	it("should emit feFunc children only for non-identity channels", () => {
		const node = svgFilterPrimitive(
			filter("svg:component-transfer", {
				in: "previous",
				r: { type: "table", tableValues: [0, 1] },
				g: { type: "identity" },
				b: { type: "linear", slope: 2, intercept: -0.5 },
				a: { type: "gamma", amplitude: 1, exponent: 2, offset: 0 },
			}),
			0,
		);
		expect(node.tag).toBe("feComponentTransfer");
		expect(node.children?.map((c) => [c.tag, c.attrs])).toEqual([
			["feFuncR", { type: "table", tableValues: "0 1" }],
			["feFuncB", { type: "linear", slope: "2", intercept: "-0.5" }],
			[
				"feFuncA",
				{ type: "gamma", amplitude: "1", exponent: "2", offset: "0" },
			],
		]);
	});

	it("should emit feConvolveMatrix attributes and omit an automatic divisor", () => {
		const node = svgFilterPrimitive(
			filter("svg:convolve-matrix", {
				in: "previous",
				order: 3,
				kernelMatrix: [0, 1, 0, 1, -4, 1, 0, 1, 0],
				divisor: null,
				bias: 0.1,
				edgeMode: "none",
				preserveAlpha: true,
			}),
			0,
		);
		expect(node.attrs).toMatchObject({
			order: 3,
			kernelMatrix: "0 1 0 1 -4 1 0 1 0",
			bias: "0.1",
			edgeMode: "none",
			preserveAlpha: "true",
		});
		expect(node.attrs.divisor).toBeUndefined();
	});

	it("should emit feTurbulence with stitch keywords", () => {
		const node = svgFilterPrimitive(
			filter("svg:turbulence", {
				type: "fractalNoise",
				baseFrequencyX: 0.02,
				baseFrequencyY: 0.05,
				numOctaves: 3,
				seed: 7,
				stitchTiles: true,
			}),
			0,
		);
		expect(node.attrs).toMatchObject({
			type: "fractalNoise",
			baseFrequency: "0.02 0.05",
			numOctaves: 3,
			seed: "7",
			stitchTiles: "stitch",
		});
	});

	it("should wire in2 on two-input primitives", () => {
		const displace = svgFilterPrimitive(
			filter("svg:displacement-map", {
				in: "SourceGraphic",
				in2: "previous",
				scale: 12,
				xChannelSelector: "R",
				yChannelSelector: "G",
			}),
			1,
		);
		expect(displace.attrs).toMatchObject({
			in: "SourceGraphic",
			in2: "s0",
			scale: "12",
			xChannelSelector: "R",
			yChannelSelector: "G",
		});

		const composite = svgFilterPrimitive(
			filter("svg:composite", {
				in: "previous",
				in2: "SourceAlpha",
				operator: "arithmetic",
				k1: 1,
				k2: 0,
				k3: 0.5,
				k4: 0,
			}),
			1,
		);
		expect(composite.attrs).toMatchObject({
			in: "s0",
			in2: "SourceAlpha",
			operator: "arithmetic",
			k1: "1",
			k3: "0.5",
		});
		expect(
			svgFilterPrimitive(
				filter("svg:composite", {
					in: "previous",
					in2: "SourceGraphic",
					operator: "in",
					k1: 1,
					k2: 1,
					k3: 1,
					k4: 1,
				}),
				0,
			).attrs.k1,
		).toBeUndefined();

		const blend = svgFilterPrimitive(
			filter("svg:blend", {
				in: "previous",
				in2: "SourceGraphic",
				mode: "multiply",
			}),
			0,
		);
		expect(blend.attrs).toMatchObject({
			in: "SourceGraphic",
			in2: "SourceGraphic",
			mode: "multiply",
		});
	});

	it("should write the CSS color functions as matrices", () => {
		const node = svgFilterPrimitive(
			filter("svg:invert", { in: "previous", amount: 1 }),
			0,
		);
		expect(node.tag).toBe("feColorMatrix");
		expect(node.attrs).toMatchObject({
			in: "SourceGraphic",
			type: "matrix",
			values: "-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0",
		});
	});

	it("should expand an svg:filter graph into nodes wired by id", () => {
		const nodes = svgFilterPrimitives(
			filter("svg:filter", {
				nodes: [
					{
						id: "blurred",
						processor: "svg:gaussian-blur",
						params: { in: "SourceAlpha", stdDeviationX: 2, stdDeviationY: 2 },
					},
					{
						id: "shifted",
						processor: "svg:offset",
						params: { in: "previous", dx: 3, dy: -3 },
					},
					{
						id: "merged",
						processor: "svg:composite",
						params: {
							in: "SourceGraphic",
							in2: "ref:shifted",
							operator: "over",
							k1: 0,
							k2: 0,
							k3: 0,
							k4: 0,
						},
					},
				],
			}),
			1,
		);
		expect(
			nodes.map((n) => [n.tag, n.attrs.in, n.attrs.in2, n.attrs.result]),
		).toEqual([
			["feGaussianBlur", "SourceAlpha", undefined, "s1-blurred"],
			["feOffset", "s1-blurred", undefined, "s1-shifted"],
			["feComposite", "SourceGraphic", "s1-shifted", "s1"],
		]);
	});

	it("should skip disabled graph nodes and route their readers to what they forward", () => {
		const nodes = svgFilterPrimitives(
			filter("svg:filter", {
				nodes: [
					{
						id: "a",
						processor: "svg:offset",
						params: { in: "previous", dx: 1, dy: 0 },
						enabled: false,
					},
					{
						id: "b",
						processor: "svg:offset",
						params: { in: "previous", dx: 2, dy: 0 },
					},
					{
						id: "c",
						processor: "svg:offset",
						params: { in: "ref:a", dx: 3, dy: 0 },
						enabled: false,
					},
					{
						id: "d",
						processor: "svg:offset",
						params: { in: "ref:c", dx: 4, dy: 0 },
					},
				],
			}),
			1,
		);
		expect(nodes.map((n) => [n.attrs.dx, n.attrs.in, n.attrs.result])).toEqual([
			["2", "s0", "s1-b"],
			["4", "s1-b", "s1"],
		]);
	});

	it("should read the previous result for a reference to a removed node", () => {
		const nodes = svgFilterPrimitives(
			filter("svg:filter", {
				nodes: [
					{
						id: "a",
						processor: "svg:offset",
						params: { in: "previous", dx: 5, dy: 0 },
					},
					{
						id: "c",
						processor: "svg:offset",
						params: { in: "ref:removed", dx: 5, dy: 0 },
					},
				],
			}),
			0,
		);
		expect(nodes.map((n) => [n.attrs.in, n.attrs.result])).toEqual([
			["SourceGraphic", "s0-a"],
			["s0-a", "s0"],
		]);
	});

	it("should drop a graph whose nodes are all disabled from the chain", () => {
		const graph = filter("svg:filter", {
			nodes: [
				{
					id: "a",
					processor: "svg:offset",
					params: { in: "previous", dx: 1, dy: 0 },
					enabled: false,
				},
			],
		});
		expect(collectSvgFilterChain([graph])).toEqual([]);
	});

	it("should feed the outer previous result into a graph's first node", () => {
		const [node] = svgFilterPrimitives(
			filter("svg:filter", {
				nodes: [
					{
						id: "n",
						processor: "svg:offset",
						params: { in: "previous", dx: 1, dy: 1 },
					},
				],
			}),
			2,
		);
		expect(node.attrs).toMatchObject({ in: "s1", result: "s2" });
		expect(isSvgNativeFilter("svg:filter")).toBe(true);
	});

	it("should throw for a processor that is not an SVG primitive", () => {
		expect(() => svgFilterPrimitive(filter("blur", {}), 0)).toThrow();
	});
});

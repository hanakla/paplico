import { describe, expect, it } from "vitest";
import { parseSvgFilterElement } from "./svgFilterImport";
import { parseSvgColor } from "./svgImport";

function filterElement(inner: string): Element {
	const doc = new DOMParser().parseFromString(
		`<svg xmlns="http://www.w3.org/2000/svg"><filter id="f">${inner}</filter></svg>`,
		"image/svg+xml",
	);
	return doc.querySelector("filter") as Element;
}

const parse = (inner: string) =>
	parseSvgFilterElement(filterElement(inner), parseSvgColor);

describe("parseSvgFilterElement", () => {
	it("should map every primitive to its svg:* node with SVG defaults", () => {
		const nodes = parse(`
			<feColorMatrix type="saturate" values="0.3"/>
			<feColorMatrix type="hueRotate"/>
			<feColorMatrix/>
			<feComponentTransfer>
				<feFuncR type="table" tableValues="0 1 0"/>
				<feFuncG type="linear" slope="2"/>
				<feFuncB type="gamma" exponent="0.5"/>
			</feComponentTransfer>
			<feMorphology operator="dilate" radius="2 3"/>
			<feConvolveMatrix kernelMatrix="0 1 0 1 -4 1 0 1 0" edgeMode="none" preserveAlpha="true"/>
			<feTurbulence type="fractalNoise" baseFrequency="0.02 0.05" numOctaves="3" seed="7" stitchTiles="stitch"/>
			<feDisplacementMap in="SourceGraphic" in2="noise" scale="12" xChannelSelector="R" yChannelSelector="G"/>
			<feBlend in2="SourceGraphic" mode="multiply"/>
			<feDropShadow dx="1" dy="2" stdDeviation="3" flood-color="#00ff00" flood-opacity="0.5"/>
		`);
		expect(nodes?.map((n) => n.processor)).toEqual([
			"svg:color-matrix",
			"svg:color-matrix",
			"svg:color-matrix",
			"svg:component-transfer",
			"svg:morphology",
			"svg:convolve-matrix",
			"svg:turbulence",
			"svg:displacement-map",
			"svg:blend",
			"svg:drop-shadow",
		]);
		expect(nodes?.[0].params).toMatchObject({
			type: "saturate",
			values: [0.3],
		});
		expect(nodes?.[1].params).toMatchObject({ type: "hueRotate", values: [0] });
		expect(nodes?.[2].params).toMatchObject({ type: "matrix" });
		expect((nodes?.[2].params.values as number[]).length).toBe(20);
		expect(nodes?.[3].params).toMatchObject({
			r: { type: "table", tableValues: [0, 1, 0] },
			g: { type: "linear", slope: 2, intercept: 0 },
			b: { type: "gamma", amplitude: 1, exponent: 0.5, offset: 0 },
			a: { type: "identity" },
		});
		expect(nodes?.[4].params).toMatchObject({
			operator: "dilate",
			radiusX: 2,
			radiusY: 3,
		});
		expect(nodes?.[5].params).toMatchObject({
			order: 3,
			divisor: null,
			bias: 0,
			edgeMode: "none",
			preserveAlpha: true,
		});
		expect(nodes?.[6].params).toEqual({
			type: "fractalNoise",
			baseFrequencyX: 0.02,
			baseFrequencyY: 0.05,
			numOctaves: 3,
			seed: 7,
			stitchTiles: true,
		});
		// "noise" names no result, so in2 falls back to the previous result.
		expect(nodes?.[7].params).toMatchObject({
			in: "SourceGraphic",
			in2: "previous",
			scale: 12,
			xChannelSelector: "R",
			yChannelSelector: "G",
		});
		expect(nodes?.[8].params).toMatchObject({ mode: "multiply" });
		expect(nodes?.[9].params).toEqual({
			in: "previous",
			dx: 1,
			dy: -2,
			stdDeviation: 3,
			color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 },
			opacity: 0.5,
		});
	});

	it("should resolve result names to ref inputs and skip unsupported primitives", () => {
		const nodes = parse(`
			<feGaussianBlur stdDeviation="2" result="a"/>
			<feImage href="x.png" result="img"/>
			<feOffset in="a" dx="4" result="a"/>
			<feComposite in="img" in2="a" operator="xor"/>
		`);
		expect(nodes?.map((n) => n.processor)).toEqual([
			"svg:gaussian-blur",
			"svg:offset",
			"svg:composite",
		]);
		expect(nodes?.[1].params.in).toBe(`ref:${nodes?.[0].id}`);
		// Reusing a result name rebinds it to the later primitive.
		expect(nodes?.[2].params).toMatchObject({
			in: "previous",
			in2: `ref:${nodes?.[1].id}`,
			operator: "xor",
		});
	});

	it("should expand feMerge into a stack of over composites", () => {
		const nodes = parse(`
			<feFlood flood-color="red" result="r"/>
			<feFlood flood-color="blue" result="b"/>
			<feMerge><feMergeNode in="r"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
		`);
		expect(nodes?.map((n) => n.processor)).toEqual([
			"svg:flood",
			"svg:flood",
			"svg:composite",
			"svg:composite",
		]);
		expect(nodes?.[2].params).toMatchObject({
			in: `ref:${nodes?.[1].id}`,
			in2: `ref:${nodes?.[0].id}`,
			operator: "over",
		});
		expect(nodes?.[3].params).toMatchObject({
			in: "SourceGraphic",
			in2: `ref:${nodes?.[2].id}`,
		});
	});

	it("should pass a single feMergeNode through without recompositing it", () => {
		const nodes = parse(`<feMerge><feMergeNode in="SourceGraphic"/></feMerge>`);
		expect(nodes?.map((n) => [n.processor, n.params])).toEqual([
			["svg:offset", { in: "SourceGraphic", dx: 0, dy: 0 }],
		]);
	});

	it("should skip a convolution kernel larger than the pass supports", () => {
		const kernel = Array.from({ length: 81 }, () => 1).join(" ");
		expect(
			parse(`<feConvolveMatrix order="9" kernelMatrix="${kernel}"/>`),
		).toBeNull();
	});

	it("should return null when nothing is supported", () => {
		expect(parse(`<feTile/>`)).toBeNull();
		expect(parse(``)).toBeNull();
	});
});

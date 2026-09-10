import { beforeAll, describe, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createStrokeBrushSettings,
} from "../../document/factory";
import { BLEND_MODE_ORDER } from "../../renderer/canvas/CanvasLayerTypes";
import type { SvgFilterInput } from "../../renderer/filters/svg/svgFilterInput";
import {
	type Artboard,
	type Document,
	type Filter,
	generateUid,
	type StrokeAppearance,
} from "../../schema";
import { loadTestFont } from "../../testUtils/fontSetup";
import { rectPath, solidFillAppearance } from "../../testUtils/svgFixtures";
import { expectSvgMatchesGpu } from "../../testUtils/svgGpuParity";
import { createTestRenderer } from "../../testUtils/visualRegression";
import { getFontManager } from "../../typography/fonts";

/**
 * Per-primitive parity between the GPU render and resvg's rasterization of
 * the exported SVG. Each case is one small element carrying a chain, so a
 * divergence points straight at the primitive (and input wiring) at fault.
 * No baselines are stored here; the export VRT keeps those.
 */

interface ParityCase {
	name: string;
	filters: Filter[];
	/** Allowed diff as % of content pixels; blur-like primitives get slack
	 *  for resvg's IIR / box approximations against the GPU's true Gaussian. */
	maxDiff: number;
}

const INPUTS: readonly SvgFilterInput[] = [
	"previous",
	"SourceGraphic",
	"SourceAlpha",
];
const BLUR_DIFF = 3;
const EXACT_DIFF = 0.5;

beforeAll(() => {
	loadTestFont(getFontManager());
});

describe("SVG filter primitives - GPU vs resvg parity", () => {
	it.each(buildCases())("$name", async ({ name, filters, maxDiff }) => {
		const { renderer } = await createTestRenderer();
		const { doc, artboard } = buildDocument(filters);
		await expectSvgMatchesGpu(renderer, artboard, doc, name, maxDiff, {
			baseline: false,
		});
	});
});

// --- Cases ---

function buildCases(): ParityCase[] {
	const cases: ParityCase[] = [];
	const add = (name: string, filters: Filter[], maxDiff = EXACT_DIFF) =>
		cases.push({ name, filters, maxDiff });

	// Single-input primitives read the element directly, then read each
	// input kind behind a flood so "previous" (the flood) differs from the
	// element (SourceGraphic / SourceAlpha).
	const singleInput: Array<
		[string, (input: SvgFilterInput) => Filter, number]
	> = [
		["gaussian-blur", (input) => gaussianBlur(input, 1.5), BLUR_DIFF],
		["offset", (input) => offset(input, 6, -6), EXACT_DIFF],
		["morphology-erode", (input) => morphology(input, "erode", 2), EXACT_DIFF],
		[
			"morphology-dilate",
			(input) => morphology(input, "dilate", 2),
			EXACT_DIFF,
		],
		["drop-shadow", (input) => dropShadow(input), BLUR_DIFF],
		[
			"color-matrix-saturate",
			(input) => colorMatrix(input, "saturate", [0.3]),
			EXACT_DIFF,
		],
		[
			"convolve-sharpen",
			(input) => convolve(input, "duplicate", true),
			EXACT_DIFF,
		],
	];
	for (const [name, make, maxDiff] of singleInput) {
		add(name, [make("previous")], maxDiff);
		for (const input of INPUTS) {
			add(
				`${name}-after-flood-${input}`,
				[flood(1, 0, 0, 1), make(input)],
				maxDiff,
			);
		}
	}

	add("flood", [flood(0, 0.4, 1, 0.5)]);
	add("color-matrix-matrix", [
		colorMatrix(
			"previous",
			"matrix",
			[0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0],
		),
	]);
	add("color-matrix-hue-rotate", [colorMatrix("previous", "hueRotate", [150])]);
	add("color-matrix-luminance-to-alpha", [
		colorMatrix("previous", "luminanceToAlpha", []),
	]);
	add("component-transfer-table", [
		componentTransfer({ type: "table", tableValues: [1, 0.2, 0.8] }),
	]);
	add("component-transfer-discrete", [
		componentTransfer({ type: "discrete", tableValues: [0.1, 0.9] }),
	]);
	add("component-transfer-linear", [
		componentTransfer({ type: "linear", slope: 0.5, intercept: 0.25 }),
	]);
	add("component-transfer-gamma", [
		componentTransfer({
			type: "gamma",
			amplitude: 1,
			exponent: 2.2,
			offset: 0,
		}),
	]);
	for (const edgeMode of ["duplicate", "wrap", "none"] as const) {
		for (const preserveAlpha of [true, false]) {
			add(`convolve-${edgeMode}-${preserveAlpha ? "preserve" : "full"}`, [
				convolve("previous", edgeMode, preserveAlpha),
			]);
		}
	}
	// A bias on a translucent result: alpha takes the bias as is, color takes
	// it scaled by the resulting alpha.
	add("convolve-bias", [
		svgFilter("svg:component-transfer", {
			in: "previous",
			r: { type: "identity" },
			g: { type: "identity" },
			b: { type: "identity" },
			a: { type: "linear", slope: 0.5, intercept: 0 },
		}),
		svgFilter("svg:convolve-matrix", {
			in: "previous",
			order: 3,
			kernelMatrix: [0, 0, 0, 0, 1, 0, 0, 0, 0],
			divisor: 1,
			bias: 0.25,
			edgeMode: "duplicate",
			preserveAlpha: false,
		}),
	]);
	// A table longer than any fixed uniform block would hold.
	add("component-transfer-long-table", [
		componentTransfer({
			type: "table",
			tableValues: [...Array.from({ length: 16 }, () => 0), 1],
		}),
	]);
	add("turbulence-fractal", [turbulence("fractalNoise", 3)], BLUR_DIFF);
	add("turbulence-turbulence", [turbulence("turbulence", 3)], BLUR_DIFF);
	add("turbulence-stitch", [turbulence("fractalNoise", 2, true)], BLUR_DIFF);

	const pairs: Array<[SvgFilterInput, SvgFilterInput]> = [
		["previous", "SourceGraphic"],
		["SourceGraphic", "previous"],
		["previous", "SourceAlpha"],
	];
	for (const [input, input2] of pairs) {
		// resvg reads the displacement map premultiplied, against the spec
		// (and the GPU pass); an opaque map sidesteps that divergence.
		add(
			`displacement-${input}-${input2}`,
			[
				turbulence("fractalNoise", 2),
				opaqueAlpha("previous"),
				displacementMap(input, input2, 12),
			],
			BLUR_DIFF,
		);
		for (const operator of [
			"over",
			"in",
			"out",
			"atop",
			"xor",
			"arithmetic",
		] as const) {
			add(`composite-${operator}-${input}-${input2}`, [
				flood(0, 0.4, 1, 0.8),
				composite(input, input2, operator),
			]);
		}
	}
	for (const mode of BLEND_MODE_ORDER) {
		add(`blend-${mode}`, [flood(0.2, 0.7, 0.3, 0.8), blend(mode)]);
	}
	for (const [fn, amount] of [
		["saturate", 0.3],
		["hue-rotate", 120],
		["grayscale", 0.8],
		["sepia", 0.7],
		["invert", 0.9],
		["brightness", 1.4],
		["contrast", 1.6],
	] as const) {
		add(`color-function-${fn}`, [
			svgFilter(`svg:${fn}`, { in: "previous", amount }),
		]);
	}
	add(
		"graph-shadow",
		[
			svgFilter("svg:filter", {
				nodes: [
					{
						id: "blur",
						processor: "svg:gaussian-blur",
						params: {
							in: "SourceAlpha",
							stdDeviationX: 1.5,
							stdDeviationY: 1.5,
						},
					},
					{
						id: "shift",
						processor: "svg:offset",
						params: { in: "previous", dx: 5, dy: -5 },
					},
					{
						id: "tint",
						processor: "svg:flood",
						params: {
							color: { type: "rgb", r: 0.2, g: 0.2, b: 0.8, a: 1 },
							opacity: 0.6,
						},
					},
					{
						id: "shadow",
						processor: "svg:composite",
						params: {
							in: "previous",
							in2: "ref:shift",
							operator: "in",
							k1: 0,
							k2: 0,
							k3: 0,
							k4: 0,
						},
					},
					{
						id: "out",
						processor: "svg:composite",
						params: {
							in: "SourceGraphic",
							in2: "ref:shadow",
							operator: "over",
							k1: 0,
							k2: 0,
							k3: 0,
							k4: 0,
						},
					},
				],
			}),
		],
		BLUR_DIFF,
	);
	add(
		"chain-blur-offset-composite",
		[
			gaussianBlur("SourceAlpha", 1.5),
			offset("previous", 5, -5),
			composite("SourceGraphic", "previous", "over"),
		],
		BLUR_DIFF,
	);
	return cases;
}

// --- Document ---

function buildDocument(filters: Filter[]): {
	doc: Document;
	artboard: Artboard;
} {
	const doc = createDefaultDocument("doc-svg-parity");
	const artboard = createArtboard("ab-parity", "Parity", 0, 0, 120, 120);
	doc.artboards = [artboard];
	const element = rectPath("el-parity", { x: -6, y: 4 }, 60, 40, [
		solidFillAppearance(0.95, 0.55, 0.15),
		stroke(0.15, 0.1, 0.3, 4),
		...filters,
	]);
	doc.objects[element.id] = element;
	doc.layers[0].elementIds = [element.id];
	return { doc, artboard };
}

function stroke(
	r: number,
	g: number,
	b: number,
	width: number,
): StrokeAppearance {
	return {
		uid: generateUid("app"),
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor: { type: "solid", color: { type: "rgb", r, g, b, a: 1 } },
				brushSettings: createStrokeBrushSettings(width),
			},
		},
	};
}

// --- Filters ---

function svgFilter(processor: string, params: object): Filter {
	return {
		uid: generateUid("filter"),
		processor,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params },
	};
}

function gaussianBlur(input: SvgFilterInput, sigma: number): Filter {
	return svgFilter("svg:gaussian-blur", {
		in: input,
		stdDeviationX: sigma,
		stdDeviationY: sigma,
	});
}

function offset(input: SvgFilterInput, dx: number, dy: number): Filter {
	return svgFilter("svg:offset", { in: input, dx, dy });
}

function flood(r: number, g: number, b: number, opacity: number): Filter {
	return svgFilter("svg:flood", {
		color: { type: "rgb", r, g, b, a: 1 },
		opacity,
	});
}

function colorMatrix(
	input: SvgFilterInput,
	type: string,
	values: number[],
): Filter {
	return svgFilter("svg:color-matrix", { in: input, type, values });
}

function opaqueAlpha(input: SvgFilterInput): Filter {
	return colorMatrix(
		input,
		"matrix",
		[1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
	);
}

function componentTransfer(fn: object): Filter {
	return svgFilter("svg:component-transfer", {
		in: "previous",
		r: fn,
		g: { type: "identity" },
		b: fn,
		a: { type: "identity" },
	});
}

function morphology(
	input: SvgFilterInput,
	operator: "erode" | "dilate",
	radius: number,
): Filter {
	return svgFilter("svg:morphology", {
		in: input,
		operator,
		radiusX: radius,
		radiusY: radius,
	});
}

function convolve(
	input: SvgFilterInput,
	edgeMode: "duplicate" | "wrap" | "none",
	preserveAlpha: boolean,
): Filter {
	return svgFilter("svg:convolve-matrix", {
		in: input,
		order: 3,
		kernelMatrix: [0, -1, 0, -1, 5, -1, 0, -1, 0],
		divisor: null,
		bias: 0,
		edgeMode,
		preserveAlpha,
	});
}

function turbulence(
	type: "fractalNoise" | "turbulence",
	numOctaves: number,
	stitchTiles = false,
): Filter {
	return svgFilter("svg:turbulence", {
		type,
		baseFrequencyX: 0.03,
		baseFrequencyY: 0.05,
		numOctaves,
		seed: 3,
		stitchTiles,
	});
}

function displacementMap(
	input: SvgFilterInput,
	input2: SvgFilterInput,
	scale: number,
): Filter {
	return svgFilter("svg:displacement-map", {
		in: input,
		in2: input2,
		scale,
		xChannelSelector: "R",
		yChannelSelector: "G",
	});
}

function composite(
	input: SvgFilterInput,
	input2: SvgFilterInput,
	operator: string,
): Filter {
	return svgFilter("svg:composite", {
		in: input,
		in2: input2,
		operator,
		k1: 0.5,
		k2: 0.3,
		k3: 0.4,
		k4: 0.05,
	});
}

function blend(mode: string): Filter {
	return svgFilter("svg:blend", { in: "previous", in2: "SourceGraphic", mode });
}

function dropShadow(input: SvgFilterInput): Filter {
	return svgFilter("svg:drop-shadow", {
		in: input,
		dx: 6,
		dy: -6,
		stdDeviation: 2,
		color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
		opacity: 0.6,
	});
}

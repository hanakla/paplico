import { describe, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
	createStrokeBrushSettings,
} from "../../../document/factory";
import {
	type FillAppearance,
	type Filter,
	generateUid,
	type Path,
	type PathSegment,
	type StrokeAppearance,
} from "../../../schema";
import {
	createTestRenderer,
	expectVisualMatch,
	renderWithViewport,
} from "../../../testUtils/visualRegression";
import type { SvgBlendFilter } from "./SvgBlendHandler";
import type {
	SvgColorFunction,
	SvgColorFunctionFilter,
} from "./SvgColorFunctionHandler";
import type { SvgColorMatrixFilter } from "./SvgColorMatrixHandler";
import type { SvgComponentTransferFilter } from "./SvgComponentTransferHandler";
import type { SvgCompositeFilter } from "./SvgCompositeHandler";
import type { SvgConvolveMatrixFilter } from "./SvgConvolveMatrixHandler";
import type { SvgDisplacementMapFilter } from "./SvgDisplacementMapHandler";
import type { SvgDropShadowFilter } from "./SvgDropShadowHandler";
import type { SvgFilterGraphFilter } from "./SvgFilterGraphHandler";
import type { SvgFloodFilter } from "./SvgFloodHandler";
import type { SvgGaussianBlurFilter } from "./SvgGaussianBlurHandler";
import type { SvgMorphologyFilter } from "./SvgMorphologyHandler";
import type { SvgOffsetFilter } from "./SvgOffsetHandler";
import type { SvgTurbulenceFilter } from "./SvgTurbulenceHandler";

// Every primitive renders the same orange square with a dark stroke, so a
// baseline that still shows the plain square means the primitive did nothing.

describe("SVG filter primitives", () => {
	it("renders svg:gaussian-blur", async () => {
		await expectFilterBaseline("svg-filter-gaussian-blur", [
			gaussianBlur(4, 4),
		]);
	});

	it("renders svg:offset", async () => {
		await expectFilterBaseline("svg-filter-offset", [
			offset(10, -10, "SourceAlpha"),
		]);
	});

	it("renders svg:flood", async () => {
		await expectFilterBaseline("svg-filter-flood", [
			flood({ r: 1, g: 0, b: 0 }, 0.5),
		]);
	});

	it("renders svg:color-matrix", async () => {
		await expectFilterBaseline("svg-filter-color-matrix", [
			colorMatrix("hueRotate", [120]),
		]);
	});

	it("renders svg:component-transfer", async () => {
		await expectFilterBaseline("svg-filter-component-transfer", [
			componentTransfer(),
		]);
	});

	it("renders svg:morphology", async () => {
		await expectFilterBaseline("svg-filter-morphology", [
			morphology("dilate", 6, 6),
		]);
	});

	it("renders svg:convolve-matrix", async () => {
		await expectFilterBaseline("svg-filter-convolve-matrix", [
			convolveMatrix(),
		]);
	});

	it("renders svg:turbulence", async () => {
		await expectFilterBaseline("svg-filter-turbulence", [turbulence()]);
	});

	it("renders svg:displacement-map fed by svg:turbulence", async () => {
		await expectFilterBaseline("svg-filter-displacement-map", [
			turbulence(),
			displacementMap(24),
		]);
	});

	it("renders svg:composite clipping a flood to SourceAlpha", async () => {
		await expectFilterBaseline("svg-filter-composite", [
			flood({ r: 0, g: 0, b: 1 }, 1),
			composite("previous", "SourceAlpha", "in"),
		]);
	});

	it("renders svg:blend multiplying a flood over SourceGraphic", async () => {
		await expectFilterBaseline("svg-filter-blend", [
			flood({ r: 0, g: 1, b: 0 }, 1),
			blend("previous", "SourceGraphic", "multiply"),
		]);
	});

	it("renders svg:drop-shadow", async () => {
		await expectFilterBaseline("svg-filter-drop-shadow", [
			dropShadow(8, -8, 4, 0.6),
		]);
	});

	it("renders svg:sepia (CSS color function)", async () => {
		await expectFilterBaseline("svg-filter-sepia", [colorFunction("sepia", 1)]);
	});

	it("renders an svg:filter graph with node references", async () => {
		await expectFilterBaseline("svg-filter-graph", [
			{
				...filterBase(),
				processor: "svg:filter",
				paramData: {
					version: "1",
					params: {
						nodes: [
							{
								id: "blur",
								processor: "svg:gaussian-blur",
								params: {
									in: "SourceAlpha",
									stdDeviationX: 4,
									stdDeviationY: 4,
								},
							},
							{
								id: "shift",
								processor: "svg:offset",
								params: { in: "previous", dx: 10, dy: -10 },
							},
							{
								id: "tint",
								processor: "svg:flood",
								params: {
									color: { type: "rgb", r: 0.2, g: 0.2, b: 0.9, a: 1 },
									opacity: 0.7,
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
					},
				},
			} satisfies SvgFilterGraphFilter,
		]);
	});

	it("renders a blur → offset → desaturate → composite chain", async () => {
		await expectFilterBaseline("svg-filter-chain", [
			gaussianBlur(2, 2),
			offset(6, -6, "previous"),
			colorMatrix("saturate", [0]),
			composite("SourceGraphic", "previous", "over"),
		]);
	});
});

async function expectFilterBaseline(
	baselineName: string,
	filters: Filter[],
): Promise<void> {
	const { renderer, canvas } = await createTestRenderer();
	const doc = createSquareDoc(baselineName, filters);
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

	const texture = await renderWithViewport(renderer, canvas, doc, viewport);

	await expectVisualMatch(
		renderer,
		texture,
		texture.width,
		texture.height,
		baselineName,
		{ threshold: 0.1, maxDiffPercentage: 0.5, allowEmpty: true },
	);

	texture.destroy();
}

function createSquareDoc(id: string, filters: Filter[]) {
	const doc = createDefaultDocument(id);
	const layer = createDefaultLayer("layer-bg", "Background");

	const square = createStrokedSquare(140, filters);
	doc.objects[square.id] = square;
	layer.elementIds.push(square.id);
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab-svg", "SVG", 0, 0, 320, 240));
	return doc;
}

function gaussianBlur(
	stdDeviationX: number,
	stdDeviationY: number,
): SvgGaussianBlurFilter {
	return {
		...filterBase(),
		processor: "svg:gaussian-blur",
		paramData: {
			version: "1",
			params: { in: "previous", stdDeviationX, stdDeviationY },
		},
	};
}

function offset(
	dx: number,
	dy: number,
	input: SvgOffsetFilter["paramData"]["params"]["in"],
): SvgOffsetFilter {
	return {
		...filterBase(),
		processor: "svg:offset",
		paramData: { version: "1", params: { in: input, dx, dy } },
	};
}

function flood(
	rgb: { r: number; g: number; b: number },
	opacity: number,
): SvgFloodFilter {
	return {
		...filterBase(),
		processor: "svg:flood",
		paramData: {
			version: "1",
			params: { color: { type: "rgb", ...rgb, a: 1 }, opacity },
		},
	};
}

function colorMatrix(
	type: SvgColorMatrixFilter["paramData"]["params"]["type"],
	values: number[],
): SvgColorMatrixFilter {
	return {
		...filterBase(),
		processor: "svg:color-matrix",
		paramData: { version: "1", params: { in: "previous", type, values } },
	};
}

function componentTransfer(): SvgComponentTransferFilter {
	return {
		...filterBase(),
		processor: "svg:component-transfer",
		paramData: {
			version: "1",
			params: {
				in: "previous",
				r: { type: "gamma", amplitude: 1, exponent: 2, offset: 0 },
				g: { type: "discrete", tableValues: [0, 1] },
				b: { type: "identity" },
				a: { type: "identity" },
			},
		},
	};
}

function morphology(
	operator: SvgMorphologyFilter["paramData"]["params"]["operator"],
	radiusX: number,
	radiusY: number,
): SvgMorphologyFilter {
	return {
		...filterBase(),
		processor: "svg:morphology",
		paramData: {
			version: "1",
			params: { in: "previous", operator, radiusX, radiusY },
		},
	};
}

function convolveMatrix(): SvgConvolveMatrixFilter {
	return {
		...filterBase(),
		processor: "svg:convolve-matrix",
		paramData: {
			version: "1",
			params: {
				in: "previous",
				order: 3,
				// Emboss kernel: opposite-signed weights across the diagonal.
				kernelMatrix: [-2, -1, 0, -1, 1, 1, 0, 1, 2],
				divisor: null,
				bias: 0,
				edgeMode: "duplicate",
				preserveAlpha: true,
			},
		},
	};
}

function turbulence(): SvgTurbulenceFilter {
	return {
		...filterBase(),
		processor: "svg:turbulence",
		paramData: {
			version: "1",
			params: {
				type: "fractalNoise",
				baseFrequencyX: 0.03,
				baseFrequencyY: 0.03,
				numOctaves: 3,
				seed: 5,
				stitchTiles: false,
			},
		},
	};
}

function displacementMap(scale: number): SvgDisplacementMapFilter {
	return {
		...filterBase(),
		processor: "svg:displacement-map",
		paramData: {
			version: "1",
			params: {
				in: "SourceGraphic",
				in2: "previous",
				scale,
				xChannelSelector: "R",
				yChannelSelector: "G",
			},
		},
	};
}

function composite(
	input: SvgCompositeFilter["paramData"]["params"]["in"],
	in2: SvgCompositeFilter["paramData"]["params"]["in2"],
	operator: SvgCompositeFilter["paramData"]["params"]["operator"],
): SvgCompositeFilter {
	return {
		...filterBase(),
		processor: "svg:composite",
		paramData: {
			version: "1",
			params: { in: input, in2, operator, k1: 0, k2: 0, k3: 0, k4: 0 },
		},
	};
}

function blend(
	input: SvgBlendFilter["paramData"]["params"]["in"],
	in2: SvgBlendFilter["paramData"]["params"]["in2"],
	mode: SvgBlendFilter["paramData"]["params"]["mode"],
): SvgBlendFilter {
	return {
		...filterBase(),
		processor: "svg:blend",
		paramData: { version: "1", params: { in: input, in2, mode } },
	};
}

function dropShadow(
	dx: number,
	dy: number,
	stdDeviation: number,
	opacity: number,
): SvgDropShadowFilter {
	return {
		...filterBase(),
		processor: "svg:drop-shadow",
		paramData: {
			version: "1",
			params: {
				in: "previous",
				dx,
				dy,
				stdDeviation,
				color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				opacity,
			},
		},
	};
}

function colorFunction(
	fn: SvgColorFunction,
	amount: number,
): SvgColorFunctionFilter {
	return {
		...filterBase(),
		processor: `svg:${fn}`,
		paramData: { version: "1", params: { in: "previous", amount } },
	};
}

function filterBase() {
	return {
		uid: generateUid("filter"),
		opacity: 1,
		blendMode: "normal" as const,
		enabled: true,
	};
}

function createStrokedSquare(size: number, filters: Filter[]): Path {
	const fillApp: FillAppearance = {
		uid: generateUid("fill"),
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r: 1, g: 0.55, b: 0.1, a: 1 },
				},
			},
		},
	};
	const strokeApp: StrokeAppearance = {
		uid: generateUid("stroke"),
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor: {
					type: "solid",
					color: { type: "rgb", r: 0.15, g: 0.1, b: 0.2, a: 1 },
				},
				brushSettings: createStrokeBrushSettings(6),
			},
		},
	};

	return {
		type: "path",
		id: generateUid("path"),
		opacity: 1,
		blendMode: "normal",
		segments: squareSegments(size),
		filters: [fillApp, strokeApp, ...filters],
		transform: createDefaultTransform(),
	};
}

function squareSegments(size: number): PathSegment[] {
	const half = size / 2;
	const points = [
		{ x: -half, y: half },
		{ x: half, y: half },
		{ x: half, y: -half },
		{ x: -half, y: -half },
	];
	return points.map((point, index) => ({
		start: index === 0 ? point : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: points[(index + 1) % points.length],
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: index === 0,
		isClosed: index === points.length - 1,
	}));
}

/**
 * Built-in brush EmbeddedFiles and BrushPresets.
 *
 * Extracts the pixel generation logic from BrushTextureManager into
 * standalone functions so it can be reused (e.g. for document
 * initialization without a GPU device).
 */

import { airBrush, pencil } from "../assets";
import {
	type BrushCurve,
	type BrushPreset,
	type BrushPresetCategory,
	type BrushSettings,
	BUILTIN_BRUSH_IDS,
	BUILTIN_PAPER_IDS,
	type BuiltinBrushId,
	type EmbeddedFile,
} from "../schema";

// Paper grain textures tile, so they can be smaller than a brush stamp
const PAPER_SIZE = 256;

// Texture size used for programmatically generated brushes
const TEXTURE_SIZE = 128;

/**
 * Built-in brush presets keyed by texture file UID.
 *
 * Note: Hard Round (BUILTIN_BRUSH_IDS.hardCircle) and Calligraphy
 * (BUILTIN_BRUSH_IDS.calligraphy) both render a procedural elliptical nib and
 * carry no texture. The hardCircle EmbeddedFile is retained for documents
 * authored before the brush-system rework — those references resolve via the
 * BrushTextureManager fallback chain.
 */
export const BRUSH_PRESETS: Record<BuiltinBrushId, BrushSettings> = {
	[BUILTIN_BRUSH_IDS.svg]: {
		version: 2,
		engine: "geometric",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: {
				base: 10,
			},
			flow: {
				base: 1,
			},
		},
		randomSeed: 0,
	},
	[BUILTIN_BRUSH_IDS.hardCircle]: {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: {
				base: 10,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.3],
							[1, 0],
						],
					},
					{
						input: "speedFine",
						points: [
							[0, 0],
							[1, -0.5],
						],
					},
				],
			},
			ratio: {
				base: 1,
			},
			flow: {
				base: 1,
			},
			spacing: {
				base: 0.05,
			},
		},
		randomSeed: 0,
		tip: {
			kind: "procedural",
			hardness: 1,
			angleMode: "fixed",
		},
	},
	[BUILTIN_BRUSH_IDS.calligraphy]: {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: {
				base: 10,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.3],
							[1, 0],
						],
					},
					{
						input: "speedFine",
						points: [
							[0, 0],
							[1, -0.5],
						],
					},
				],
			},
			ratio: {
				base: 0.25,
			},
			angle: {
				base: 0.7853981633974483,
			},
			flow: {
				base: 1,
			},
			spacing: {
				base: 0.05,
			},
		},
		randomSeed: 0,
		tip: {
			kind: "procedural",
			hardness: 1,
			angleMode: "fixed",
		},
	},
	[BUILTIN_BRUSH_IDS.softCircle]: {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: {
				base: 10,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.5],
							[1, 0],
						],
					},
					{
						input: "speedFine",
						points: [
							[0, 0],
							[1, -0.5],
						],
					},
				],
			},
			flow: {
				base: 1,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.2],
							[1, 0],
						],
					},
				],
			},
			spacing: {
				base: 0.1,
			},
		},
		randomSeed: 0,
		tip: {
			kind: "image",
			sources: [
				{
					kind: "file",
					fileUid: "builtin-brush-soft-circle",
				},
			],
			selection: "random",
			angleMode: "fixed",
		},
	},
	[BUILTIN_BRUSH_IDS.pencil]: {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: {
				base: 10,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.3],
							[1, 0],
						],
					},
					{
						input: "speedFine",
						points: [
							[0, 0],
							[1, -0.5],
						],
					},
				],
			},
			flow: {
				base: 0.8,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.5],
							[1, 0],
						],
					},
				],
			},
			spacing: {
				base: 0.08,
			},
		},
		randomSeed: 0,
		tip: {
			kind: "image",
			sources: [
				{
					kind: "file",
					fileUid: "builtin-brush-pencil",
				},
			],
			selection: "random",
			angleMode: "fixed",
		},
	},
	[BUILTIN_BRUSH_IDS.airbrush]: {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: {
				base: 10,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.2],
							[1, 0],
						],
					},
					{
						input: "speedFine",
						points: [
							[0, 0],
							[1, -0.5],
						],
					},
				],
			},
			flow: {
				base: 0.4,
				curves: [
					{
						input: "pressure",
						points: [
							[0, -0.6],
							[1, 0],
						],
					},
				],
			},
			spacing: {
				base: 0.05,
			},
		},
		randomSeed: 0,
		tip: {
			kind: "image",
			sources: [
				{
					kind: "file",
					fileUid: "builtin-brush-airbrush",
				},
			],
			selection: "random",
			angleMode: "fixed",
		},
	},
};

/** Shelf order of the builtin preset list. A preset whose category is not
 *  here never reaches the panel, so the preset tests assert against it. */
export const BUILTIN_PRESET_CATEGORY_ORDER = [
	"pen",
	"airbrush",
	"watercolor",
	"calligraphy",
	"effect",
	"other",
] as const;

// -- Public API --------------------------------------------------------------

/** Create EmbeddedFile entries for all four built-in brush textures. */
export async function createBuiltinBrushFiles(): Promise<EmbeddedFile[]> {
	// Generate pixel data for programmatic brushes
	const hardPixels = generateHardCirclePixels(TEXTURE_SIZE);
	const softPixels = generateSoftCirclePixels(TEXTURE_SIZE);

	// Encode to PNG blobs
	const [hardBlob, softBlob] = await Promise.all([
		pixelsToBlob(hardPixels, TEXTURE_SIZE),
		pixelsToBlob(softPixels, TEXTURE_SIZE),
	]);

	// Convert blobs to Uint8Array
	const [hardBin, softBin] = await Promise.all([
		hardBlob.arrayBuffer().then((buf) => new Uint8Array(buf)),
		softBlob.arrayBuffer().then((buf) => new Uint8Array(buf)),
	]);

	// Paper grain textures: value noise at two frequencies.
	const [finePaperBlob, coarsePaperBlob] = await Promise.all([
		pixelsToBlob(generatePaperGrainPixels(PAPER_SIZE, 24, 3), PAPER_SIZE),
		pixelsToBlob(generatePaperGrainPixels(PAPER_SIZE, 8, 4), PAPER_SIZE),
	]);
	const [finePaperBin, coarsePaperBin] = await Promise.all([
		finePaperBlob.arrayBuffer().then((buf) => new Uint8Array(buf)),
		coarsePaperBlob.arrayBuffer().then((buf) => new Uint8Array(buf)),
	]);
	const [finePaperHash, coarsePaperHash] = await Promise.all([
		computeHash(finePaperBin),
		computeHash(coarsePaperBin),
	]);

	// Decode base64 asset brushes
	const pencilBin = base64ToUint8Array(pencil);
	const airbrushBin = base64ToUint8Array(airBrush);

	// Compute hashes in parallel
	const [hardHash, softHash, pencilHash, airbrushHash] = await Promise.all([
		computeHash(hardBin),
		computeHash(softBin),
		computeHash(pencilBin),
		computeHash(airbrushBin),
	]);

	return [
		{
			uid: BUILTIN_BRUSH_IDS.hardCircle,
			name: "Hard Circle Brush",
			type: "image/png",
			hash: hardHash,
			bin: hardBin,
		},
		{
			uid: BUILTIN_BRUSH_IDS.softCircle,
			name: "Soft Brush",
			type: "image/png",
			hash: softHash,
			bin: softBin,
		},
		{
			uid: BUILTIN_BRUSH_IDS.pencil,
			name: "Pencil Brush",
			type: "image/png",
			hash: pencilHash,
			bin: pencilBin,
		},
		{
			uid: BUILTIN_BRUSH_IDS.airbrush,
			name: "Airbrush",
			type: "image/png",
			hash: airbrushHash,
			bin: airbrushBin,
		},
		{
			uid: BUILTIN_PAPER_IDS.finePaper,
			name: "Fine Paper",
			type: "image/png",
			hash: finePaperHash,
			bin: finePaperBin,
		},
		{
			uid: BUILTIN_PAPER_IDS.coarsePaper,
			name: "Coarse Paper",
			type: "image/png",
			hash: coarsePaperHash,
			bin: coarsePaperBin,
		},
	];
}

/** Create BrushPreset entries for all built-in brushes. */
export function createBuiltinBrushPresets(): BrushPreset[] {
	const presets: Array<{
		builtinId: BuiltinBrushId;
		name: string;
		category: BrushPresetCategory;
	}> = [
		{ builtinId: BUILTIN_BRUSH_IDS.svg, name: "Pen (SVG)", category: "pen" },
		{
			builtinId: BUILTIN_BRUSH_IDS.hardCircle,
			name: "Hard Round",
			category: "pen",
		},
		{
			builtinId: BUILTIN_BRUSH_IDS.calligraphy,
			name: "Calligraphy",
			category: "calligraphy",
		},
		{
			builtinId: BUILTIN_BRUSH_IDS.softCircle,
			name: "Soft Circle",
			category: "airbrush",
		},
		{ builtinId: BUILTIN_BRUSH_IDS.pencil, name: "Pencil", category: "pen" },
		{
			builtinId: BUILTIN_BRUSH_IDS.airbrush,
			name: "Airbrush",
			category: "airbrush",
		},
	];

	const builtins: BrushPreset[] = presets.map(
		({ builtinId, name, category }) => ({
			uid: builtinId,
			name,
			category,
			settings: BRUSH_PRESETS[builtinId],
		}),
	);

	// Runs the wet layer on top of an existing soft-circle stamp; reuses the
	// soft circle texture so no new builtin texture is required.
	const watercolour: BrushPreset = {
		uid: "builtin-brush-watercolor",
		name: "Watercolor",
		category: "watercolor",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "wash",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.4],
								[1, 0],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
					],
				},
				flow: {
					base: 0.65,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.4],
								[1, 0],
							],
						},
					],
				},
				spacing: {
					base: 0.06,
				},
				colorRate: {
					base: 0.755,
				},
				wetness: {
					base: 0.8,
					curves: [
						{
							input: "speedGross",
							points: [
								[0, 0],
								[1, -0.4],
							],
						},
						{
							input: "accel",
							points: [
								[0, 0],
								[1, 0.2],
							],
						},
					],
				},
				directionality: {
					base: 0.3,
				},
				grainAmount: {
					base: 0.25,
				},
				absorption: {
					base: 0.35,
				},
				granulation: {
					base: 0.25,
				},
				bleedSoftness: {
					base: 0.55,
				},
				edgeDarkening: {
					base: 0.45,
				},
				edgeRoughness: {
					base: 0.35,
				},
			},
			randomSeed: 0,
			tip: {
				kind: "image",
				sources: [
					{
						kind: "file",
						fileUid: "builtin-brush-soft-circle",
					},
				],
				selection: "random",
				angleMode: "fixed",
			},
			mixing: {
				enabled: false,
				mode: "dulling",
				sampleRadius: 1,
				sampleTrail: 1,
				blendStyle: 0,
			},
			wet: {
				enabled: true,
				bleedRadius: 0.5,
				pigmentLoad: 0.85,
				grainScale: 1.2,
			},
		},
	};

	// Fast, high-absorption strokes over the grainy pencil stamp; bleeds only a
	// little so the texture reads as dragged-out pigment.
	const dryBrush: BrushPreset = {
		uid: "builtin-brush-dry-brush",
		name: "Dry Brush",
		category: "watercolor",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "wash",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.35],
								[1, 0],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
					],
				},
				flow: {
					base: 0.7,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.4],
								[1, 0],
							],
						},
					],
				},
				spacing: {
					base: 0.08,
				},
				colorRate: {
					base: 0.755,
				},
				wetness: {
					base: 0.3,
					curves: [
						{
							input: "speedGross",
							points: [
								[0, 0],
								[1, -0.27],
							],
						},
						{
							input: "accel",
							points: [
								[0, 0],
								[1, 0.03],
							],
						},
					],
				},
				directionality: {
					base: 0.15,
				},
				grainAmount: {
					base: 0.6,
				},
				absorption: {
					base: 0.7,
				},
				granulation: {
					base: 0.65,
				},
				bleedSoftness: {
					base: 0.2,
				},
				edgeDarkening: {
					base: 0.2,
				},
				edgeRoughness: {
					base: 0.55,
				},
			},
			randomSeed: 0,
			tip: {
				kind: "image",
				sources: [
					{
						kind: "file",
						fileUid: "builtin-brush-pencil",
					},
				],
				selection: "random",
				angleMode: "fixed",
			},
			mixing: {
				enabled: false,
				mode: "dulling",
				sampleRadius: 1,
				sampleTrail: 1,
				blendStyle: 0,
			},
			wet: {
				enabled: true,
				bleedRadius: 0.15,
				pigmentLoad: 1,
				grainScale: 1.6,
			},
		},
	};

	// Very wet strokes that spread far and mix with the colors already on the
	// layer via underlying-color pickup.
	const bleedWatercolor: BrushPreset = {
		uid: "builtin-brush-bleed-watercolor",
		name: "Bleed Watercolor",
		category: "watercolor",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "wash",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.4],
								[1, 0],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
					],
				},
				flow: {
					base: 0.5,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.35],
								[1, 0],
							],
						},
					],
				},
				spacing: {
					base: 0.06,
				},
				colorRate: {
					base: 0.615,
				},
				wetness: {
					base: 0.95,
					curves: [
						{
							input: "speedGross",
							points: [
								[0, 0],
								[1, -0.2375],
							],
						},
						{
							input: "accel",
							points: [
								[0, 0],
								[1, 0.285],
							],
						},
					],
				},
				directionality: {
					base: 0.4,
				},
				grainAmount: {
					base: 0.3,
				},
				absorption: {
					base: 0.2,
				},
				granulation: {
					base: 0.3,
				},
				bleedSoftness: {
					base: 0.75,
				},
				edgeDarkening: {
					base: 0.55,
				},
				edgeRoughness: {
					base: 0.4,
				},
			},
			randomSeed: 0,
			tip: {
				kind: "image",
				sources: [
					{
						kind: "file",
						fileUid: "builtin-brush-soft-circle",
					},
				],
				selection: "random",
				angleMode: "fixed",
			},
			mixing: {
				enabled: true,
				mode: "dulling",
				sampleRadius: 1,
				sampleTrail: 1,
				blendStyle: 0,
			},
			wet: {
				enabled: true,
				bleedRadius: 0.85,
				pigmentLoad: 0.7,
				grainScale: 1.2,
			},
		},
	};

	const gPen: BrushPreset = {
		uid: "builtin-brush-g-pen",
		name: "G-Pen",
		category: "pen",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.85],
								[1, 0],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
					],
				},
				ratio: {
					base: 1,
				},
				flow: {
					base: 1,
				},
				spacing: {
					base: 0.05,
				},
			},
			randomSeed: 0,
			tip: {
				kind: "procedural",
				hardness: 1,
				angleMode: "fixed",
			},
		},
	};

	const marker: BrushPreset = {
		uid: "builtin-brush-marker",
		name: "Marker",
		category: "pen",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
					],
				},
				flow: {
					base: 0.765,
				},
				spacing: {
					base: 0.05,
				},
			},
			randomSeed: 0,
			tip: {
				kind: "image",
				sources: [
					{
						kind: "file",
						fileUid: "builtin-brush-hard-circle",
					},
				],
				selection: "random",
				angleMode: "fixed",
			},
		},
	};

	const ink: BrushPreset = {
		uid: "builtin-brush-ink",
		name: "Ink",
		category: "pen",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.7],
								[1, 0],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0.072],
								[1, 0],
							],
						},
					],
				},
				ratio: {
					base: 1,
				},
				flow: {
					base: 1,
					curves: [
						{
							input: "speedFine",
							points: [
								[0, 0.18],
								[1, 0],
							],
						},
					],
				},
				spacing: {
					base: 0.05,
					curves: [
						{
							input: "speedFine",
							points: [
								[0, -0.36],
								[1, 0],
							],
						},
					],
				},
			},
			randomSeed: 0,
			tip: {
				kind: "procedural",
				hardness: 1,
				angleMode: "fixed",
			},
		},
	};

	const softAirbrush: BrushPreset = {
		uid: "builtin-brush-soft-airbrush",
		name: "Soft Airbrush",
		category: "airbrush",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 30,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.1],
								[1, 0],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
					],
				},
				flow: {
					base: 0.15,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.7],
								[1, 0],
							],
						},
					],
				},
				spacing: {
					base: 0.04,
				},
			},
			randomSeed: 0,
			tip: {
				kind: "image",
				sources: [
					{
						kind: "file",
						fileUid: "builtin-brush-soft-circle",
					},
				],
				selection: "random",
				angleMode: "fixed",
			},
		},
	};

	// Picks up whatever is already on the layer and drags it along, the way a
	// damp brush moves paint around. The pickup amount rides on pressure.
	const mixingBrush: BrushPreset = {
		uid: "builtin-brush-mixing",
		name: "Mixing Brush",
		category: "watercolor",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "wash",
			properties: {
				size: {
					base: 28,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.4],
								[1, 0],
							],
						},
						speedThinning(),
					],
				},
				spacing: { base: 0.05 },
				flow: { base: 0.5 },
				hardness: { base: 0.35 },
				colorRate: {
					base: 0.75,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.5],
								[1, 0],
							],
						},
					],
				},
				alphaRate: { base: 0.4 },
				smudgeLength: { base: 0.7 },
			},
			tip: { kind: "procedural", hardness: 0.35, angleMode: "fixed" },
			mixing: {
				enabled: true,
				mode: "dulling",
				sampleRadius: 1.2,
				sampleTrail: 1,
				blendStyle: 0.35,
			},
			randomSeed: 41,
		},
	};

	// Softens what is already on the layer instead of adding paint: the
	// composite below the stroke is blurred and shown through the stroke's
	// coverage, so at full flow the backdrop under the stroke is exactly its
	// blurred self. Light pressure lets the sharp picture show through.
	const blur: BrushPreset = {
		uid: "builtin-brush-blur",
		name: "Blur",
		category: "effect",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "wash",
			properties: {
				size: {
					base: 40,
					curves: [speedThinning()],
				},
				spacing: { base: 0.05 },
				hardness: { base: 0.4 },
				flow: {
					base: 1,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.8],
								[1, 0],
							],
						},
					],
				},
			},
			tip: { kind: "procedural", hardness: 0.4, angleMode: "fixed" },
			backdropBlur: { enabled: true, radius: 0.5 },
			randomSeed: 53,
		},
	};

	// The same blur, thrown off the stroke line: each dab lands somewhere
	// around where the pointer went, so the coverage breaks into grain and
	// the blurred picture shows through in specks rather than a smooth band.
	const scatterBlur: BrushPreset = {
		uid: "builtin-brush-scatter-blur",
		name: "Scatter Blur",
		category: "effect",
		settings: {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "wash",
			properties: {
				size: {
					base: 26,
					curves: [
						speedThinning(),
						{
							input: "randomPerDab",
							points: [
								[0, -0.45],
								[1, 0.2],
							],
						},
					],
				},
				spacing: { base: 0.08 },
				hardness: { base: 0.25 },
				flow: { base: 0.7 },
				scatterOffset: { base: 0.8 },
				scatterAlong: { base: 0.4 },
			},
			tip: { kind: "procedural", hardness: 0.25, angleMode: "fixed" },
			backdropBlur: { enabled: true, radius: 0.6 },
			randomSeed: 59,
		},
	};

	return [
		...builtins,
		watercolour,
		dryBrush,
		bleedWatercolor,
		gPen,
		marker,
		ink,
		softAirbrush,
		mixingBrush,
		blur,
		scatterBlur,
	];
}

/** Speed thinning every stamp-based builtin carries. */
function speedThinning(): BrushCurve {
	return {
		input: "speedFine",
		points: [
			[0, 0],
			[1, -0.5],
		],
	};
}

// -- Pixel generation helpers ------------------------------------------------

/** Generate RGBA pixels for a hard-edge circle (no gradient). */
function generateHardCirclePixels(size: number): Uint8Array {
	const data = new Uint8Array(size * size * 4);
	const center = size / 2;
	const radius = size / 2 - 1;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = x - center + 0.5;
			const dy = y - center + 0.5;
			const dist = Math.sqrt(dx * dx + dy * dy);

			// Hard edge: fully opaque inside the radius
			const alpha = dist <= radius ? 255 : 0;

			const idx = (y * size + x) * 4;
			// Luminance-based alpha for shader: R=G=B=alpha, A=255
			data[idx] = alpha;
			data[idx + 1] = alpha;
			data[idx + 2] = alpha;
			data[idx + 3] = 255;
		}
	}

	return data;
}

/**
 * Tiling paper grain: value noise summed over `octaves`, with `cells` cells
 * across the first octave. The lattice wraps, so the texture repeats without
 * a seam under the canvas-fixed UV the grain shader uses.
 */
export function generatePaperGrainPixels(
	size: number,
	cells: number,
	octaves: number,
): Uint8Array {
	const data = new Uint8Array(size * size * 4);
	const lattice = (cx: number, cy: number, period: number): number => {
		// Wrapped hash: cell (period, y) must equal cell (0, y).
		const x = ((cx % period) + period) % period;
		const y = ((cy % period) + period) % period;
		let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
		h = Math.imul(h ^ (h >>> 15), 0x2545f491);
		return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
	};
	const smooth = (t: number) => t * t * (3 - 2 * t);

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let value = 0;
			let amplitude = 1;
			let total = 0;
			let period = cells;
			for (let octave = 0; octave < octaves; octave++) {
				const fx = (x / size) * period;
				const fy = (y / size) * period;
				const x0 = Math.floor(fx);
				const y0 = Math.floor(fy);
				const tx = smooth(fx - x0);
				const ty = smooth(fy - y0);
				const top =
					lattice(x0, y0, period) * (1 - tx) + lattice(x0 + 1, y0, period) * tx;
				const bottom =
					lattice(x0, y0 + 1, period) * (1 - tx) +
					lattice(x0 + 1, y0 + 1, period) * tx;
				value += (top * (1 - ty) + bottom * ty) * amplitude;
				total += amplitude;
				amplitude *= 0.5;
				period *= 2;
			}
			// Centred around mid grey so multiply/subtract both stay gentle.
			const level = Math.round(
				Math.min(Math.max(0.35 + (value / total) * 0.65, 0), 1) * 255,
			);
			const idx = (y * size + x) * 4;
			data[idx] = level;
			data[idx + 1] = level;
			data[idx + 2] = level;
			data[idx + 3] = 255;
		}
	}
	return data;
}

/** Generate RGBA pixels for a soft circle with Gaussian falloff. */
function generateSoftCirclePixels(size: number): Uint8Array {
	const data = new Uint8Array(size * size * 4);
	const center = size / 2;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = (x - center + 0.5) / center;
			const dy = (y - center + 0.5) / center;
			const dist = Math.sqrt(dx * dx + dy * dy);

			// Gaussian falloff (sigma=0.4): alpha=1 at center, ~0 at edge
			const sigma = 0.4;
			const alpha =
				dist < 1 ? Math.exp((-dist * dist) / (2 * sigma * sigma)) : 0;
			const alphaU8 = Math.round(alpha * 255);

			const idx = (y * size + x) * 4;
			// Luminance-based alpha for shader: R=G=B=alpha, A=255
			data[idx] = alphaU8;
			data[idx + 1] = alphaU8;
			data[idx + 2] = alphaU8;
			data[idx + 3] = 255;
		}
	}

	return data;
}

// -- Encoding / hashing helpers ----------------------------------------------

/** Convert RGBA pixel data to a PNG blob via OffscreenCanvas. */
async function pixelsToBlob(pixels: Uint8Array, size: number): Promise<Blob> {
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to get 2d context from OffscreenCanvas");
	const imageData = new ImageData(new Uint8ClampedArray(pixels), size, size);
	ctx.putImageData(imageData, 0, 0);
	return canvas.convertToBlob({ type: "image/png" });
}

/** Decode a base64-encoded string to binary. */
function base64ToUint8Array(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

/** Compute SHA-256 hash of binary data, returned as a hex string. */
async function computeHash(bin: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", new Uint8Array(bin));
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
}

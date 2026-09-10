import {
	createDefaultColor,
	createStrokeBrushSettings,
} from "@/core/document/factory";
import {
	type BlurFilter,
	type DropShadowFilter,
	type FrostGlassFilter,
	SVG_COLOR_FUNCTIONS,
	SVG_COLOR_MATRIX_IDENTITY,
	type SvgBlendFilter,
	type SvgColorFunction,
	type SvgColorFunctionFilter,
	type SvgColorMatrixFilter,
	type SvgComponentTransferFilter,
	type SvgCompositeFilter,
	type SvgConvolveMatrixFilter,
	type SvgDisplacementMapFilter,
	type SvgDropShadowFilter,
	type SvgFilterGraphFilter,
	type SvgFloodFilter,
	type SvgGaussianBlurFilter,
	type SvgMorphologyFilter,
	type SvgOffsetFilter,
	type SvgTransferFunction,
	type SvgTurbulenceFilter,
	type ZigzagFilter,
} from "@/core/renderer/filters";
import {
	type FillAppearance,
	generateUid,
	type StrokeAppearance,
} from "@/core/schema";

/** What the catalog hands back for a processor the panel knows how to add. */
export type DefaultFilter =
	| BlurFilter
	| FrostGlassFilter
	| ZigzagFilter
	| DropShadowFilter
	| SvgGaussianBlurFilter
	| SvgOffsetFilter
	| SvgFloodFilter
	| SvgColorMatrixFilter
	| SvgComponentTransferFilter
	| SvgMorphologyFilter
	| SvgConvolveMatrixFilter
	| SvgTurbulenceFilter
	| SvgDisplacementMapFilter
	| SvgCompositeFilter
	| SvgBlendFilter
	| SvgDropShadowFilter
	| SvgColorFunctionFilter
	| SvgFilterGraphFilter
	| FillAppearance
	| StrokeAppearance;

/**
 * Builds the filter a fresh "add" produces, with the defaults the panel has
 * always used. Shared so a companion remote adding a filter lands the same
 * object the local menu would, rather than a second set of defaults that
 * drifts from this one. Null for a processor the panel cannot add.
 */
export function createDefaultFilter(processor: string): DefaultFilter | null {
	const factory = FILTER_DEFS[processor];
	if (!factory) return null;

	// The factories build plain literals; the union above is what every branch
	// actually produces, and TypeScript cannot see that through the record.
	return factory() as DefaultFilter;
}

const FILTER_DEFS: Record<string, () => ReturnType<typeof Object>> = {
	fill: () => ({
		uid: generateUid("app"),
		processor: "fill",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: createDefaultColor() },
			},
		},
	}),
	stroke: () => ({
		uid: generateUid("app"),
		processor: "stroke",
		paramData: {
			version: "1",
			params: {
				strokeColor: {
					type: "solid",
					color: createDefaultColor(),
				},
				brushSettings: createStrokeBrushSettings(1),
			},
		},
	}),
	blur: () => ({
		uid: generateUid("filter"),
		processor: "blur",
		paramData: { version: "1", params: { radius: 5 } },
	}),
	"frost-glass": () => ({
		uid: generateUid("filter"),
		processor: "frost-glass",
		paramData: {
			version: "1",
			params: { radius: 10, saturation: 1.2, tintOpacity: 0.1 },
		},
	}),
	zigzag: () => ({
		uid: generateUid("filter"),
		processor: "zigzag",
		paramData: {
			version: "1",
			params: { frequency: 10, amplitude: 5 },
		},
	}),
	"drop-shadow": () => ({
		uid: generateUid("filter"),
		processor: "drop-shadow",
		paramData: {
			version: "1",
			params: {
				offsetX: 4,
				offsetY: -4,
				blurRadius: 8,
				shadowOpacity: 0.5,
			},
		},
	}),
	pixelate: () => ({
		uid: generateUid("filter"),
		processor: "pixelate",
		paramData: {
			version: "1",
			params: {
				blockWidth: 8,
				blockHeight: 8,
				linkAxes: true,
				mode: "bilinear",
			},
		},
	}),
	"path-offset": () => ({
		uid: generateUid("filter"),
		processor: "path-offset",
		paramData: {
			version: "1",
			params: { offset: 5, joinType: "miter" as const },
		},
	}),
	"path-union": () => ({
		uid: generateUid("filter"),
		processor: "path-union",
		paramData: {
			version: "1",
			params: { mode: "union" as const },
		},
	}),
	"pucker-bloat": () => ({
		uid: generateUid("filter"),
		processor: "pucker-bloat",
		paramData: {
			version: "1",
			params: { amount: 0 },
		},
	}),
	extrude3d: () => ({
		uid: generateUid("app"),
		processor: "extrude3d",
		paramData: {
			version: "1",
			params: {
				depth: 20,
				rotationDeg: [0, 0, 0] as [number, number, number],
				perspective: 0,
				material: {
					// Flat by default so applying the extrude leaves the
					// element's color unchanged (no lighting darkens the
					// front face); the user opts into lambert/blinn-phong.
					shading: "flat" as const,
					lightDir: [-0.5, 0.7, 1] as [number, number, number],
				},
			},
		},
	}),
	revolve3d: () => ({
		uid: generateUid("app"),
		processor: "revolve3d",
		paramData: {
			version: "1",
			params: {
				angleDeg: 360,
				offset: 0,
				axis: "left" as const,
				cap: true,
				rotationDeg: [0, 0, 0] as [number, number, number],
				perspective: 0,
				material: {
					// Lambert by default — unlike extrude, the revolved
					// shape itself changes, and without shading a full
					// 360° solid reads as a flat silhouette.
					shading: "lambert" as const,
					lightDir: [-0.5, 0.7, 1] as [number, number, number],
				},
			},
		},
	}),
	// Transform
	"3d-rotate": () => ({
		uid: generateUid("filter"),
		processor: "3d-rotate",
		paramData: {
			version: "1",
			params: {
				rotateX: 0,
				rotateY: 0,
				rotateZ: 0,
				perspective: 60,
			},
		},
	}),
	// Blur
	"hk:bloom": () => ({
		uid: generateUid("filter"),
		processor: "hk:bloom",
		paramData: {
			version: "1",
			params: {
				threshold: 0.7,
				intensity: 0.5,
				radius: 5,
				blurStrength: 3,
				blendMode: "normal",
			},
		},
	}),
	"hk:directional-blur": () => ({
		uid: generateUid("filter"),
		processor: "hk:directional-blur",
		paramData: {
			version: "1",
			params: {
				strength: 10,
				angle: 0,
				opacity: 1,
				blurMode: "both",
				originalEmphasis: 0,
				fadeOut: 0,
				fadeDirection: 0.5,
			},
		},
	}),
	"hk:kirakira": () => ({
		uid: generateUid("filter"),
		processor: "hk:kirakira",
		paramData: {
			version: "1",
			params: {
				radius: 50,
				strength: 0.5,
				sparkle: 0.5,
				sparkleAlpha: false,
				blendOpacity: 1,
				makeOriginalTransparent: false,
				useCustomColor: false,
				customColor: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
			},
		},
	}),
	"hk:radial-rot-dir": () => ({
		uid: generateUid("filter"),
		processor: "hk:radial-rot-dir",
		paramData: {
			version: "1",
			params: {
				radialRate: 0,
				rotateAngle: 0,
				strength: 10,
				relativePos: 0,
				directionX: 0,
				directionY: 0,
				centerX: 0.5,
				centerY: 0.5,
				quality: 16,
			},
		},
	}),
	// Hanakla Kit — Color
	"hk:gradient-map": () => ({
		uid: generateUid("filter"),
		processor: "hk:gradient-map",
		paramData: {
			version: "1",
			params: { preset: "blackAndWhite", colorStops: "[]", strength: 1 },
		},
	}),
	"hk:posterization": () => ({
		uid: generateUid("filter"),
		processor: "hk:posterization",
		paramData: { version: "1", params: { levels: 4, strength: 1 } },
	}),
	"hk:color-replacement": () => ({
		uid: generateUid("filter"),
		processor: "hk:color-replacement",
		paramData: {
			version: "1",
			params: {
				sourceColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				replacementColor: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
				tolerance: 0.45,
				preserveLuminance: true,
				mix: 1,
				featherEdges: 0.2,
				previewMask: false,
			},
		},
	}),
	"hk:selective-correction": () => ({
		uid: generateUid("filter"),
		processor: "hk:selective-correction",
		paramData: {
			version: "1",
			params: {
				blendMode: "normal",
				mix: 1,
				featherEdges: 0.05,
				previewMask: false,
				useCondition: false,
				targetHue: 0,
				hueRange: 30,
				saturationMin: 0,
				saturationMax: 1,
				brightnessMin: 0,
				brightnessMax: 1,
				hueShift: 0,
				saturationScale: 1,
				vibrance: 0,
				brightnessScale: 1,
				contrast: 0,
			},
		},
	}),
	// Hanakla Kit — Distortion
	"hk:fluid": () => ({
		uid: generateUid("filter"),
		processor: "hk:fluid",
		paramData: {
			version: "1",
			params: {
				intensity: 20,
				speed: 1,
				scale: 1,
				turbulence: 1,
				colorShift: 0,
				padding: 0,
				timeSeed: 0,
			},
		},
	}),
	"hk:glitch": () => ({
		uid: generateUid("filter"),
		processor: "hk:glitch",
		paramData: {
			version: "1",
			params: {
				intensity: 0.3,
				slices: 10,
				colorShift: 0.01,
				angle: 0,
				bias: 0,
				seed: 42,
			},
		},
	}),
	"hk:spraying": () => ({
		uid: generateUid("filter"),
		processor: "hk:spraying",
		paramData: {
			version: "1",
			params: { strength: 10, seed: 42, blockSize: 4 },
		},
	}),
	"hk:turbulence": () => ({
		uid: generateUid("filter"),
		processor: "hk:turbulence",
		paramData: {
			version: "1",
			params: {
				scale: 100,
				octaves: 4,
				seed: 42,
				displacementX: 30,
				displacementY: 30,
				displacementMode: "cartesian",
				edgeMode: "clamp",
				opacity: 1,
			},
		},
	}),
	"hk:wave": () => ({
		uid: generateUid("filter"),
		processor: "hk:wave",
		paramData: {
			version: "1",
			params: {
				amplitude: 10,
				frequency: 5,
				angleValue: 0,
				crossWave: false,
				time: 0,
			},
		},
	}),
	// Hanakla Kit — Stylize
	"hk:blush-stroke": () => ({
		uid: generateUid("filter"),
		processor: "hk:blush-stroke",
		paramData: {
			version: "1",
			params: {
				angle: 45,
				brushSize: 8,
				strokeLength: 10,
				strokeDensity: 0.5,
				randomStrength: 0.3,
				randomSeed: 42,
				blendWithOriginal: 0.5,
			},
		},
	}),
	"hk:chromatic-aberration": () => ({
		uid: generateUid("filter"),
		processor: "hk:chromatic-aberration",
		paramData: {
			version: "1",
			params: {
				colorMode: "rgb",
				shiftType: "move",
				strength: 5,
				angle: 0,
				opacity: 1,
				blendMode: "over",
				useFocusPoint: false,
				focusPointX: 0.5,
				focusPointY: 0.5,
				focusGradient: 1,
			},
		},
	}),
	"hk:comic-tone": () => ({
		uid: generateUid("filter"),
		processor: "hk:comic-tone",
		paramData: {
			version: "1",
			params: {
				toneType: "dot",
				colorMode: "original",
				size: 4,
				spacing: 1,
				angle: 45,
				threshold: 0.5,
				reversePattern: false,
				showOriginalUnderDots: false,
				useLuminance: true,
				luminanceStrength: 1,
				invertDotSize: false,
				toneColor: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
			},
		},
	}),
	"hk:halftone": () => ({
		uid: generateUid("filter"),
		processor: "hk:halftone",
		paramData: {
			version: "1",
			params: {
				size: 4,
				angle: 45,
				placementPattern: "grid",
				invertDotSize: false,
				opaqueOnly: false,
				color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
			},
		},
	}),
	"hk:inner-glow": () => ({
		uid: generateUid("filter"),
		processor: "hk:inner-glow",
		paramData: {
			version: "1",
			params: {
				glowType: "inner",
				weight: 5,
				glowColor: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
			},
		},
	}),
	"hk:outline": () => ({
		uid: generateUid("filter"),
		processor: "hk:outline",
		paramData: {
			version: "1",
			params: {
				thickness: 2,
				color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				opacity: 1,
			},
		},
	}),
	"hk:vhs-interlace": () => ({
		uid: generateUid("filter"),
		processor: "hk:vhs-interlace",
		paramData: {
			version: "1",
			params: {
				intensity: 0.5,
				generation: 1,
				chromaBleed: 0.3,
				colorShift: 0.01,
				lumaSoftness: 0.15,
				ringing: 0.15,
				lineJitter: 0.1,
				verticalJitter: 0.01,
				trackingError: 0.05,
				headSwitching: 0.25,
				headSwitchingHeight: 8,
				noise: 0.15,
				noiseDistortion: 0.2,
				chromaNoise: 0.15,
				dropouts: 0.05,
				dropoutLength: 0.25,
				brightnessJitter: 0.03,
				scanlines: 0.3,
				interlaceGap: 2,
				combing: 0.1,
				tilt: 0,
				blackLift: 0.12,
				desaturation: 0.1,
				randomSeed: 42,
				enableVHSColor: false,
				vhsColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				applyToTransparent: false,
			},
		},
	}),
	// Texture
	"hk:paper-v2": () => ({
		uid: generateUid("filter"),
		processor: "hk:paper-v2",
		paramData: {
			version: "1",
			params: {
				// "woodfree" is index 0 in the handler's PAPER_TYPE_MAP — the
				// value old documents with the invalid "kent" fall back to.
				paperType: "woodfree",
				beatingDegree: 0.5,
				fiberAmount: 0.5,
				fiberDarkness: 0.3,
				seed: 42,
				invert: false,
				lightingEnabled: false,
				lightIntensity: 0.5,
				lightAngle: 135,
				depthEffect: 0.3,
				surfaceRoughness: 0.5,
				maxFiberLength: 100,
				formationStrength: 1,
				laidLineStrength: 1,
				sheerness: 1,
			},
		},
	}),
	// Hanakla Kit — Other
	"hk:husky": () => ({
		uid: generateUid("filter"),
		processor: "hk:husky",
		paramData: {
			version: "1",
			params: {
				angle: 0,
				horizontalEnabled: true,
				verticalEnabled: true,
				blurIntensity: 5,
				bleedIntensity: 0.3,
				breathiness: 0.3,
				melt: 0.25,
				maxOffset: 20,
				randomSeed: 42,
			},
		},
	}),
	"hk:smear": () => ({
		uid: generateUid("filter"),
		processor: "hk:smear",
		paramData: {
			version: "1",
			params: {
				angle: 0,
				intensity: 0.5,
				streakLength: 90,
				streakWidth: 7,
				softness: 0.15,
				randomSeed: 42,
			},
		},
	}),
	"hk:kaleidoscope": () => ({
		uid: generateUid("filter"),
		processor: "hk:kaleidoscope",
		paramData: {
			version: "1",
			params: {
				pattern: "triangular",
				segments: 6,
				rotation: 0,
				centerX: 0.5,
				centerY: 0.5,
				zoom: 1,
				distortion: 0,
				complexity: 1,
				colorShift: 0,
				cellEffect: 0,
				cellSize: 0.3,
				blendMode: "normal",
				padding: 0,
			},
		},
	}),
	"hk:pixel-sort": () => ({
		uid: generateUid("filter"),
		processor: "hk:pixel-sort",
		paramData: {
			version: "1",
			params: {
				angle: 0,
				strength: 1,
				ascending: true,
				thresholdMin: 0,
				thresholdMax: 1,
				applyToBackdrop: false,
			},
		},
	}),
	// SVG filter primitives
	"svg:gaussian-blur": () => ({
		uid: generateUid("filter"),
		processor: "svg:gaussian-blur",
		paramData: {
			version: "1",
			params: { in: "previous", stdDeviationX: 3, stdDeviationY: 3 },
		},
	}),
	"svg:offset": () => ({
		uid: generateUid("filter"),
		processor: "svg:offset",
		paramData: { version: "1", params: { in: "previous", dx: 4, dy: -4 } },
	}),
	"svg:flood": () => ({
		uid: generateUid("filter"),
		processor: "svg:flood",
		paramData: {
			version: "1",
			params: { color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 }, opacity: 1 },
		},
	}),
	"svg:color-matrix": () => ({
		uid: generateUid("filter"),
		processor: "svg:color-matrix",
		paramData: {
			version: "1",
			params: {
				in: "previous",
				type: "matrix",
				values: [...SVG_COLOR_MATRIX_IDENTITY],
			},
		},
	}),
	"svg:component-transfer": () => ({
		uid: generateUid("filter"),
		processor: "svg:component-transfer",
		paramData: {
			version: "1",
			params: {
				in: "previous",
				r: identityTransferFunction(),
				g: identityTransferFunction(),
				b: identityTransferFunction(),
				a: identityTransferFunction(),
			},
		},
	}),
	"svg:morphology": () => ({
		uid: generateUid("filter"),
		processor: "svg:morphology",
		paramData: {
			version: "1",
			params: { in: "previous", operator: "erode", radiusX: 1, radiusY: 1 },
		},
	}),
	"svg:convolve-matrix": () => ({
		uid: generateUid("filter"),
		processor: "svg:convolve-matrix",
		paramData: {
			version: "1",
			params: {
				in: "previous",
				order: 3,
				kernelMatrix: identityKernel(3),
				divisor: null,
				bias: 0,
				edgeMode: "duplicate",
				preserveAlpha: false,
			},
		},
	}),
	"svg:turbulence": () => ({
		uid: generateUid("filter"),
		processor: "svg:turbulence",
		paramData: {
			version: "1",
			params: {
				type: "fractalNoise",
				baseFrequencyX: 0.05,
				baseFrequencyY: 0.05,
				numOctaves: 2,
				seed: 0,
				stitchTiles: false,
			},
		},
	}),
	"svg:displacement-map": () => ({
		uid: generateUid("filter"),
		processor: "svg:displacement-map",
		paramData: {
			version: "1",
			params: {
				in: "SourceGraphic",
				in2: "previous",
				scale: 20,
				xChannelSelector: "R",
				yChannelSelector: "G",
			},
		},
	}),
	"svg:composite": () => ({
		uid: generateUid("filter"),
		processor: "svg:composite",
		paramData: {
			version: "1",
			params: {
				in: "previous",
				in2: "SourceGraphic",
				operator: "over",
				k1: 0,
				k2: 0,
				k3: 0,
				k4: 0,
			},
		},
	}),
	"svg:blend": () => ({
		uid: generateUid("filter"),
		processor: "svg:blend",
		paramData: {
			version: "1",
			params: { in: "previous", in2: "SourceGraphic", mode: "multiply" },
		},
	}),
	...Object.fromEntries(
		SVG_COLOR_FUNCTIONS.map((fn) => [
			`svg:${fn}`,
			() => ({
				uid: generateUid("filter"),
				processor: `svg:${fn}`,
				paramData: {
					version: "1",
					params: { in: "previous", amount: SVG_COLOR_FUNCTION_DEFAULTS[fn] },
				},
			}),
		]),
	),
	"svg:filter": () => ({
		uid: generateUid("filter"),
		processor: "svg:filter",
		paramData: { version: "1", params: { nodes: [] } },
	}),
	"svg:drop-shadow": () => ({
		uid: generateUid("filter"),
		processor: "svg:drop-shadow",
		paramData: {
			version: "1",
			params: {
				in: "previous",
				dx: 4,
				dy: -4,
				stdDeviation: 3,
				color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				opacity: 0.5,
			},
		},
	}),
};

/** The CSS color functions at the argument that leaves the image unchanged. */
const SVG_COLOR_FUNCTION_DEFAULTS: Record<SvgColorFunction, number> = {
	saturate: 1,
	"hue-rotate": 0,
	grayscale: 0,
	sepia: 0,
	invert: 0,
	brightness: 1,
	contrast: 1,
};

/** An order×order convolution kernel that leaves the image unchanged. */
export function identityKernel(order: number): number[] {
	const kernel = new Array<number>(order * order).fill(0);
	kernel[Math.floor(order / 2) * order + Math.floor(order / 2)] = 1;
	return kernel;
}

function identityTransferFunction(): SvgTransferFunction {
	return { type: "identity" };
}

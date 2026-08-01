/**
 * Per-paper-type constants driving the hk:paper-v2 generator. Values are
 * derived from how each paper is actually manufactured:
 *
 * - Coating weights (art ~40 g/m2 both sides, coated 15-20, light-coated ~12)
 *   and the supercalendering that produces gloss:
 *   https://www.kamifujiwara.co.jp/kami/kamimame.html
 *   https://sasshi-online.com/staff_blog/archives/82
 *   https://shifton.kpp-gr.com/glossary/lightlycoated_paper/
 * - Washi bast-fiber lengths (kouzo 7.3 mm / ganpi 5.0 mm / mitsumata 3.2 mm)
 *   and their look (kouzo rough+strong, mitsumata fine+smooth, ganpi dense
 *   with a natural sheen):
 *   https://www.mitokamiten.com/cont7/main.html
 *   https://www.awagami.or.jp/iroha/material/index.html
 * - Tosa tengujo: 12.9 g/m2, 0.03 mm — the sheerest handmade paper, laid
 *   lines and formation show through:
 *   https://ja.wikipedia.org/wiki/%E5%9C%9F%E4%BD%90%E5%92%8C%E7%B4%99
 *   https://www.hidakawashi.com/jp/tengu/index.html
 * - Beating (freeness): more beating -> denser, more uniform formation,
 *   lower opacity: https://kamiconsal.jp/kamifreeness/
 * - Wire/felt marks and two-sidedness of machine-made paper:
 *   https://dtp-bbs.com/road-to-the-paper/column/column-082.html
 *
 * Spatial constants are world px (1 px = 1/72 inch, so 1 mm is about
 * 2.83 px): laid lines run at about a 1 mm pitch, chain lines every ~30 mm.
 */

export type PaperTypeKey =
	| "woodfree"
	| "art"
	| "coated"
	| "machine"
	| "lightCoated"
	| "kouzo"
	| "mitsumata"
	| "ganpi"
	| "tengujou"
	| "tousagami";

export interface HKPaperTypeDef {
	key: PaperTypeKey;
	/** Sheet base color (linear-ish sRGB 0-1). */
	baseColor: [number, number, number];
	/** Micro surface noise amplitude. */
	roughness: number;
	fiberDensity: number;
	/** Formation mottle (cloudy density unevenness) amplitude. */
	formation: number;
	/** Laid + chain line ridges from the papermaking screen (washi only). */
	laid: {
		amp: number;
		spacingPx: number;
		chainSpacingPx: number;
		chainAmp: number;
	} | null;
	/** Wire/felt mark grid + machine-direction fiber orientation (machine-made only). */
	wireMark: { amp: number; spacingPx: number; mdStretch: number } | null;
	/** Sparse dark impurity specks (groundwood pulp). */
	speck: { density: number; darkness: number };
	/** Coat layer coverage: buries fibers and flattens the relief. */
	coating: number;
	/** Specular sheen from calendering (or the natural ganpi luster). */
	gloss: number;
	/** Sheet opacity: tengujo-class thin sheets are translucent. */
	opacity: number;
	/** Base fiber length in world px (real fiber mm x ~2.83 px/mm). */
	fiberLengthPx: number;
	baseWeight: number;
	weightVariation: number;
	smoothingPasses: number;
	japanesePaper: boolean;
	fibers: { ratio: number; grayOffset: number }[];
}

const PAPER_TYPES: Record<PaperTypeKey, HKPaperTypeDef> = {
	woodfree: {
		key: "woodfree",
		baseColor: [0.961, 0.961, 0.941],
		roughness: 0.3,
		fiberDensity: 0.7,
		formation: 0.35,
		laid: null,
		wireMark: { amp: 0.4, spacingPx: 1.6, mdStretch: 3.0 },
		speck: { density: 0.1, darkness: 0.25 },
		coating: 0,
		gloss: 0.2,
		opacity: 1,
		fiberLengthPx: 6,
		baseWeight: 1.2,
		weightVariation: 0.3,
		smoothingPasses: 2,
		japanesePaper: false,
		fibers: [
			{ ratio: 0.7, grayOffset: 0 },
			{ ratio: 0.2, grayOffset: -20 },
			{ ratio: 0.1, grayOffset: 10 },
		],
	},
	art: {
		key: "art",
		baseColor: [0.957, 0.957, 0.925],
		roughness: 0.1,
		fiberDensity: 0.5,
		formation: 0.08,
		laid: null,
		wireMark: null,
		speck: { density: 0, darkness: 0 },
		coating: 0.8,
		gloss: 0.75,
		opacity: 1,
		fiberLengthPx: 4,
		baseWeight: 0.8,
		weightVariation: 0.2,
		smoothingPasses: 3,
		japanesePaper: false,
		fibers: [
			{ ratio: 0.8, grayOffset: 0 },
			{ ratio: 0.2, grayOffset: -15 },
		],
	},
	coated: {
		key: "coated",
		baseColor: [0.973, 0.973, 0.961],
		roughness: 0.2,
		fiberDensity: 0.6,
		formation: 0.12,
		laid: null,
		wireMark: null,
		speck: { density: 0, darkness: 0 },
		coating: 0.5,
		gloss: 0.7,
		opacity: 1,
		fiberLengthPx: 5,
		baseWeight: 1.0,
		weightVariation: 0.25,
		smoothingPasses: 3,
		japanesePaper: false,
		fibers: [
			{ ratio: 0.9, grayOffset: 0 },
			{ ratio: 0.1, grayOffset: -10 },
		],
	},
	machine: {
		key: "machine",
		baseColor: [0.949, 0.949, 0.91],
		roughness: 0.6,
		fiberDensity: 0.8,
		formation: 0.7,
		laid: null,
		wireMark: { amp: 0.8, spacingPx: 2.0, mdStretch: 4.0 },
		speck: { density: 0.6, darkness: 0.45 },
		coating: 0,
		gloss: 0.1,
		opacity: 1,
		fiberLengthPx: 8,
		baseWeight: 1.8,
		weightVariation: 0.6,
		smoothingPasses: 1,
		japanesePaper: false,
		fibers: [
			{ ratio: 0.5, grayOffset: 0 },
			{ ratio: 0.3, grayOffset: -30 },
			{ ratio: 0.2, grayOffset: 20 },
		],
	},
	lightCoated: {
		key: "lightCoated",
		baseColor: [0.957, 0.957, 0.925],
		roughness: 0.4,
		fiberDensity: 0.7,
		formation: 0.3,
		laid: null,
		wireMark: { amp: 0.3, spacingPx: 1.8, mdStretch: 3.0 },
		speck: { density: 0.05, darkness: 0.2 },
		coating: 0.25,
		gloss: 0.4,
		opacity: 1,
		fiberLengthPx: 6,
		baseWeight: 1.1,
		weightVariation: 0.35,
		smoothingPasses: 2,
		japanesePaper: false,
		fibers: [
			{ ratio: 0.7, grayOffset: 0 },
			{ ratio: 0.3, grayOffset: -15 },
		],
	},
	kouzo: {
		key: "kouzo",
		baseColor: [0.969, 0.957, 0.914],
		roughness: 0.8,
		fiberDensity: 0.5,
		formation: 1.0,
		laid: { amp: 0.5, spacingPx: 3.0, chainSpacingPx: 85, chainAmp: 0.5 },
		wireMark: null,
		speck: { density: 0.15, darkness: 0.3 },
		coating: 0,
		gloss: 0.05,
		opacity: 1,
		fiberLengthPx: 21,
		baseWeight: 2.5,
		weightVariation: 1.2,
		smoothingPasses: 1,
		japanesePaper: true,
		fibers: [
			{ ratio: 0.5, grayOffset: 0 },
			{ ratio: 0.3, grayOffset: -25 },
			{ ratio: 0.2, grayOffset: 15 },
		],
	},
	mitsumata: {
		key: "mitsumata",
		baseColor: [0.976, 0.965, 0.933],
		roughness: 0.6,
		fiberDensity: 0.6,
		formation: 0.7,
		laid: { amp: 0.4, spacingPx: 3.0, chainSpacingPx: 85, chainAmp: 0.4 },
		wireMark: null,
		speck: { density: 0.05, darkness: 0.2 },
		coating: 0,
		gloss: 0.1,
		opacity: 1,
		fiberLengthPx: 9,
		baseWeight: 2.0,
		weightVariation: 0.9,
		smoothingPasses: 1,
		japanesePaper: true,
		fibers: [
			{ ratio: 0.6, grayOffset: 0 },
			{ ratio: 0.4, grayOffset: -20 },
		],
	},
	ganpi: {
		key: "ganpi",
		baseColor: [0.973, 0.969, 0.949],
		roughness: 0.4,
		fiberDensity: 0.7,
		formation: 0.5,
		laid: { amp: 0.3, spacingPx: 3.0, chainSpacingPx: 85, chainAmp: 0.3 },
		wireMark: null,
		speck: { density: 0, darkness: 0 },
		coating: 0,
		gloss: 0.3,
		opacity: 0.85,
		fiberLengthPx: 14,
		baseWeight: 1.8,
		weightVariation: 0.8,
		smoothingPasses: 2,
		japanesePaper: true,
		fibers: [
			{ ratio: 0.7, grayOffset: 0 },
			{ ratio: 0.3, grayOffset: 20 },
		],
	},
	tengujou: {
		key: "tengujou",
		baseColor: [1.0, 0.988, 0.961],
		roughness: 0.2,
		fiberDensity: 0.8,
		formation: 0.7,
		laid: { amp: 0.6, spacingPx: 3.0, chainSpacingPx: 85, chainAmp: 0.5 },
		wireMark: null,
		speck: { density: 0, darkness: 0 },
		coating: 0,
		gloss: 0.2,
		opacity: 0.5,
		fiberLengthPx: 21,
		baseWeight: 1.5,
		weightVariation: 0.7,
		smoothingPasses: 2,
		japanesePaper: true,
		fibers: [
			{ ratio: 0.8, grayOffset: 0 },
			{ ratio: 0.2, grayOffset: 15 },
		],
	},
	tousagami: {
		key: "tousagami",
		baseColor: [0.965, 0.953, 0.91],
		roughness: 0.7,
		fiberDensity: 0.55,
		formation: 1.0,
		laid: { amp: 0.5, spacingPx: 3.2, chainSpacingPx: 90, chainAmp: 0.5 },
		wireMark: null,
		speck: { density: 0.25, darkness: 0.35 },
		coating: 0,
		gloss: 0.08,
		opacity: 1,
		fiberLengthPx: 18,
		baseWeight: 3.0,
		weightVariation: 1.5,
		smoothingPasses: 1,
		japanesePaper: true,
		fibers: [
			{ ratio: 0.4, grayOffset: 0 },
			{ ratio: 0.4, grayOffset: -25 },
			{ ratio: 0.2, grayOffset: 20 },
		],
	},
};

/** Unknown keys (legacy documents stored e.g. "kent") fall back to woodfree,
 *  matching the old shader's PAPER_TYPE_MAP `?? 0` behavior. */
export function resolvePaperType(key: string): HKPaperTypeDef {
	return PAPER_TYPES[key as PaperTypeKey] ?? PAPER_TYPES.woodfree;
}

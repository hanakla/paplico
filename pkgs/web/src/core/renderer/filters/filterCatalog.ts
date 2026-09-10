interface FilterCatalogEntry {
	processor: string;
	category: string;
	subCategory?: string;
	canBeSubFilter: boolean;
}

export const FILTER_CATALOG: FilterCatalogEntry[] = [
	{ processor: "fill", category: "Appearance", canBeSubFilter: false },
	{ processor: "stroke", category: "Appearance", canBeSubFilter: false },
	// The content appearance is created structurally per element (e.g. text) and
	// is not manually addable; it can only be toggled visible/hidden.
	{ processor: "extrude3d", category: "3D", canBeSubFilter: false },
	{ processor: "revolve3d", category: "3D", canBeSubFilter: false },
	{ processor: "3d-rotate", category: "3D", canBeSubFilter: true },
	{ processor: "zigzag", category: "Geometry", canBeSubFilter: true },
	{ processor: "path-offset", category: "Geometry", canBeSubFilter: true },
	{ processor: "path-union", category: "Geometry", canBeSubFilter: true },
	{ processor: "pucker-bloat", category: "Geometry", canBeSubFilter: true },
	{ processor: "blur", category: "Blur", canBeSubFilter: true },
	{ processor: "frost-glass", category: "Blur", canBeSubFilter: true },
	{
		processor: "hk:bloom",
		category: "Blur",
		canBeSubFilter: true,
	},
	{
		processor: "hk:directional-blur",
		category: "Blur",
		canBeSubFilter: true,
	},
	{
		processor: "hk:kirakira",
		category: "Blur",
		canBeSubFilter: true,
	},
	{
		processor: "hk:radial-rot-dir",
		category: "Blur",
		canBeSubFilter: true,
	},
	{
		processor: "hk:husky",
		category: "Blur",
		canBeSubFilter: true,
	},
	{
		processor: "hk:gradient-map",
		category: "Color",
		canBeSubFilter: true,
	},
	{
		processor: "hk:posterization",
		category: "Color",
		canBeSubFilter: true,
	},
	{
		processor: "hk:color-replacement",
		category: "Color",
		canBeSubFilter: true,
	},
	{
		processor: "hk:selective-correction",
		category: "Color",
		canBeSubFilter: true,
	},
	{ processor: "drop-shadow", category: "Stylize", canBeSubFilter: true },
	{
		processor: "hk:chromatic-aberration",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:spraying",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:smear",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:blush-stroke",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:comic-tone",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:halftone",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:inner-glow",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:outline",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:vhs-interlace",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:pixel-sort",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "hk:kaleidoscope",
		category: "Stylize",
		canBeSubFilter: true,
	},
	{
		processor: "pixelate",
		category: "Distortion",
		canBeSubFilter: true,
	},
	{
		processor: "hk:fluid",
		category: "Distortion",
		canBeSubFilter: true,
	},
	{
		processor: "hk:glitch",
		category: "Distortion",
		canBeSubFilter: true,
	},
	{
		processor: "hk:turbulence",
		category: "Distortion",
		canBeSubFilter: true,
	},
	{
		processor: "hk:wave",
		category: "Distortion",
		canBeSubFilter: true,
	},
	// Texture
	{
		processor: "hk:paper-v2",
		category: "Texture",
		canBeSubFilter: true,
	},
	// SVG filter primitives: exported 1:1 as <fe*> elements. A sub-filter
	// position would rasterize on export, so they are top-level only.
	{ processor: "svg:gaussian-blur", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:offset", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:flood", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:color-matrix", category: "SVG", canBeSubFilter: false },
	{
		processor: "svg:component-transfer",
		category: "SVG",
		canBeSubFilter: false,
	},
	{ processor: "svg:morphology", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:convolve-matrix", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:turbulence", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:displacement-map", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:composite", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:blend", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:drop-shadow", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:saturate", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:hue-rotate", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:grayscale", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:sepia", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:invert", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:brightness", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:contrast", category: "SVG", canBeSubFilter: false },
	{ processor: "svg:filter", category: "SVG", canBeSubFilter: false },
];

/** Unique category names in display order */
export const FILTER_CATEGORIES = [
	...new Set(FILTER_CATALOG.map((e) => e.category)),
];

/** Whether a processor may sit under a fill / stroke as a sub-filter; unlisted processors may. */
export function canBeSubFilter(processor: string): boolean {
	return (
		FILTER_CATALOG.find((entry) => entry.processor === processor)
			?.canBeSubFilter ?? true
	);
}

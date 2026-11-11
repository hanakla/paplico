interface FilterCatalogEntry {
	processor: string;
	category: string;
	subCategory?: string;
}

export const FILTER_CATALOG: FilterCatalogEntry[] = [
	{ processor: "fill", category: "Appearance" },
	{ processor: "stroke", category: "Appearance" },
	// The content appearance is created structurally per element (e.g. text) and
	// is not manually addable; it can only be toggled visible/hidden.
	{ processor: "extrude3d", category: "3D" },
	{ processor: "revolve3d", category: "3D" },
	{ processor: "3d-rotate", category: "3D" },
	{ processor: "zigzag", category: "Geometry" },
	{ processor: "rough", category: "Geometry" },
	{ processor: "path-offset", category: "Geometry" },
	{ processor: "path-union", category: "Geometry" },
	{ processor: "stroke-outline", category: "Geometry" },
	{ processor: "pucker-bloat", category: "Geometry" },
	{ processor: "transform", category: "Geometry" },
	{ processor: "clip-to-shape", category: "Mask" },
	{ processor: "blur", category: "Blur" },
	{ processor: "frost-glass", category: "Blur" },
	{
		processor: "hk:bloom",
		category: "Blur",
	},
	{
		processor: "hk:directional-blur",
		category: "Blur",
	},
	{
		processor: "hk:kirakira",
		category: "Blur",
	},
	{
		processor: "hk:radial-rot-dir",
		category: "Blur",
	},
	{
		processor: "hk:husky",
		category: "Blur",
	},
	{
		processor: "hk:gradient-map",
		category: "Color",
	},
	{
		processor: "hk:posterization",
		category: "Color",
	},
	{
		processor: "hk:color-replacement",
		category: "Color",
	},
	{
		processor: "hk:selective-correction",
		category: "Color",
	},
	{ processor: "drop-shadow", category: "Stylize" },
	{
		processor: "hk:chromatic-aberration",
		category: "Stylize",
	},
	{
		processor: "hk:spraying",
		category: "Stylize",
	},
	{
		processor: "hk:smear",
		category: "Stylize",
	},
	{
		processor: "hk:blush-stroke",
		category: "Stylize",
	},
	{
		processor: "hk:comic-tone",
		category: "Stylize",
	},
	{
		processor: "hk:halftone",
		category: "Stylize",
	},
	{
		processor: "hk:inner-glow",
		category: "Stylize",
	},
	{
		processor: "hk:outline",
		category: "Stylize",
	},
	{
		processor: "hk:vhs-interlace",
		category: "Stylize",
	},
	{
		processor: "hk:pixel-sort",
		category: "Stylize",
	},
	{
		processor: "hk:kaleidoscope",
		category: "Stylize",
	},
	{
		processor: "pixelate",
		category: "Distortion",
	},
	{
		processor: "hk:fluid",
		category: "Distortion",
	},
	{
		processor: "hk:glitch",
		category: "Distortion",
	},
	{
		processor: "hk:turbulence",
		category: "Distortion",
	},
	{
		processor: "hk:wave",
		category: "Distortion",
	},
	// Texture
	{
		processor: "hk:paper-v2",
		category: "Texture",
	},
	{ processor: "noise", category: "Texture" },
	// SVG filter primitives: exported 1:1 as <fe*> elements. A sub-filter
	// position would rasterize on export, so they are top-level only.
	{ processor: "svg:gaussian-blur", category: "SVG" },
	{ processor: "svg:offset", category: "SVG" },
	{ processor: "svg:flood", category: "SVG" },
	{ processor: "svg:color-matrix", category: "SVG" },
	{
		processor: "svg:component-transfer",
		category: "SVG",
	},
	{ processor: "svg:morphology", category: "SVG" },
	{ processor: "svg:convolve-matrix", category: "SVG" },
	{ processor: "svg:turbulence", category: "SVG" },
	{ processor: "svg:displacement-map", category: "SVG" },
	{ processor: "svg:composite", category: "SVG" },
	{ processor: "svg:blend", category: "SVG" },
	{ processor: "svg:drop-shadow", category: "SVG" },
	{ processor: "svg:saturate", category: "SVG" },
	{ processor: "svg:hue-rotate", category: "SVG" },
	{ processor: "svg:grayscale", category: "SVG" },
	{ processor: "svg:sepia", category: "SVG" },
	{ processor: "svg:invert", category: "SVG" },
	{ processor: "svg:brightness", category: "SVG" },
	{ processor: "svg:contrast", category: "SVG" },
	{ processor: "svg:filter", category: "SVG" },
];

/** Unique category names in display order */
export const FILTER_CATEGORIES = [
	...new Set(FILTER_CATALOG.map((e) => e.category)),
];

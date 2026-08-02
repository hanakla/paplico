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
];

/** Unique category names in display order */
export const FILTER_CATEGORIES = [
	...new Set(FILTER_CATALOG.map((e) => e.category)),
];

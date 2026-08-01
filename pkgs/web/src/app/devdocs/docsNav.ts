import type { NavItem } from "../_docsShell/nav";

export const devDocsNav: NavItem[] = [
	{ title: "Introduction", href: "/devdocs" },
	{
		title: "Data Flow",
		href: "/devdocs/data-flow",
		children: [
			{ title: "Document Schema", href: "/devdocs/data-flow/document-schema" },
			{ title: "Spatial Index", href: "/devdocs/data-flow/spatial-index" },
		],
	},
	{
		title: "Tutorials",
		href: "/devdocs/tutorials",
		children: [
			{ title: "1. Coordinates", href: "/devdocs/tutorials/01-coordinates" },
			{ title: "2. AABB / Bounds", href: "/devdocs/tutorials/02-bounds" },
			{ title: "3. Hit Testing", href: "/devdocs/tutorials/03-hit-test" },
			{
				title: "4. Bézier Flatten",
				href: "/devdocs/tutorials/04-bezier-flatten",
			},
			{ title: "5. Bézier Split", href: "/devdocs/tutorials/05-bezier-split" },
			{
				title: "6. Closest Point",
				href: "/devdocs/tutorials/06-closest-point",
			},
			{ title: "7. Smoothing", href: "/devdocs/tutorials/07-smoothing" },
			{
				title: "8. Bézier Fitting",
				href: "/devdocs/tutorials/08-bezier-fitting",
			},
			{ title: "9. Stroke Mesh", href: "/devdocs/tutorials/09-stroke-mesh" },
			{ title: "10. Ear Clipping", href: "/devdocs/tutorials/10-ear-clipping" },
			{
				title: "11. Stencil-then-Cover",
				href: "/devdocs/tutorials/11-stencil-then-cover",
			},
			{ title: "12. Coons Patch", href: "/devdocs/tutorials/12-coons-patch" },
		],
	},
	{
		title: "Renderer",
		href: "/devdocs/renderer",
		children: [
			{ title: "Pipeline", href: "/devdocs/renderer/pipeline" },
			{ title: "Planner", href: "/devdocs/renderer/planner" },
			{ title: "Caches", href: "/devdocs/renderer/caches" },
			{ title: "Clipping", href: "/devdocs/renderer/clipping" },
			{ title: "Elements", href: "/devdocs/renderer/elements" },
			{ title: "Path Rendering", href: "/devdocs/renderer/path-rendering" },
			{ title: "Text Rendering", href: "/devdocs/renderer/text-rendering" },
			{ title: "Brush", href: "/devdocs/renderer/brush" },
			{ title: "UI", href: "/devdocs/renderer/ui" },
			{ title: "Filters", href: "/devdocs/renderer/filters" },
			{ title: "Filter Authoring", href: "/devdocs/renderer/filter-authoring" },
			{ title: "Glossary", href: "/devdocs/renderer/glossary" },
		],
	},
];

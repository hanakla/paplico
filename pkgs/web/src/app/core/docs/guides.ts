import type { NavItem } from "../../_docsShell/nav";

/** Guide pages under /core/docs, in reading order. */
export const GUIDES = [
	{ slug: "getting-started", title: "Getting Started" },
	{ slug: "bundler-setup", title: "Bundler Setup" },
	{ slug: "fonts", title: "Fonts" },
	{ slug: "export", title: "Export" },
	{ slug: "collaboration", title: "Collaboration" },
	{ slug: "entry-points", title: "Entry Points" },
] as const;

export type GuideSlug = (typeof GUIDES)[number]["slug"];

export const coreDocsNav: NavItem[] = [
	{ title: "Introduction", href: "/core/docs" },
	...GUIDES.map(({ slug, title }) => ({ title, href: `/core/docs/${slug}` })),
];

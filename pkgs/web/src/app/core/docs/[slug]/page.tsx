import type { MDXContent } from "mdx/types";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { coreDocsComponents } from "../../_components/docsMdx";
import BundlerSetup from "../_content/bundler-setup.mdx";
import Collaboration from "../_content/collaboration.mdx";
import EntryPoints from "../_content/entry-points.mdx";
import Export from "../_content/export.mdx";
import Fonts from "../_content/fonts.mdx";
import GettingStarted from "../_content/getting-started.mdx";
import { GUIDES, type GuideSlug } from "../guides";

const CONTENT: Record<GuideSlug, MDXContent> = {
	"getting-started": GettingStarted,
	"bundler-setup": BundlerSetup,
	fonts: Fonts,
	export: Export,
	collaboration: Collaboration,
	"entry-points": EntryPoints,
};

export const dynamicParams = false;

export function generateStaticParams() {
	return GUIDES.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({
	params,
}: {
	params: Promise<{ slug: string }>;
}): Promise<Metadata> {
	const { slug } = await params;
	const guide = GUIDES.find((g) => g.slug === slug);
	return { title: `${guide?.title} — Paplico Core` };
}

export default async function GuidePage({
	params,
}: {
	params: Promise<{ slug: string }>;
}) {
	const { slug } = await params;
	const Content = CONTENT[slug as GuideSlug];
	if (!Content) notFound();
	return <Content components={coreDocsComponents} />;
}

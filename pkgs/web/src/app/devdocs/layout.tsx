import type { Metadata } from "next";
import { DocsShell } from "../_docsShell/DocsShell";
import { devDocsNav } from "./docsNav";

const TITLE = "Paplico Dev Docs";

export const metadata: Metadata = { title: TITLE };

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<DocsShell title={TITLE} nav={devDocsNav}>
			{children}
		</DocsShell>
	);
}

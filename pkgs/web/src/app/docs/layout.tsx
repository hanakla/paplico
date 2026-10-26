import type { Metadata } from "next";
import { DocsShell } from "../_docsShell/DocsShell";
import { docsNav } from "./docsNav";

const TITLE = "Paplico Docs";

export const metadata: Metadata = { title: TITLE };

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<DocsShell title={TITLE} nav={docsNav}>
			{children}
		</DocsShell>
	);
}

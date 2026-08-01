import { DocsShell } from "../_docsShell/DocsShell";
import { devDocsNav } from "./docsNav";

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<DocsShell title="Paplico Dev Docs" nav={devDocsNav}>
			{children}
		</DocsShell>
	);
}

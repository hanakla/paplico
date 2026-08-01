import { DocsShell } from "../_docsShell/DocsShell";
import { docsNav } from "./docsNav";

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<DocsShell title="Paplico Docs" nav={docsNav}>
			{children}
		</DocsShell>
	);
}

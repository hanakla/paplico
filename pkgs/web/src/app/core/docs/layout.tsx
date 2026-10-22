import { DocsShell } from "../../_docsShell/DocsShell";
import { coreDocsNav } from "./guides";

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<DocsShell
			title="Paplico Core"
			nav={coreDocsNav}
			backLink={{ href: "/core", label: "Overview" }}
		>
			{children}
		</DocsShell>
	);
}

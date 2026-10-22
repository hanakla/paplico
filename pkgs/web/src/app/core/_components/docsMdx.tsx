import type { MDXComponents } from "mdx/types";
import { Mermaid } from "../../_docsShell/Mermaid";
import { Code } from "./Code";

/**
 * MDX overrides for the /core/docs pages: fenced code gets highlighted,
 * and mermaid blocks still become diagrams as in the other docs.
 */
export const coreDocsComponents: MDXComponents = {
	pre: ({ children }) => {
		const code = children as React.ReactElement<{
			className?: string;
			children?: string;
		}>;
		const source = code.props.children ?? "";
		const lang = code.props.className?.replace("language-", "") ?? "text";
		if (lang === "mermaid") return <Mermaid $chart={source} />;
		return <Code code={source} lang={lang} />;
	},
};

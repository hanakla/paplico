import { codeToHtml } from "shiki";

/** Syntax-highlighted code panel, rendered on the server. */
export async function Code({
	code,
	lang = "ts",
	title,
}: {
	code: string;
	lang?: string;
	title?: string;
}) {
	const html = await codeToHtml(code.trim(), { lang, theme: "github-dark" });

	return (
		<div className="aero-code my-4">
			{title && <div className="aero-code-title">{title}</div>}
			<div
				// biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output of our own snippets
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		</div>
	);
}

/**
 * Pure TextContent manipulation shared between editing (TextTool) and
 * document commands (flow-aware cut). Coordinates are content-global
 * character indices: the newline between paragraphs occupies one index.
 */

import type { TextContent, TextParagraph, TextRun } from "../schema";

/**
 * Slice [from, to) of a run, carrying the style and the covered
 * charOverrides reindexed to the slice.
 */
export function splitRunAt(run: TextRun, from: number, to: number): TextRun {
	return {
		text: run.text.slice(from, to),
		style: { ...run.style },
		charOverrides: run.charOverrides
			?.filter((o) => o.charIndex >= from && o.charIndex < to)
			.map((o) => ({ ...o, charIndex: o.charIndex - from })),
	};
}

/**
 * Split content at a content-global character index. `before` keeps
 * [0, index) and `after` the rest; paragraph structure, run styles and
 * per-char overrides are preserved. A split landing on a paragraph boundary
 * consumes the boundary newline (both sides keep whole paragraphs). Both
 * sides always contain at least one paragraph with one run.
 */
export function splitTextContentAt(
	content: TextContent,
	index: number,
): { before: TextContent; after: TextContent } {
	const before: TextParagraph[] = [];
	const after: TextParagraph[] = [];
	let remaining = index;

	for (let p = 0; p < content.paragraphs.length; p++) {
		const para = content.paragraphs[p];
		if (after.length > 0) {
			after.push(cloneParagraph(para));
			continue;
		}
		if (p > 0) {
			if (remaining === 0) {
				after.push(cloneParagraph(para));
				continue;
			}
			remaining--;
		}

		const len = paragraphLength(para);
		if (remaining >= len) {
			before.push(cloneParagraph(para));
			remaining -= len;
			continue;
		}

		const beforeRuns: TextRun[] = [];
		const afterRuns: TextRun[] = [];
		for (const run of para.runs) {
			if (afterRuns.length > 0) {
				afterRuns.push(splitRunAt(run, 0, run.text.length));
				continue;
			}
			if (remaining >= run.text.length) {
				beforeRuns.push(splitRunAt(run, 0, run.text.length));
				remaining -= run.text.length;
				continue;
			}
			if (remaining > 0) {
				beforeRuns.push(splitRunAt(run, 0, remaining));
			}
			afterRuns.push(splitRunAt(run, remaining, run.text.length));
			remaining = 0;
		}
		before.push(withRuns(para, beforeRuns));
		after.push(withRuns(para, afterRuns));
	}

	return {
		before: ensureNonEmpty(before, content),
		after: ensureNonEmpty(after, content),
	};
}

// Helpers

function paragraphLength(para: TextParagraph): number {
	return para.runs.reduce((sum, run) => sum + run.text.length, 0);
}

function cloneParagraph(para: TextParagraph): TextParagraph {
	return withRuns(
		para,
		para.runs.map((run) => splitRunAt(run, 0, run.text.length)),
	);
}

function withRuns(para: TextParagraph, runs: TextRun[]): TextParagraph {
	return {
		...para,
		spacing: { ...para.spacing },
		runs:
			runs.length > 0 ? runs : [{ text: "", style: { ...para.runs[0].style } }],
	};
}

function ensureNonEmpty(
	paragraphs: TextParagraph[],
	source: TextContent,
): TextContent {
	if (paragraphs.length > 0) return { paragraphs };
	return { paragraphs: [withRuns(source.paragraphs[0], [])] };
}

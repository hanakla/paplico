import { formatNumber } from "./pathData";

/** Lightweight XML node used to assemble the SVG document tree. */
export interface SvgNode {
	tag: string;
	attrs: Record<string, string | number>;
	children?: SvgNode[];
	text?: string;
}

export type SvgDefIdPrefix = "grad" | "pat" | "clip" | "mask" | "filter";

/**
 * Assembles an SVG document: collects defs with deterministic id allocation,
 * body nodes, and serializes the tree with attribute escaping.
 */
export class SvgDocumentBuilder {
	private readonly defs: SvgNode[] = [];
	private readonly body: SvgNode[] = [];
	private readonly idCounters = new Map<SvgDefIdPrefix, number>();

	public constructor(
		private readonly viewBox: { width: number; height: number },
	) {}

	public allocId(prefix: SvgDefIdPrefix): string {
		const next = this.idCounters.get(prefix) ?? 0;
		this.idCounters.set(prefix, next + 1);
		return `${prefix}${next}`;
	}

	public addDef(node: SvgNode): void {
		this.defs.push(node);
	}

	public appendChild(node: SvgNode): void {
		this.body.push(node);
	}

	public serialize(): string {
		const w = formatNumber(this.viewBox.width);
		const h = formatNumber(this.viewBox.height);
		const lines: string[] = [
			`<?xml version="1.0" encoding="UTF-8"?>`,
			`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
		];
		if (this.defs.length > 0) {
			lines.push("\t<defs>");
			for (const def of this.defs) serializeNode(def, 2, lines);
			lines.push("\t</defs>");
		}
		for (const node of this.body) serializeNode(node, 1, lines);
		lines.push("</svg>");
		return lines.join("\n");
	}
}

function serializeNode(node: SvgNode, depth: number, out: string[]): void {
	const indent = "\t".repeat(depth);
	const attrs = Object.entries(node.attrs)
		.map(
			([key, value]) =>
				` ${key}="${escapeXml(typeof value === "number" ? formatNumber(value) : value)}"`,
		)
		.join("");

	const children = node.children ?? [];
	if (children.length === 0 && node.text === undefined) {
		out.push(`${indent}<${node.tag}${attrs}/>`);
		return;
	}
	if (children.length === 0) {
		out.push(
			`${indent}<${node.tag}${attrs}>${escapeXml(node.text ?? "")}</${node.tag}>`,
		);
		return;
	}
	out.push(`${indent}<${node.tag}${attrs}>`);
	for (const child of children) serializeNode(child, depth + 1, out);
	out.push(`${indent}</${node.tag}>`);
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

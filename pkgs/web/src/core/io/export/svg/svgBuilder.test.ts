import { describe, expect, it } from "vitest";
import { SvgDocumentBuilder } from "./svgBuilder";

describe("SvgDocumentBuilder", () => {
	it("should allocate deterministic sequential ids per prefix", () => {
		const builder = new SvgDocumentBuilder({ width: 100, height: 100 });
		expect(builder.allocId("grad")).toBe("grad0");
		expect(builder.allocId("grad")).toBe("grad1");
		expect(builder.allocId("mask")).toBe("mask0");
	});

	it("should serialize an empty document without a defs section", () => {
		const builder = new SvgDocumentBuilder({ width: 800, height: 600 });
		expect(builder.serialize()).toBe(
			[
				`<?xml version="1.0" encoding="UTF-8"?>`,
				`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="600" viewBox="0 0 800 600">`,
				`</svg>`,
			].join("\n"),
		);
	});

	it("should serialize defs, nested children, and self-closing leaves", () => {
		const builder = new SvgDocumentBuilder({ width: 10, height: 10 });
		builder.addDef({
			tag: "linearGradient",
			attrs: { id: "grad0" },
			children: [{ tag: "stop", attrs: { offset: 0 } }],
		});
		builder.appendChild({
			tag: "g",
			attrs: { opacity: 0.5 },
			children: [{ tag: "path", attrs: { d: "M 0 0" } }],
		});
		expect(builder.serialize()).toBe(
			[
				`<?xml version="1.0" encoding="UTF-8"?>`,
				`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10" viewBox="0 0 10 10">`,
				`\t<defs>`,
				`\t\t<linearGradient id="grad0">`,
				`\t\t\t<stop offset="0"/>`,
				`\t\t</linearGradient>`,
				`\t</defs>`,
				`\t<g opacity="0.5">`,
				`\t\t<path d="M 0 0"/>`,
				`\t</g>`,
				`</svg>`,
			].join("\n"),
		);
	});

	it("should escape XML special characters in attributes and text", () => {
		const builder = new SvgDocumentBuilder({ width: 1, height: 1 });
		builder.appendChild({
			tag: "text",
			attrs: { "data-name": `a<b>&"c"'d'` },
			text: `x < y & z`,
		});
		expect(builder.serialize()).toContain(
			`<text data-name="a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;">x &lt; y &amp; z</text>`,
		);
	});
});

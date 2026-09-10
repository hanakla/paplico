import { describe, expect, it } from "vitest";
import { queryFilterCatalog } from "./filterCatalogQuery";

const matched = (isSubFilter: boolean, query: string) =>
	(queryFilterCatalog(isSubFilter, query).matchedEntries ?? []).map(
		(e) => e.processor,
	);

describe("queryFilterCatalog", () => {
	it("should report no search while the query is empty", () => {
		expect(queryFilterCatalog(false, " ").matchedEntries).toBeNull();
	});

	it("should find the SVG primitives through their category name", () => {
		const svg = matched(false, "svg");
		expect(svg).toHaveLength(20);
		expect(svg).toContain("svg:gaussian-blur");
		expect(svg).toContain("svg:drop-shadow");
	});

	it("should match filter names in every locale regardless of width", () => {
		expect(matched(false, "gaussian")).toContain("svg:gaussian-blur");
		expect(matched(false, "ガウス")).toContain("svg:gaussian-blur");
		expect(matched(false, "ｇａｕｓｓｉａｎ")).toContain("svg:gaussian-blur");
	});

	it("should hide top-level-only filters from the sub-filter picker", () => {
		expect(matched(true, "svg")).toHaveLength(0);
		expect(
			queryFilterCatalog(true, "").visibleEntries.some((e) =>
				e.processor.startsWith("svg:"),
			),
		).toBe(false);
	});
});

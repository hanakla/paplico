import { describe, expect, it } from "vitest";
import { FILTER_CATALOG } from "@/core/renderer/filters/filterCatalog";
import { createDefaultFilter } from "./createDefaultFilter";

describe("createDefaultFilter", () => {
	it("should build a matching default for every catalog entry", () => {
		for (const entry of FILTER_CATALOG) {
			const filter = createDefaultFilter(entry.processor);
			expect(filter, entry.processor).not.toBeNull();
			expect(filter?.processor).toBe(entry.processor);
			expect(filter?.paramData.version).toBe("1");
		}
	});

	it("should give every call a fresh uid", () => {
		expect(createDefaultFilter("svg:flood")?.uid).not.toBe(
			createDefaultFilter("svg:flood")?.uid,
		);
	});

	it("should start SVG primitives from identity-shaped parameters", () => {
		const colorMatrix = createDefaultFilter("svg:color-matrix");
		expect(colorMatrix?.paramData.params).toMatchObject({
			in: "previous",
			type: "matrix",
		});
		expect(
			(colorMatrix?.paramData.params as { values: number[] }).values,
		).toHaveLength(20);

		const convolve = createDefaultFilter("svg:convolve-matrix")?.paramData
			.params as { order: number; kernelMatrix: number[]; divisor: null };
		expect(convolve.kernelMatrix).toHaveLength(convolve.order ** 2);
		expect(convolve.kernelMatrix[4]).toBe(1);
		expect(convolve.divisor).toBeNull();

		const transfer = createDefaultFilter("svg:component-transfer")?.paramData
			.params as Record<"r" | "g" | "b" | "a", { type: string }>;
		for (const channel of ["r", "g", "b", "a"] as const) {
			expect(transfer[channel].type).toBe("identity");
		}
	});

	it("should pair two-input primitives with the source graphic by default", () => {
		expect(
			createDefaultFilter("svg:displacement-map")?.paramData.params,
		).toMatchObject({
			in: "SourceGraphic",
			in2: "previous",
		});
		expect(
			createDefaultFilter("svg:composite")?.paramData.params,
		).toMatchObject({
			in: "previous",
			in2: "SourceGraphic",
		});
		expect(createDefaultFilter("svg:blend")?.paramData.params).toMatchObject({
			in: "previous",
			in2: "SourceGraphic",
		});
	});

	it("should return null for an unknown processor", () => {
		expect(createDefaultFilter("nope")).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { buildFiberVertices, type FiberPlanInput } from "./hk-paper-v2-fibers";
import { resolvePaperType } from "./hk-paper-v2-papers";

function baseInput(overrides: Partial<FiberPlanInput> = {}): FiberPlanInput {
	return {
		worldWidth: 200,
		worldHeight: 100,
		paper: resolvePaperType("woodfree"),
		beatingDegree: 0.7,
		fiberAmount: 1,
		fiberDarkness: 0.2,
		maxFiberLength: 100,
		seed: 42,
		...overrides,
	};
}

describe("buildFiberVertices", () => {
	it("should return byte-identical output for the same seed", () => {
		const a = buildFiberVertices(baseInput());
		const b = buildFiberVertices(baseInput());
		expect(a.length).toBeGreaterThan(0);
		expect(b).toEqual(a);
	});

	it("should return different output for a different seed", () => {
		const a = buildFiberVertices(baseInput());
		const b = buildFiberVertices(baseInput({ seed: 43 }));
		expect(b).not.toEqual(a);
	});

	it("should return an empty buffer for an empty area", () => {
		const out = buildFiberVertices(baseInput({ worldWidth: 0 }));
		expect(out.length).toBe(0);
	});

	it("should emit finite [x, y, gray] triples with gray in 0..1", () => {
		const out = buildFiberVertices(baseInput());
		expect(out.length % 3).toBe(0);
		for (let i = 0; i < out.length; i += 3) {
			expect(Number.isFinite(out[i])).toBe(true);
			expect(Number.isFinite(out[i + 1])).toBe(true);
			expect(out[i + 2]).toBeGreaterThanOrEqual(0);
			expect(out[i + 2]).toBeLessThanOrEqual(1);
		}
	});

	it("should produce fibers for washi types too", () => {
		const out = buildFiberVertices(
			baseInput({ paper: resolvePaperType("kouzo"), beatingDegree: 0.3 }),
		);
		expect(out.length).toBeGreaterThan(0);
	});

	it("should fall back to woodfree for legacy invalid paper types", () => {
		const legacy = buildFiberVertices(
			baseInput({ paper: resolvePaperType("kent") }),
		);
		const woodfree = buildFiberVertices(baseInput());
		expect(legacy).toEqual(woodfree);
	});
});

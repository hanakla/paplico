import { describe, expect, it } from "vitest";
import type { BrushSettings } from "../schema";
import { applyWetMacro, readWetMacro } from "./wetMacros";

/**
 * Macros are a shortcut for the base values a person would otherwise set one
 * by one. They must never reach into the curves — a brush that was shaped by
 * hand keeps its shaping when a macro is dragged.
 */
describe("wet macros", () => {
	it("should move the base values a macro owns", () => {
		const next = applyWetMacro(wetBrush(), "paper", 1);

		expect(next.properties.grainAmount?.base).toBe(1);
		expect(next.properties.granulation?.base).toBeCloseTo(0.8, 6);
		expect(next.properties.edgeRoughness?.base).toBeCloseTo(0.7, 6);
	});

	it("should leave curves untouched", () => {
		const shaped = wetBrush();
		shaped.properties.grainAmount = {
			base: 0.2,
			curves: [
				{
					input: "pressure",
					points: [
						[0, 0],
						[1, 0.5],
					],
				},
			],
		};

		const next = applyWetMacro(shaped, "paper", 0.5);

		expect(next.properties.grainAmount?.curves).toEqual([
			{
				input: "pressure",
				points: [
					[0, 0],
					[1, 0.5],
				],
			},
		]);
	});

	it("should write the bleed radius the wet config owns", () => {
		const next = applyWetMacro(wetBrush(), "bleed", 0.8);

		expect(next.wet?.bleedRadius).toBeCloseTo(0.8, 6);
		expect(next.properties.bleedSoftness?.base).toBeCloseTo(0.59, 6);
		expect(next.properties.directionality?.base).toBeCloseTo(0.38, 6);
	});

	it("should read a macro back from the value it represents", () => {
		const next = applyWetMacro(wetBrush(), "dryness", 0.6);

		expect(readWetMacro(next, "dryness")).toBeCloseTo(0.6, 6);
	});

	it("should ignore the parameters a macro does not represent when reading back", () => {
		const next = applyWetMacro(wetBrush(), "paper", 0.4);
		next.properties.granulation = { base: 1 };

		expect(readWetMacro(next, "paper")).toBeCloseTo(0.4, 6);
	});

	it("should keep every other setting as it was", () => {
		const before = wetBrush();

		const next = applyWetMacro(before, "bleed", 0.3);

		expect(next.properties.size).toEqual(before.properties.size);
		expect(next.mixing).toEqual(before.mixing);
		expect(next.randomSeed).toBe(before.randomSeed);
	});
});

function wetBrush(): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "wash",
		properties: { size: { base: 24 } },
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		wet: { enabled: true, bleedRadius: 0.5, pigmentLoad: 0.85, grainScale: 1 },
		randomSeed: 7,
	};
}

import { describe, expect, it } from "vitest";
import { formatLength, isLengthUnit, unitToWorld, worldToUnit } from "./units";

describe("units", () => {
	it("should treat px and pt as one world unit", () => {
		expect(unitToWorld(10, "px")).toBe(10);
		expect(unitToWorld(10, "pt")).toBe(10);
	});

	it("should map one inch to 72 world units", () => {
		expect(unitToWorld(1, "in")).toBe(72);
		expect(worldToUnit(144, "in")).toBe(2);
	});

	it("should map metric units through 25.4 mm per inch", () => {
		expect(unitToWorld(25.4, "mm")).toBeCloseTo(72);
		expect(unitToWorld(2.54, "cm")).toBeCloseTo(72);
	});

	it("should round-trip world values through every unit", () => {
		for (const unit of ["px", "pt", "mm", "cm", "in"] as const) {
			expect(unitToWorld(worldToUnit(595.28, unit), unit)).toBeCloseTo(595.28);
		}
	});

	it("should format an A4 width as 210.00 mm", () => {
		expect(formatLength(unitToWorld(210, "mm"), "mm")).toBe("210.00");
	});

	it("should reject unknown unit names", () => {
		expect(isLengthUnit("mm")).toBe(true);
		expect(isLengthUnit("em")).toBe(false);
		expect(isLengthUnit(undefined)).toBe(false);
	});
});

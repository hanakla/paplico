import { describe, expect, it } from "vitest";
import {
	DASH_PRESETS,
	dashArrayToPairs,
	matchDashPreset,
	materializeDashPreset,
	pairsToDashArray,
} from "./DashPatternControls";

describe("dashArrayToPairs", () => {
	it("should return empty array when dashArray is empty", () => {
		expect(dashArrayToPairs([])).toEqual([]);
	});

	it("should split an even-length array into dash/gap pairs", () => {
		expect(dashArrayToPairs([10, 5, 3, 5])).toEqual([
			{ dash: 10, gap: 5 },
			{ dash: 3, gap: 5 },
		]);
	});

	it("should double an odd-length array before pairing, per SVG spec", () => {
		expect(dashArrayToPairs([10, 5, 3])).toEqual([
			{ dash: 10, gap: 5 },
			{ dash: 3, gap: 10 },
			{ dash: 5, gap: 3 },
		]);
	});

	it("should pair a single-entry array with itself", () => {
		expect(dashArrayToPairs([4])).toEqual([{ dash: 4, gap: 4 }]);
	});
});

describe("pairsToDashArray", () => {
	it("should flatten pairs back into a dashArray", () => {
		expect(
			pairsToDashArray([
				{ dash: 10, gap: 5 },
				{ dash: 3, gap: 5 },
			]),
		).toEqual([10, 5, 3, 5]);
	});

	it("should round-trip an even-length dashArray unchanged", () => {
		const original = [10, 5, 3, 5];
		expect(pairsToDashArray(dashArrayToPairs(original))).toEqual(original);
	});
});

describe("materializeDashPreset", () => {
	it("should scale preset coefficients by stroke width", () => {
		expect(materializeDashPreset("dashed", 2)).toEqual([6, 4]);
	});

	it("should produce only positive dash entries for the dotted preset", () => {
		const result = materializeDashPreset("dotted", 0.5);
		expect(result.every((n) => n > 0)).toBe(true);
	});
});

describe("matchDashPreset", () => {
	it("should return solid for an empty dashArray", () => {
		expect(matchDashPreset([], 2)).toBe("solid");
	});

	it("should return null when stroke width is zero or negative", () => {
		expect(matchDashPreset([6, 4], 0)).toBeNull();
	});

	it("should match each preset materialized at the same width", () => {
		for (const preset of DASH_PRESETS) {
			const dashArray = materializeDashPreset(preset.id, 3);
			expect(matchDashPreset(dashArray, 3)).toBe(preset.id);
		}
	});

	it("should match within 5% relative tolerance", () => {
		expect(matchDashPreset([6.2, 4.1], 2)).toBe("dashed");
	});

	it("should not match outside the tolerance", () => {
		expect(matchDashPreset([8, 4], 2)).toBeNull();
	});

	it("should not match arrays of a different length", () => {
		expect(matchDashPreset([6, 4, 6, 4], 2)).toBeNull();
	});
});

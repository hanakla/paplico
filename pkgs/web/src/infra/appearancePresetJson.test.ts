import { describe, expect, it } from "vitest";
import {
	parseAppearancePresetJson,
	serializeAppearancePresetJson,
} from "./appearancePresetJson";

const preset = {
	uid: "ap-1",
	name: "Outline",
	filters: [
		{
			uid: "f-1",
			processor: "stroke",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: { version: "1", params: {} },
		},
	],
};

describe("appearancePresetJson", () => {
	it("should round-trip a preset through the JSON envelope", () => {
		const text = serializeAppearancePresetJson(preset);

		expect(JSON.parse(text).format).toBe("paplico-appearance-preset");
		expect(parseAppearancePresetJson(text)).toEqual(preset);
	});

	it("should backfill opacity and blendMode on filters that lack them", () => {
		const text = JSON.stringify({
			format: "paplico-appearance-preset",
			version: 1,
			preset: {
				uid: "ap-1",
				name: "Bare",
				filters: [
					{
						uid: "f-1",
						processor: "blur",
						paramData: { version: "1", params: {} },
					},
				],
			},
		});

		expect(parseAppearancePresetJson(text).filters[0]).toMatchObject({
			opacity: 1,
			blendMode: "normal",
		});
	});

	it("should reject text that is not JSON, a wrong format, a wrong version, or a bad shape", () => {
		expect(() => parseAppearancePresetJson("{nope")).toThrow(/not JSON/);
		expect(() =>
			parseAppearancePresetJson(JSON.stringify({ format: "x", version: 1 })),
		).toThrow(/unknown format/);
		expect(() =>
			parseAppearancePresetJson(
				JSON.stringify({ format: "paplico-appearance-preset", version: 2 }),
			),
		).toThrow(/Unsupported/);
		expect(() =>
			parseAppearancePresetJson(
				JSON.stringify({
					format: "paplico-appearance-preset",
					version: 1,
					preset: { uid: "a", name: "b", filters: [{ uid: "x" }] },
				}),
			),
		).toThrow(/shape/);
	});
});

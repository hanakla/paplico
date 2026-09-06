import { describe, expect, it } from "vitest";
import {
	createPersistedAppearancePreset,
	isPortableAppearancePreset,
	toDocumentAppearancePreset,
} from "./appearancePresets";

const preset = {
	uid: "ap-1",
	name: "Soft",
	filters: [
		{
			uid: "f-1",
			processor: "blur",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: { version: "1", params: { radius: 2 } },
		},
	],
};

describe("appearancePresets repo helpers", () => {
	it("should stamp timestamps and copy filters when persisting", () => {
		const persisted = createPersistedAppearancePreset(preset, 42);

		expect(persisted).toMatchObject({
			uid: "ap-1",
			createdAt: 42,
			updatedAt: 42,
		});
		expect(persisted.filters).toEqual(preset.filters);
		expect(persisted.filters[0]).not.toBe(preset.filters[0]);
	});

	it("should keep the library uid and copy filters when bringing a preset into a document", () => {
		const persisted = createPersistedAppearancePreset(preset, 42);

		const doc = toDocumentAppearancePreset(persisted);

		expect(doc.uid).toBe("ap-1");
		expect(doc).not.toHaveProperty("createdAt");
		expect(doc.filters).toEqual(preset.filters);
		expect(doc.filters[0]).not.toBe(persisted.filters[0]);
	});

	it("should refuse presets that point at document-local files or defs", () => {
		expect(isPortableAppearancePreset(preset)).toBe(true);
		expect(
			isPortableAppearancePreset({
				...preset,
				filters: [
					{
						...preset.filters[0]!,
						paramData: { version: "1", params: { fill: { defId: "def-1" } } },
					},
				],
			}),
		).toBe(false);
	});
});

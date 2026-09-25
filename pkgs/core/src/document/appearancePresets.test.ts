import { describe, expect, it } from "vitest";
import type { AppearancePreset, Filter, Path } from "../schema";
import {
	captureAppearancePreset,
	collectDocumentLocalRefs,
	createAppearancePresetsMap,
	dropDanglingPresetRefs,
	expandAppearancePresetRefs,
	localAppearances,
	mapLocalAppearances,
	resolveAppearanceEntries,
	resolveElementAppearance,
} from "./appearancePresets";

const fill: Filter = {
	uid: "f-fill",
	processor: "fill",
	opacity: 1,
	blendMode: "normal",
	paramData: { version: "1", params: { fill: { type: "solid", color: {} } } },
};
const blur: Filter = {
	uid: "f-blur",
	processor: "blur",
	opacity: 0.5,
	blendMode: "multiply",
	paramData: { version: "1", params: { radius: 4 } },
};
const preset: AppearancePreset = {
	uid: "ap-1",
	name: "Soft",
	filters: [fill, blur],
};
const presets = createAppearancePresetsMap({ appearancePresets: [preset] });

describe("resolveAppearanceEntries", () => {
	it("should expand a preset ref into its filters with prefixed uids", () => {
		const resolved = resolveAppearanceEntries(
			[{ type: "preset", uid: "ref-1", presetUid: "ap-1" }],
			presets,
		);

		expect(resolved.map((f) => f.uid)).toEqual([
			"ref-1:f-fill",
			"ref-1:f-blur",
		]);
		expect(resolved[1]?.opacity).toBe(0.5);
		expect(resolved[1]?.blendMode).toBe("multiply");
	});

	it("should keep concrete filters in place around refs", () => {
		const local: Filter = { ...fill, uid: "local" };
		const resolved = resolveAppearanceEntries(
			[local, { type: "preset", uid: "ref-1", presetUid: "ap-1" }, blur],
			presets,
		);

		expect(resolved.map((f) => f.uid)).toEqual([
			"local",
			"ref-1:f-fill",
			"ref-1:f-blur",
			"f-blur",
		]);
	});

	it("should expand a disabled ref to nothing", () => {
		const resolved = resolveAppearanceEntries(
			[{ type: "preset", uid: "ref-1", presetUid: "ap-1", enabled: false }],
			presets,
		);

		expect(resolved).toEqual([]);
	});

	it("should expand a dangling ref to nothing", () => {
		const resolved = resolveAppearanceEntries(
			[{ type: "preset", uid: "ref-1", presetUid: "missing" }],
			presets,
		);

		expect(resolved).toEqual([]);
	});

	it("should give distinct uids when the same preset is referenced twice", () => {
		const resolved = resolveAppearanceEntries(
			[
				{ type: "preset", uid: "ref-a", presetUid: "ap-1" },
				{ type: "preset", uid: "ref-b", presetUid: "ap-1" },
			],
			presets,
		);

		expect(new Set(resolved.map((f) => f.uid)).size).toBe(4);
	});

	it("should not share filter objects with the preset", () => {
		const resolved = resolveAppearanceEntries(
			[{ type: "preset", uid: "ref-1", presetUid: "ap-1" }],
			presets,
		);

		expect(resolved[0]).not.toBe(preset.filters[0]);
		expect(resolved[0]?.paramData).not.toBe(preset.filters[0]?.paramData);
	});
});

describe("resolveElementAppearance", () => {
	const makePath = (filters: Path["filters"]): Path => ({
		id: "p",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		segments: [],
		filters,
	});

	it("should return the same element when it has no refs", () => {
		const element = makePath([fill]);

		expect(resolveElementAppearance(element, presets)).toBe(element);
	});

	it("should return a copy with expanded filters when it has refs", () => {
		const element = makePath([
			{ type: "preset", uid: "ref-1", presetUid: "ap-1" },
		]);
		const resolved = resolveElementAppearance(element, presets);

		expect(resolved).not.toBe(element);
		expect(resolved.filters?.map((f) => f.uid)).toEqual([
			"ref-1:f-fill",
			"ref-1:f-blur",
		]);
		expect(element.filters).toHaveLength(1);
	});
});

describe("localAppearances", () => {
	it("should drop preset refs and keep concrete filters", () => {
		expect(
			localAppearances([
				fill,
				{ type: "preset", uid: "ref-1", presetUid: "ap-1" },
			]),
		).toEqual([fill]);
	});
});

describe("collectDocumentLocalRefs", () => {
	it("should report custom file uids and def ids but ignore builtin brush textures", () => {
		const refs = collectDocumentLocalRefs({
			uid: "ap-2",
			name: "Textured",
			filters: [
				{
					...fill,
					paramData: {
						version: "1",
						params: {
							fill: { type: "pattern", defId: "def-1" },
							brushSettings: {
								tipSource: { kind: "file", fileUid: "file-custom" },
								scatter: { fileUid: "builtin-brush-pencil" },
							},
						},
					},
				},
			],
		});

		expect(refs.defIds).toEqual(["def-1"]);
		expect(refs.fileUids).toEqual(["file-custom"]);
	});
});

describe("captureAppearancePreset", () => {
	const content: Filter = {
		uid: "c",
		processor: "content",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	};

	it("should capture resolved filters from refs and locals, keeping content in the stack", () => {
		const element = {
			id: "p",
			type: "path" as const,
			opacity: 1,
			blendMode: "normal" as const,
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			segments: [],
			filters: [
				{ type: "preset" as const, uid: "ref-1", presetUid: "ap-1" },
				content,
				blur,
			],
		};

		const captured = captureAppearancePreset(element, "New", presets, "ap-2")!;

		expect(captured.preset.filters.map((f) => f.processor)).toEqual([
			"fill",
			"blur",
			"blur",
		]);
		expect(captured.filters).toHaveLength(2);
		expect(captured.filters[0]).toMatchObject({
			type: "preset",
			presetUid: "ap-2",
		});
		expect(captured.filters[1]).toBe(content);
	});
});

describe("expandAppearancePresetRefs / dropDanglingPresetRefs", () => {
	it("should expand only refs to the given preset and carry a disabled flag", () => {
		const entries = [
			{ type: "preset" as const, uid: "a", presetUid: "ap-1", enabled: false },
			{ type: "preset" as const, uid: "b", presetUid: "other" },
		];

		const expanded = expandAppearancePresetRefs(entries, preset)!;

		expect(expanded).toHaveLength(3);
		expect(expanded[0]).toMatchObject({ processor: "fill", enabled: false });
		expect(expanded[2]).toBe(entries[1]);
	});

	it("should return undefined when nothing references the preset", () => {
		expect(expandAppearancePresetRefs([fill], preset)).toBeUndefined();
	});

	it("should drop refs whose preset is unknown and keep the rest", () => {
		const keep = { type: "preset" as const, uid: "a", presetUid: "ap-1" };
		const dropped = dropDanglingPresetRefs(
			[keep, { type: "preset" as const, uid: "b", presetUid: "gone" }, fill],
			presets,
		);

		expect(dropped).toEqual([keep, fill]);
		expect(dropDanglingPresetRefs([keep, fill], presets)).toBeUndefined();
	});
});

describe("mapLocalAppearances", () => {
	it("should transform concrete filters and keep refs at their positions", () => {
		const ref = { type: "preset" as const, uid: "a", presetUid: "ap-1" };

		const mapped = mapLocalAppearances([fill, ref, blur], (filters) =>
			filters.map((f) => ({ ...f, opacity: 0 })),
		);

		expect(mapped[1]).toBe(ref);
		expect(mapped.map((e) => ("type" in e ? "ref" : e.opacity))).toEqual([
			0,
			"ref",
			0,
		]);
	});
});
